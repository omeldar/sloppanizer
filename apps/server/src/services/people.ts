import {
  ACTIVE_STATUSES,
  type CreatePerson,
  type Person,
  type PersonBrief,
  type PersonCounts,
  type PersonRef,
  type UpdatePerson,
} from "@organizer/shared";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { people, personTopics, todoPeople, todos, topics } from "../db/schema.ts";
import { ApiError, notFound } from "../http/errors.ts";
import { type Ctx, now, type Tx } from "./context.ts";
import { compareNames, tagsByPerson } from "./person-tags.ts";
import { chunks } from "./sql.ts";

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

export function listPeople(db: Tx, q?: string): Person[] {
  const rows = db
    .select()
    .from(people)
    .orderBy(sql`lower(${people.lastName})`, sql`lower(${people.firstName})`, asc(people.id))
    .all();
  const needle = q ? fold(q) : "";
  return loadPeople(
    db,
    rows.filter(
      (row) =>
        needle === "" ||
        fold(`${row.firstName} ${row.lastName} ${row.note}`).includes(needle) ||
        fold(`${row.lastName} ${row.firstName}`).includes(needle),
    ),
  );
}

export function getPersonRow(db: Tx, id: number): PersonRow {
  const row = db.select().from(people).where(eq(people.id, id)).get();
  if (!row) throw notFound("Person", id);
  return row;
}

function insertPerson(db: Tx, at: string, firstName: string, lastName: string, note = ""): PersonRow {
  return db
    .insert(people)
    .values({ firstName: firstName.trim(), lastName: lastName.trim(), note, createdAt: at, updatedAt: at })
    .returning()
    .get();
}

export function createPerson(ctx: Ctx, input: CreatePerson): Person {
  if (!input.allowDuplicate) {
    const existing = findNamesakes(ctx.db, input.firstName, input.lastName)[0];
    if (existing) {
      throw new ApiError(
        "conflict",
        `${existing.firstName} ${existing.lastName} already exists. Use that person, or send allowDuplicate: true with a note that tells them apart.`,
        { existing: toPerson(ctx.db, existing) },
      );
    }
  }
  return toPerson(ctx.db, insertPerson(ctx.db, now(ctx), input.firstName, input.lastName, input.note ?? ""));
}

export function updatePerson(ctx: Ctx, id: number, input: UpdatePerson): Person {
  getPersonRow(ctx.db, id);
  const patch: Partial<PersonRow> = { updatedAt: now(ctx) };
  if (input.firstName !== undefined) patch.firstName = input.firstName;
  if (input.lastName !== undefined) patch.lastName = input.lastName;
  if (input.note !== undefined) patch.note = input.note;
  return toPerson(
    ctx.db,
    ctx.db.update(people).set(patch).where(eq(people.id, id)).returning().get() as PersonRow,
  );
}

/** Deletes a person; 409 with the number of todos while they are still linked. */
export function deletePerson(ctx: Ctx, id: number): void {
  getPersonRow(ctx.db, id);
  const { n } = ctx.db.get<{ n: number }>(
    sql`SELECT count(*) AS n FROM ${todoPeople} WHERE ${todoPeople.personId} = ${id}`,
  );
  if (n > 0) {
    throw new ApiError(
      "conflict",
      `This person is linked to ${n} todo${n === 1 ? "" : "s"}. Remove them from ${n === 1 ? "it" : "those todos"} first.`,
      { linkedTodos: n },
    );
  }
  ctx.db.delete(people).where(eq(people.id, id)).run();
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
