import {
  ACTIVE_STATUSES,
  type CreatePerson,
  type PeopleQuery,
  type Person,
  type PersonBrief,
  type PersonCounts,
  type PersonRef,
  type UpdatePerson,
} from "@organizer/shared";
import { and, asc, eq, inArray, max, sql } from "drizzle-orm";
import { people, personTagLinks, personTopics, todoPeople, todos, topics } from "../db/schema.ts";
import { ApiError, notFound } from "../http/errors.ts";
import { type Ctx, now, type Tx } from "./context.ts";
import { compareNames, resolvePersonTags, tagsByPerson } from "./person-tags.ts";
import { indexPerson, removeFromIndex } from "./search-index.ts";
import { chunks, diffIds, type SetChange } from "./sql.ts";
import { deleteOrphanTopics, findOrCreateTopics, findTopics } from "./topics.ts";

export type PersonRow = typeof people.$inferSelect;

/** The person as todos carry it: no tags, topics or notes. */
export const toPersonBrief = (row: PersonRow): PersonBrief => ({
  id: row.id,
  firstName: row.firstName,
  lastName: row.lastName,
  displayName: `${row.firstName} ${row.lastName}`,
  note: row.note,
  team: row.team,
  email: row.email,
});

const NO_COUNTS: PersonCounts = {
  requested: 0,
  requestedOpen: 0,
  requestedDone: 0,
  contact: 0,
  contactOpen: 0,
};

const activeList = sql.raw(ACTIVE_STATUSES.map((s) => `'${s}'`).join(","));

/** Todo counts per person id, both roles, in one grouped query per chunk. */
function countsByPerson(db: Tx, ids: readonly number[]): Map<number, PersonCounts> {
  const out = new Map<number, PersonCounts>();
  for (const part of chunks(ids)) {
    const rows = db.all<{ personId: number } & PersonCounts>(sql`
      SELECT tp.person_id AS personId,
        sum(tp.role = 'requester') AS requested,
        sum(tp.role = 'requester' AND t.status IN (${activeList})) AS requestedOpen,
        sum(tp.role = 'requester' AND t.status = 'done') AS requestedDone,
        sum(tp.role = 'contact') AS contact,
        sum(tp.role = 'contact' AND t.status IN (${activeList})) AS contactOpen
      FROM ${todoPeople} tp JOIN ${todos} t ON t.id = tp.todo_id
      WHERE tp.person_id IN (${sql.join(
        part.map((id) => sql`${id}`),
        sql`, `,
      )})
      GROUP BY tp.person_id`);
    for (const { personId, ...counts } of rows) out.set(personId, counts);
  }
  return out;
}

/** Topic names per person id, by name. */
function topicsByPerson(db: Tx, ids: readonly number[]): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const part of chunks(ids)) {
    for (const { personId, name } of db
      .select({ personId: personTopics.personId, name: topics.name })
      .from(personTopics)
      .innerJoin(topics, eq(topics.id, personTopics.topicId))
      .where(inArray(personTopics.personId, part))
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
export function loadPeople(db: Tx, rows: readonly PersonRow[]): Person[] {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const topicMap = topicsByPerson(db, ids);
  const tagMap = tagsByPerson(db, ids);
  const countMap = countsByPerson(db, ids);
  return rows.map((row) => ({
    ...toPersonBrief(row),
    notesMd: row.notesMd,
    topics: topicMap.get(row.id) ?? [],
    tags: tagMap.get(row.id) ?? [],
    counts: countMap.get(row.id) ?? NO_COUNTS,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

export const toPerson = (db: Tx, row: PersonRow): Person => loadPeople(db, [row])[0] as Person;

export function getPerson(db: Tx, id: number): Person {
  return toPerson(db, getPersonRow(db, id));
}

const fold = (text: string): string => text.trim().toLocaleLowerCase("en");

/** People with exactly this first and last name, ignoring case (works for non-ASCII letters too). */
export function findNamesakes(db: Tx, firstName: string, lastName: string): PersonRow[] {
  const first = fold(firstName);
  const last = fold(lastName);
  return db
    .select()
    .from(people)
    .orderBy(asc(people.id))
    .all()
    .filter((row) => fold(row.firstName) === first && fold(row.lastName) === last);
}

/** Lowercase without diacritics, so "muller" finds "Müller". */
const searchFold = (text: string): string =>
  text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("en");

const lowerAll = (names: readonly string[]): string[] => names.map((n) => n.toLowerCase());

export const byName = (
  a: Pick<Person, "id" | "firstName" | "lastName">,
  b: Pick<Person, "id" | "firstName" | "lastName">,
): number => compareNames(a.lastName, b.lastName) || compareNames(a.firstName, b.firstName) || a.id - b.id;

/** Newest todo link per person id. */
function lastLinkByPerson(db: Tx): Map<number, string> {
  return new Map(
    db
      .select({ personId: todoPeople.personId, at: max(todoPeople.createdAt) })
      .from(todoPeople)
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
    const wanted = lowerAll(filters.topic);
    out = out.filter((p) => wanted.every((t) => lowerAll(p.topics).includes(t)));
  }
  if (filters.tag) {
    const wanted = lowerAll(filters.tag);
    out = out.filter((p) => wanted.every((t) => lowerAll(p.tags.map((tag) => tag.name)).includes(t)));
  }
  if (filters.team) {
    const team = filters.team.toLowerCase();
    out = out.filter((p) => p.team.toLowerCase() === team);
  }
  return out;
}

/**
 * People with topics, tags and counts. q matches names (both orders), note, team, email and topic
 * names without case or diacritics; topic and tag filters need every name (AND).
 */
export function listPeople(db: Tx, query: PeopleQuery): Person[] {
  let list = filterPeople(loadPeople(db, db.select().from(people).all()), query);
  if (query.q) {
    const needle = searchFold(query.q);
    list = list.filter((p) =>
      [
        `${p.firstName} ${p.lastName}`,
        `${p.lastName} ${p.firstName}`,
        p.note,
        p.team,
        p.email,
        ...p.topics,
      ].some((text) => searchFold(text).includes(needle)),
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
      const last = lastLinkByPerson(db);
      return list.toSorted(
        (a, b) => (last.get(b.id) ?? "").localeCompare(last.get(a.id) ?? "") || byName(a, b),
      );
    }
  }
}

export function getPersonRow(db: Tx, id: number): PersonRow {
  const row = db.select().from(people).where(eq(people.id, id)).get();
  if (!row) throw notFound("Person", id);
  return row;
}

function insertPerson(db: Tx, at: string, firstName: string, lastName: string, note = ""): PersonRow {
  const row = db
    .insert(people)
    .values({ firstName: firstName.trim(), lastName: lastName.trim(), note, createdAt: at, updatedAt: at })
    .returning()
    .get();
  indexPerson(db, row.id);
  return row;
}

interface LinkChanges {
  topics: SetChange<string>;
  tags: SetChange<string>;
}

const hasChange = (change: SetChange<string>): boolean =>
  change.set !== undefined || change.add !== undefined || change.remove !== undefined;

/** Applies topic and tag changes of one person; returns true when anything changed. */
function applyLinks(tx: Tx, at: string, personId: number, change: LinkChanges): boolean {
  let changed = false;
  if (hasChange(change.topics)) {
    const current = tx
      .select({ id: personTopics.topicId })
      .from(personTopics)
      .where(eq(personTopics.personId, personId))
      .all()
      .map((r) => r.id);
    const ids = (names: readonly string[] | undefined, create: boolean) =>
      names === undefined
        ? undefined
        : (create ? findOrCreateTopics(tx, at, names) : findTopics(tx, names)).map((t) => t.id);
    const { added, removed } = diffIds(current, {
      set: ids(change.topics.set, true),
      add: ids(change.topics.add, true),
      remove: ids(change.topics.remove, false),
    });
    if (removed.length > 0) {
      tx.delete(personTopics)
        .where(and(eq(personTopics.personId, personId), inArray(personTopics.topicId, removed)))
        .run();
    }
    if (added.length > 0) {
      tx.insert(personTopics)
        .values(added.map((topicId) => ({ personId, topicId, createdAt: at })))
        .run();
    }
    // Topics created for nothing (e.g. added and removed in one request) go too.
    deleteOrphanTopics(tx);
    changed ||= added.length > 0 || removed.length > 0;
  }
  if (hasChange(change.tags)) {
    const current = tx
      .select({ id: personTagLinks.tagId })
      .from(personTagLinks)
      .where(eq(personTagLinks.personId, personId))
      .all()
      .map((r) => r.id);
    const ids = (names: readonly string[] | undefined) =>
      names === undefined ? undefined : resolvePersonTags(tx, names).map((t) => t.id);
    const { added, removed } = diffIds(current, {
      set: ids(change.tags.set),
      add: ids(change.tags.add),
      remove: ids(change.tags.remove),
    });
    if (removed.length > 0) {
      tx.delete(personTagLinks)
        .where(and(eq(personTagLinks.personId, personId), inArray(personTagLinks.tagId, removed)))
        .run();
    }
    if (added.length > 0) {
      tx.insert(personTagLinks)
        .values(added.map((tagId) => ({ personId, tagId, createdAt: at })))
        .run();
    }
    changed ||= added.length > 0 || removed.length > 0;
  }
  return changed;
}

export function createPerson(ctx: Ctx, input: CreatePerson): Person {
  return ctx.db.transaction((tx) => {
    if (!input.allowDuplicate) {
      const existing = findNamesakes(tx, input.firstName, input.lastName)[0];
      if (existing) {
        throw new ApiError(
          "conflict",
          `${existing.firstName} ${existing.lastName} already exists. Use that person, or send allowDuplicate: true with a note that tells them apart.`,
          { existing: toPerson(tx, existing) },
        );
      }
    }
    // Check tags before anything is written, so an unknown tag creates nothing.
    resolvePersonTags(tx, input.tags ?? []);
    const at = now(ctx);
    const row = tx
      .insert(people)
      .values({
        firstName: input.firstName,
        lastName: input.lastName,
        note: input.note ?? "",
        team: input.team ?? "",
        email: input.email ?? "",
        notesMd: input.notesMd ?? "",
        createdAt: at,
        updatedAt: at,
      })
      .returning()
      .get();
    applyLinks(tx, at, row.id, { topics: { set: input.topics }, tags: { set: input.tags } });
    indexPerson(tx, row.id);
    return toPerson(tx, row);
  });
}

/** Changes a person. Person edits never touch todos (no events, no last activity). */
export function updatePerson(ctx: Ctx, id: number, input: UpdatePerson): Person {
  return ctx.db.transaction((tx) => {
    const current = getPersonRow(tx, id);
    const at = now(ctx);
    const patch: Partial<PersonRow> = {};
    for (const key of ["firstName", "lastName", "note", "team", "email", "notesMd"] as const) {
      const value = input[key];
      if (value !== undefined && value !== current[key]) patch[key] = value;
    }
    const linksChanged = applyLinks(tx, at, id, {
      topics: { set: input.topics, add: input.addTopics, remove: input.removeTopics },
      tags: { set: input.tags, add: input.addTags, remove: input.removeTags },
    });
    if (Object.keys(patch).length === 0 && !linksChanged) return toPerson(tx, current);
    const row = tx
      .update(people)
      .set({ ...patch, updatedAt: at })
      .where(eq(people.id, id))
      .returning()
      .get() as PersonRow;
    indexPerson(tx, id);
    return toPerson(tx, row);
  });
}

/** Deletes a person; 409 with the number of todos while they are still linked in any role. */
export function deletePerson(ctx: Ctx, id: number): void {
  ctx.db.transaction((tx) => {
    getPersonRow(tx, id);
    const { n } = tx.get<{ n: number }>(
      sql`SELECT count(DISTINCT ${todoPeople.todoId}) AS n FROM ${todoPeople} WHERE ${todoPeople.personId} = ${id}`,
    );
    if (n > 0) {
      throw new ApiError(
        "conflict",
        `This person is linked to ${n} todo${n === 1 ? "" : "s"}. Remove them from ${n === 1 ? "it" : "those todos"} first.`,
        { linkedTodos: n },
      );
    }
    tx.delete(people).where(eq(people.id, id)).run();
    deleteOrphanTopics(tx);
    removeFromIndex(tx, "person", id);
  });
}

function ambiguous(db: Tx, rows: PersonRow[]): ApiError {
  const first = rows[0] as PersonRow;
  return new ApiError(
    "conflict",
    `ambiguous person, use personId: ${rows.length} people are named ${first.firstName} ${first.lastName}.`,
    { candidates: loadPeople(db, rows) },
  );
}

/**
 * The people for the given references. By id: must exist (422). By name: find-or-create on a
 * case-insensitive exact match; several namesakes give 409 "ambiguous person, use personId".
 */
export function resolvePeople(db: Tx, at: string, refs: readonly PersonRef[], create: boolean): PersonRow[] {
  const out: PersonRow[] = [];
  for (const ref of refs) {
    if ("personId" in ref) {
      const row = db.select().from(people).where(eq(people.id, ref.personId)).get();
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
    const matches = findNamesakes(db, ref.firstName, ref.lastName);
    if (matches.length > 1) throw ambiguous(db, matches);
    const match = matches[0];
    if (match) out.push(match);
    else if (create) out.push(insertPerson(db, at, ref.firstName, ref.lastName));
  }
  const seen = new Set<number>();
  return out.filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)));
}
