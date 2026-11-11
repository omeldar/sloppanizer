import type { CreatePerson, Person, PersonRef, UpdatePerson } from "@organizer/shared";
import { asc, eq, sql } from "drizzle-orm";
import { people, todoPeople } from "../db/schema.ts";
import { ApiError, notFound } from "../http/errors.ts";
import { type Ctx, now, type Tx } from "./context.ts";

export type PersonRow = typeof people.$inferSelect;

export const toPerson = (row: PersonRow): Person => ({
  id: row.id,
  firstName: row.firstName,
  lastName: row.lastName,
  note: row.note,
  displayName: `${row.firstName} ${row.lastName}`,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

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
  return rows
    .filter(
      (row) =>
        needle === "" ||
        fold(`${row.firstName} ${row.lastName} ${row.note}`).includes(needle) ||
        fold(`${row.lastName} ${row.firstName}`).includes(needle),
    )
    .map(toPerson);
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
        { existing: toPerson(existing) },
      );
    }
  }
  return toPerson(insertPerson(ctx.db, now(ctx), input.firstName, input.lastName, input.note ?? ""));
}

export function updatePerson(ctx: Ctx, id: number, input: UpdatePerson): Person {
  getPersonRow(ctx.db, id);
  const patch: Partial<PersonRow> = { updatedAt: now(ctx) };
  if (input.firstName !== undefined) patch.firstName = input.firstName;
  if (input.lastName !== undefined) patch.lastName = input.lastName;
  if (input.note !== undefined) patch.note = input.note;
  return toPerson(ctx.db.update(people).set(patch).where(eq(people.id, id)).returning().get() as PersonRow);
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

function ambiguous(rows: PersonRow[]): ApiError {
  const first = rows[0] as PersonRow;
  return new ApiError(
    "conflict",
    `ambiguous person, use personId: ${rows.length} people are named ${first.firstName} ${first.lastName}.`,
    { candidates: rows.map(toPerson) },
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
    if (matches.length > 1) throw ambiguous(matches);
    const match = matches[0];
    if (match) out.push(match);
    else if (create) out.push(insertPerson(db, at, ref.firstName, ref.lastName));
  }
  const seen = new Set<number>();
  return out.filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)));
}
