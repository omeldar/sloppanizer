import {
  ACTIVE_STATUSES,
  type CreatePerson,
  type PeopleQuery,
  type Person,
  type PersonBrief,
  type PersonCounts,
  PERSON_LANGUAGES,
  type PersonLanguage,
  type PersonRef,
  sortLanguages,
  type UpdatePerson,
} from "@organizer/shared";
import { and, asc, eq, inArray, max, sql } from "drizzle-orm";
import { people, personTagLinks, personTopics, todoPeople, todos, topics } from "../db/schema.ts";
import { accounts } from "../db/auth-schema.ts";
import { ApiError, notFound } from "../http/errors.ts";
import { type Ctx, inTx, now, type Scoped } from "./context.ts";
import { insertOwnedRow, owned } from "./owned.ts";
import { resolvePersonTags, tagsByPerson } from "./person-tags.ts";
import { compareNames, foldCase, foldDiacritics } from "./text.ts";
import { indexPerson, removeFromIndex } from "./search-index.ts";
import { chunks, diffIds, type SetChange } from "./sql.ts";
import { deleteOrphanTopics, findOrCreateTopics, findTopics } from "./topics.ts";

export type PersonRow = typeof people.$inferSelect;

/** The person as todos carry it: no tags, topics or notes. */
export const toPersonBrief = (row: Omit<PersonRow, "accountId">): PersonBrief => ({
  id: row.id,
  firstName: row.firstName,
  lastName: row.lastName,
  displayName: `${row.firstName} ${row.lastName}`.trim(),
  note: row.note,
  team: row.team,
  email: row.email,
});

/** The stored language column ("de,en") as codes; codes this version does not know are left out. */
export function decodeLanguages(stored: string): PersonLanguage[] {
  const codes = stored.split(",");
  return PERSON_LANGUAGES.filter((code) => codes.includes(code));
}

/** Codes as stored: no repeats, the order of PERSON_LANGUAGES, comma-separated ("" = none). */
export const encodeLanguages = (languages: readonly PersonLanguage[]): string =>
  sortLanguages(languages).join(",");

const NO_COUNTS: PersonCounts = {
  requested: 0,
  requestedOpen: 0,
  requestedDone: 0,
  contact: 0,
  contactOpen: 0,
};

const activeList = sql.raw(ACTIVE_STATUSES.map((s) => `'${s}'`).join(","));

/** Todo counts per person id, both roles, in one grouped query per chunk. */
function countsByPerson(sc: Scoped, ids: readonly number[]): Map<number, PersonCounts> {
  const out = new Map<number, PersonCounts>();
  for (const part of chunks(ids)) {
    const rows = sc.db.all<{ personId: number } & PersonCounts>(sql`
      SELECT tp.person_id AS personId,
        sum(tp.role = 'requester') AS requested,
        sum(tp.role = 'requester' AND t.status IN (${activeList})) AS requestedOpen,
        sum(tp.role = 'requester' AND t.status = 'done') AS requestedDone,
        sum(tp.role = 'contact') AS contact,
        sum(tp.role = 'contact' AND t.status IN (${activeList})) AS contactOpen
      FROM ${todoPeople} tp JOIN ${todos} t ON t.account_id = tp.account_id AND t.id = tp.todo_id
      WHERE tp.account_id = ${sc.accountId} AND tp.person_id IN (${sql.join(
        part.map((id) => sql`${id}`),
        sql`, `,
      )})
      GROUP BY tp.person_id`);
    for (const { personId, ...counts } of rows) out.set(personId, counts);
  }
  return out;
}

/** Topic names per person id, by name. */
function topicsByPerson(sc: Scoped, ids: readonly number[]): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const part of chunks(ids)) {
    for (const { personId, name } of sc.db
      .select({ personId: personTopics.personId, name: topics.name })
      .from(personTopics)
      .innerJoin(
        topics,
        and(eq(topics.accountId, personTopics.accountId), eq(topics.id, personTopics.topicId)),
      )
      .where(owned(sc, personTopics, inArray(personTopics.personId, part)))
      .all()) {
      const list = out.get(personId) ?? [];
      list.push(name);
      out.set(personId, list);
    }
  }
  for (const list of out.values()) list.sort(compareNames);
  return out;
}

/** Full people (topics, tags, counts) for the given rows, in the same order. */
export function loadPeople(sc: Scoped, rows: readonly PersonRow[]): Person[] {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const topicMap = topicsByPerson(sc, ids);
  const tagMap = tagsByPerson(sc, ids);
  const countMap = countsByPerson(sc, ids);
  return rows.map((row) => ({
    ...toPersonBrief(row),
    notesMd: row.notesMd,
    username: row.username,
    languages: decodeLanguages(row.languages),
    topics: topicMap.get(row.id) ?? [],
    tags: tagMap.get(row.id) ?? [],
    counts: countMap.get(row.id) ?? NO_COUNTS,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

export const toPerson = (sc: Scoped, row: PersonRow): Person => loadPeople(sc, [row])[0] as Person;

export function getPerson(sc: Scoped, id: number): Person {
  return toPerson(sc, getPersonRow(sc, id));
}

/** People with exactly this first and last name, ignoring case (works for non-ASCII letters too). */
export function findNamesakes(sc: Scoped, firstName: string, lastName: string): PersonRow[] {
  const first = foldCase(firstName);
  const last = foldCase(lastName);
  return sc.db
    .select()
    .from(people)
    .where(owned(sc, people))
    .orderBy(asc(people.id))
    .all()
    .filter((row) => foldCase(row.firstName) === first && foldCase(row.lastName) === last);
}

const foldAll = (names: readonly string[]): string[] => names.map(foldCase);

export const byName = (
  a: Pick<Person, "id" | "firstName" | "lastName">,
  b: Pick<Person, "id" | "firstName" | "lastName">,
): number => compareNames(a.lastName, b.lastName) || compareNames(a.firstName, b.firstName) || a.id - b.id;

/** Newest todo link per person id. */
function lastLinkByPerson(sc: Scoped): Map<number, string> {
  return new Map(
    sc.db
      .select({ personId: todoPeople.personId, at: max(todoPeople.createdAt) })
      .from(todoPeople)
      .where(owned(sc, todoPeople))
      .groupBy(todoPeople.personId)
      .all()
      .map((r) => [r.personId, r.at ?? ""]),
  );
}

/** The person filters shared by the directory and the statistics: topic and tag (AND), team. */
export interface PersonFilters {
  topic?: readonly string[] | undefined;
  tag?: readonly string[] | undefined;
  team?: string | undefined;
}

export function filterPeople(list: readonly Person[], filters: PersonFilters): Person[] {
  let out = [...list];
  if (filters.topic) {
    const wanted = foldAll(filters.topic);
    out = out.filter((p) => wanted.every((t) => foldAll(p.topics).includes(t)));
  }
  if (filters.tag) {
    const wanted = foldAll(filters.tag);
    out = out.filter((p) => wanted.every((t) => foldAll(p.tags.map((tag) => tag.name)).includes(t)));
  }
  if (filters.team) {
    const team = foldCase(filters.team);
    out = out.filter((p) => foldCase(p.team) === team);
  }
  return out;
}

/**
 * People with topics, tags and counts. q matches names (both orders), note, team, email and topic
 * names without case or diacritics; topic and tag filters need every name (AND).
 */
export function listPeople(sc: Scoped, query: PeopleQuery): Person[] {
  let list = filterPeople(loadPeople(sc, sc.db.select().from(people).where(owned(sc, people)).all()), query);
  if (query.q) {
    const needle = foldDiacritics(query.q);
    list = list.filter((p) =>
      [
        `${p.firstName} ${p.lastName}`,
        `${p.lastName} ${p.firstName}`,
        p.note,
        p.team,
        p.email,
        ...p.topics,
      ].some((text) => foldDiacritics(text).includes(needle)),
    );
  }
  if (query.kind === "requester") list = list.filter((p) => p.counts.requested > 0);
  if (query.kind === "contact") list = list.filter((p) => p.counts.contact > 0 || p.topics.length > 0);
  switch (query.sort) {
    case "name":
      return list.toSorted(byName);
    case "requested":
      return list.toSorted((a, b) => b.counts.requested - a.counts.requested || byName(a, b));
    case "contact":
      return list.toSorted((a, b) => b.counts.contact - a.counts.contact || byName(a, b));
    case "recent": {
      const last = lastLinkByPerson(sc);
      return list.toSorted(
        (a, b) => (last.get(b.id) ?? "").localeCompare(last.get(a.id) ?? "") || byName(a, b),
      );
    }
  }
}

export function getPersonRow(sc: Scoped, id: number): PersonRow {
  const row = sc.db
    .select()
    .from(people)
    .where(owned(sc, people, eq(people.id, id)))
    .get();
  if (!row) throw notFound("Person", id);
  return row;
}

function insertPerson(sc: Scoped, at: string, firstName: string, lastName: string, note = ""): PersonRow {
  const id = insertOwnedRow(sc, people, {
    firstName: firstName.trim(),
    lastName: lastName.trim(),
    note,
    createdAt: at,
    updatedAt: at,
  });
  indexPerson(sc, id);
  return getPersonRow(sc, id);
}

interface LinkChanges {
  topics: SetChange<string>;
  tags: SetChange<string>;
}

const hasChange = (change: SetChange<string>): boolean =>
  change.set !== undefined || change.add !== undefined || change.remove !== undefined;

/** Applies topic and tag changes of one person; returns true when anything changed. */
function applyLinks(sc: Scoped, at: string, personId: number, change: LinkChanges): boolean {
  const tx = sc.db;
  let changed = false;
  if (hasChange(change.topics)) {
    const current = tx
      .select({ id: personTopics.topicId })
      .from(personTopics)
      .where(owned(sc, personTopics, eq(personTopics.personId, personId)))
      .all()
      .map((r) => r.id);
    const ids = (names: readonly string[] | undefined, create: boolean) =>
      names === undefined
        ? undefined
        : (create ? findOrCreateTopics(sc, at, names) : findTopics(sc, names)).map((t) => t.id);
    const { added, removed } = diffIds(current, {
      set: ids(change.topics.set, true),
      add: ids(change.topics.add, true),
      remove: ids(change.topics.remove, false),
    });
    if (removed.length > 0) {
      tx.delete(personTopics)
        .where(
          owned(
            sc,
            personTopics,
            eq(personTopics.personId, personId),
            inArray(personTopics.topicId, removed),
          ),
        )
        .run();
    }
    if (added.length > 0) {
      tx.insert(personTopics)
        .values(added.map((topicId) => ({ accountId: sc.accountId, personId, topicId, createdAt: at })))
        .run();
    }
    // Topics created for nothing (e.g. added and removed in one request) go too.
    deleteOrphanTopics(sc);
    changed ||= added.length > 0 || removed.length > 0;
  }
  if (hasChange(change.tags)) {
    const current = tx
      .select({ id: personTagLinks.tagId })
      .from(personTagLinks)
      .where(owned(sc, personTagLinks, eq(personTagLinks.personId, personId)))
      .all()
      .map((r) => r.id);
    const ids = (names: readonly string[] | undefined) =>
      names === undefined ? undefined : resolvePersonTags(sc, names).map((t) => t.id);
    const { added, removed } = diffIds(current, {
      set: ids(change.tags.set),
      add: ids(change.tags.add),
      remove: ids(change.tags.remove),
    });
    if (removed.length > 0) {
      tx.delete(personTagLinks)
        .where(
          owned(
            sc,
            personTagLinks,
            eq(personTagLinks.personId, personId),
            inArray(personTagLinks.tagId, removed),
          ),
        )
        .run();
    }
    if (added.length > 0) {
      tx.insert(personTagLinks)
        .values(added.map((tagId) => ({ accountId: sc.accountId, personId, tagId, createdAt: at })))
        .run();
    }
    changed ||= added.length > 0 || removed.length > 0;
  }
  return changed;
}

export function createPerson(ctx: Ctx, input: CreatePerson): Person {
  return ctx.db.transaction((tx) => {
    const sc = inTx(ctx, tx);
    if (!input.allowDuplicate) {
      const existing = findNamesakes(sc, input.firstName, input.lastName)[0];
      if (existing) {
        throw new ApiError(
          "conflict",
          `${existing.firstName} ${existing.lastName} already exists. Use that person, or send allowDuplicate: true with a note that tells them apart.`,
          { existing: toPerson(sc, existing) },
        );
      }
    }
    // Check tags before anything is written, so an unknown tag creates nothing.
    resolvePersonTags(sc, input.tags ?? []);
    const at = now(ctx);
    const id = insertOwnedRow(sc, people, {
      firstName: input.firstName,
      lastName: input.lastName,
      note: input.note ?? "",
      team: input.team ?? "",
      email: input.email ?? "",
      notesMd: input.notesMd ?? "",
      languages: encodeLanguages(input.languages ?? []),
      createdAt: at,
      updatedAt: at,
    });
    applyLinks(sc, at, id, { topics: { set: input.topics }, tags: { set: input.tags } });
    indexPerson(sc, id);
    return getPerson(sc, id);
  });
}

/** Changes a person. Person edits never touch todos (no events, no last activity). */
export function updatePerson(ctx: Ctx, id: number, input: UpdatePerson): Person {
  return ctx.db.transaction((tx) => {
    const sc = inTx(ctx, tx);
    const current = getPersonRow(sc, id);
    const at = now(ctx);
    const patch: Partial<PersonRow> = {};
    for (const key of ["firstName", "lastName", "note", "team", "email", "notesMd"] as const) {
      const value = input[key];
      if (value !== undefined && value !== current[key]) patch[key] = value;
    }
    if (input.languages !== undefined) {
      const languages = encodeLanguages(input.languages);
      if (languages !== current.languages) patch.languages = languages;
    }
    const linksChanged = applyLinks(sc, at, id, {
      topics: { set: input.topics, add: input.addTopics, remove: input.removeTopics },
      tags: { set: input.tags, add: input.addTags, remove: input.removeTags },
    });
    if (Object.keys(patch).length === 0 && !linksChanged) return toPerson(sc, current);
    const row = tx
      .update(people)
      .set({ ...patch, updatedAt: at })
      .where(owned(sc, people, eq(people.id, id)))
      .returning()
      .get() as PersonRow;
    indexPerson(sc, id);
    return toPerson(sc, row);
  });
}

/** Deletes a person; 409 with the number of todos while they are still linked in any role. */
export function deletePerson(ctx: Ctx, id: number): void {
  ctx.db.transaction((tx) => {
    const sc = inTx(ctx, tx);
    getPersonRow(sc, id);
    const { n } = tx.get<{ n: number }>(
      sql`SELECT count(DISTINCT ${todoPeople.todoId}) AS n FROM ${todoPeople}
        WHERE ${todoPeople.accountId} = ${sc.accountId} AND ${todoPeople.personId} = ${id}`,
    );
    if (n > 0) {
      throw new ApiError(
        "conflict",
        `This person is linked to ${n} todo${n === 1 ? "" : "s"}. Remove them from ${n === 1 ? "it" : "those todos"} first.`,
        { linkedTodos: n },
      );
    }
    tx.delete(people)
      .where(owned(sc, people, eq(people.id, id)))
      .run();
    deleteOrphanTopics(sc);
    removeFromIndex(sc, "person", id);
  });
}

/** Namesakes in a todo write: the short form only (the note tells them apart), never tags or notes. */
function ambiguous(rows: PersonRow[]): ApiError {
  const first = rows[0] as PersonRow;
  return new ApiError(
    "conflict",
    `ambiguous person, use personId: ${rows.length} people are named ${first.firstName} ${first.lastName}.`,
    { candidates: rows.map(toPersonBrief) },
  );
}

/**
 * The people for the given references. By id: must exist (422). By name: find-or-create on a
 * case-insensitive exact match; several namesakes give 409 "ambiguous person, use personId".
 */
export function resolvePeople(
  sc: Scoped,
  at: string,
  refs: readonly PersonRef[],
  create: boolean,
): PersonRow[] {
  const out: PersonRow[] = [];
  for (const ref of refs) {
    if ("personId" in ref) {
      const row = sc.db
        .select()
        .from(people)
        .where(owned(sc, people, eq(people.id, ref.personId)))
        .get();
      if (!row) {
        throw new ApiError(
          "validation_failed",
          `Person ${ref.personId} does not exist. Check the personId.`,
          {
            unknownPersonIds: [ref.personId],
          },
        );
      }
      out.push(row);
      continue;
    }
    if ("username" in ref) {
      out.push(personForUser(sc, at, ref.username));
      continue;
    }
    const matches = findNamesakes(sc, ref.firstName, ref.lastName);
    if (matches.length > 1) throw ambiguous(matches);
    const match = matches[0];
    if (match) out.push(match);
    else if (create) out.push(insertPerson(sc, at, ref.firstName, ref.lastName));
  }
  const seen = new Set<number>();
  return out.filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)));
}

/**
 * The person who is this Sloppanizer user: the one linked to them, else a namesake not linked to anyone
 * (it gets linked), else a new person named like the user ("First Last", or the username alone).
 */
function personForUser(sc: Scoped, at: string, username: string): PersonRow {
  const linked = sc.db
    .select()
    .from(people)
    .where(owned(sc, people, eq(people.username, username)))
    .get();
  if (linked) return linked;
  const user = sc.db
    .select()
    .from(accounts)
    .where(and(eq(accounts.username, username), eq(accounts.kind, "user"), eq(accounts.status, "active")))
    .get();
  if (!user) {
    throw new ApiError("validation_failed", `No user is called "${username}". Check the username.`, {
      unknownUsernames: [username],
    });
  }
  const named = user.firstName.trim() || user.lastName.trim();
  const firstName = named ? user.firstName.trim() : user.username;
  const lastName = named ? user.lastName.trim() : "";
  const namesake = findNamesakes(sc, firstName, lastName).find((row) => row.username === "");
  const id = namesake?.id ?? insertPerson(sc, at, firstName, lastName).id;
  sc.db
    .update(people)
    .set({ username, updatedAt: at })
    .where(owned(sc, people, eq(people.id, id)))
    .run();
  return getPersonRow(sc, id);
}
