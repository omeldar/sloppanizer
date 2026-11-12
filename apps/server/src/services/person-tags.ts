import {
  type CreatePersonTag,
  DEFAULT_PERSON_TAG_COLOR,
  type PersonTag,
  type UpdatePersonTag,
} from "@organizer/shared";
import { count, eq, inArray } from "drizzle-orm";
import { personTagLinks, personTags } from "../db/schema.ts";
import { ApiError, notFound } from "../http/errors.ts";
import { type Ctx, now, type Tx } from "./context.ts";
import { chunks } from "./sql.ts";

export type PersonTagRow = typeof personTags.$inferSelect;

export const toPersonTag = (row: PersonTagRow, peopleCount: number): PersonTag => ({
  id: row.id,
  name: row.name,
  color: row.color,
  description: row.description,
  peopleCount,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/** Number of people per tag id, for the given tags. */
export function tagPeopleCounts(db: Tx, tagIds: readonly number[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const part of chunks([...new Set(tagIds)])) {
    for (const { tagId, n } of db
      .select({ tagId: personTagLinks.tagId, n: count() })
      .from(personTagLinks)
      .where(inArray(personTagLinks.tagId, part))
      .groupBy(personTagLinks.tagId)
      .all()) {
      out.set(tagId, n);
    }
  }
  return out;
}

/** Tags per person id, by name. */
export function tagsByPerson(db: Tx, personIds: readonly number[]): Map<number, PersonTag[]> {
  const links: { personId: number; tag: PersonTagRow }[] = [];
  for (const part of chunks(personIds)) {
    links.push(
      ...db
        .select({ personId: personTagLinks.personId, tag: personTags })
        .from(personTagLinks)
        .innerJoin(personTags, eq(personTags.id, personTagLinks.tagId))
        .where(inArray(personTagLinks.personId, part))
        .all(),
    );
  }
  const counts = tagPeopleCounts(
    db,
    links.map((l) => l.tag.id),
  );
  const out = new Map<number, PersonTag[]>();
  for (const { personId, tag } of links) {
    const list = out.get(personId) ?? [];
    list.push(toPersonTag(tag, counts.get(tag.id) ?? 0));
    out.set(personId, list);
  }
  for (const list of out.values()) list.sort((a, b) => compareNames(a.name, b.name));
  return out;
}

/** Case-insensitive name order, stable for equal names. */
export function compareNames(a: string, b: string): number {
  const lower = a.toLowerCase().localeCompare(b.toLowerCase(), "en");
  return lower !== 0 ? lower : a.localeCompare(b, "en");
}

function withCount(db: Tx, row: PersonTagRow): PersonTag {
  return toPersonTag(row, tagPeopleCounts(db, [row.id]).get(row.id) ?? 0);
}

/** Every person tag with its number of people, by name. */
export function listPersonTags(db: Tx): PersonTag[] {
  const rows = db.select().from(personTags).all();
  const counts = tagPeopleCounts(
    db,
    rows.map((r) => r.id),
  );
  return rows
    .map((row) => toPersonTag(row, counts.get(row.id) ?? 0))
    .toSorted((a, b) => compareNames(a.name, b.name));
}

/** Tag rows for the names (case-insensitive), in the given order. Unknown names: 422 { unknownTags }. */
export function resolvePersonTags(db: Tx, names: readonly string[]): PersonTagRow[] {
  if (names.length === 0) return [];
  const byName = new Map(
    db
      .select()
      .from(personTags)
      .all()
      .map((row) => [row.name.toLowerCase(), row]),
  );
  const unknown = names.filter((name) => !byName.has(name.toLowerCase()));
  if (unknown.length > 0) {
    throw new ApiError(
      "validation_failed",
      `Unknown person tag${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. Create ${unknown.length > 1 ? "them" : "it"} first (POST /api/v1/person-tags).`,
      { unknownTags: unknown },
    );
  }
  return names.map((name) => byName.get(name.toLowerCase()) as PersonTagRow);
}

function assertNameFree(db: Tx, name: string, exceptId?: number): void {
  const existing = db.select().from(personTags).where(eq(personTags.name, name)).get();
  if (existing && existing.id !== exceptId) {
    throw new ApiError(
      "conflict",
      `A person tag named "${existing.name}" already exists. Pick another name.`,
      {
        existing: withCount(db, existing),
      },
    );
  }
}

export function createPersonTag(ctx: Ctx, input: CreatePersonTag): PersonTag {
  assertNameFree(ctx.db, input.name);
  const at = now(ctx);
  const row = ctx.db
    .insert(personTags)
    .values({
      name: input.name,
      color: input.color ?? DEFAULT_PERSON_TAG_COLOR,
      description: input.description ?? "",
      createdAt: at,
      updatedAt: at,
    })
    .returning()
    .get();
  return toPersonTag(row, 0);
}

export function updatePersonTag(ctx: Ctx, id: number, input: UpdatePersonTag): PersonTag {
  const current = ctx.db.select().from(personTags).where(eq(personTags.id, id)).get();
  if (!current) throw notFound("Person tag", id);
  if (input.name !== undefined) assertNameFree(ctx.db, input.name, id);
  const patch: Partial<PersonTagRow> = { updatedAt: now(ctx) };
  if (input.name !== undefined) patch.name = input.name;
  if (input.color !== undefined) patch.color = input.color;
  if (input.description !== undefined) patch.description = input.description;
  const row = ctx.db.update(personTags).set(patch).where(eq(personTags.id, id)).returning().get();
  return withCount(ctx.db, row as PersonTagRow);
}

/** Deletes a person tag; it disappears from everyone (cascade). */
export function deletePersonTag(ctx: Ctx, id: number): void {
  const result = ctx.db.delete(personTags).where(eq(personTags.id, id)).run();
  if (result.changes === 0) throw notFound("Person tag", id);
}
