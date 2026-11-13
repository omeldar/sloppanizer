import {
  type CreatePersonTag,
  DEFAULT_PERSON_TAG_COLOR,
  type PersonTag,
  type UpdatePersonTag,
} from "@organizer/shared";
import { and, count, eq, inArray } from "drizzle-orm";
import { personTagLinks, personTags } from "../db/schema.ts";
import { ApiError, notFound } from "../http/errors.ts";
import { type Ctx, inTx, now, type Scoped } from "./context.ts";
import { insertOwnedRow, owned } from "./owned.ts";
import { chunks } from "./sql.ts";
import { compareNames, foldCase } from "./text.ts";

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
export function tagPeopleCounts(sc: Scoped, tagIds: readonly number[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const part of chunks([...new Set(tagIds)])) {
    for (const { tagId, n } of sc.db
      .select({ tagId: personTagLinks.tagId, n: count() })
      .from(personTagLinks)
      .where(owned(sc, personTagLinks, inArray(personTagLinks.tagId, part)))
      .groupBy(personTagLinks.tagId)
      .all()) {
      out.set(tagId, n);
    }
  }
  return out;
}

/** Tags per person id, by name. */
export function tagsByPerson(sc: Scoped, personIds: readonly number[]): Map<number, PersonTag[]> {
  const links: { personId: number; tag: PersonTagRow }[] = [];
  for (const part of chunks(personIds)) {
    links.push(
      ...sc.db
        .select({ personId: personTagLinks.personId, tag: personTags })
        .from(personTagLinks)
        .innerJoin(
          personTags,
          and(eq(personTags.accountId, personTagLinks.accountId), eq(personTags.id, personTagLinks.tagId)),
        )
        .where(owned(sc, personTagLinks, inArray(personTagLinks.personId, part)))
        .all(),
    );
  }
  const counts = tagPeopleCounts(
    sc,
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

function withCount(sc: Scoped, row: PersonTagRow): PersonTag {
  return toPersonTag(row, tagPeopleCounts(sc, [row.id]).get(row.id) ?? 0);
}

const getTagRow = (sc: Scoped, id: number): PersonTagRow | undefined =>
  sc.db
    .select()
    .from(personTags)
    .where(owned(sc, personTags, eq(personTags.id, id)))
    .get();

/** Every person tag with its number of people, by name. */
export function listPersonTags(sc: Scoped): PersonTag[] {
  const rows = sc.db.select().from(personTags).where(owned(sc, personTags)).all();
  const counts = tagPeopleCounts(
    sc,
    rows.map((r) => r.id),
  );
  return rows
    .map((row) => toPersonTag(row, counts.get(row.id) ?? 0))
    .toSorted((a, b) => compareNames(a.name, b.name));
}

/** Tag rows for the names (case-insensitive), in the given order. Unknown names: 422 { unknownTags }. */
export function resolvePersonTags(sc: Scoped, names: readonly string[]): PersonTagRow[] {
  if (names.length === 0) return [];
  const byName = new Map(
    sc.db
      .select()
      .from(personTags)
      .where(owned(sc, personTags))
      .all()
      .map((row) => [row.nameKey, row]),
  );
  const unknown = names.filter((name) => !byName.has(foldCase(name)));
  if (unknown.length > 0) {
    throw new ApiError(
      "validation_failed",
      `Unknown person tag${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. Create ${unknown.length > 1 ? "them" : "it"} first (POST /api/v1/person-tags).`,
      { unknownTags: unknown },
    );
  }
  return names.map((name) => byName.get(foldCase(name)) as PersonTagRow);
}

function assertNameFree(sc: Scoped, name: string, exceptId?: number): void {
  const existing = sc.db
    .select()
    .from(personTags)
    .where(owned(sc, personTags, eq(personTags.nameKey, foldCase(name))))
    .get();
  if (existing && existing.id !== exceptId) {
    throw new ApiError(
      "conflict",
      `A person tag named "${existing.name}" already exists. Pick another name.`,
      {
        existing: withCount(sc, existing),
      },
    );
  }
}

export function createPersonTag(ctx: Ctx, input: CreatePersonTag): PersonTag {
  assertNameFree(ctx, input.name);
  const at = now(ctx);
  const id = ctx.db.transaction((tx) =>
    insertOwnedRow(inTx(ctx, tx), personTags, {
      name: input.name,
      nameKey: foldCase(input.name),
      color: input.color ?? DEFAULT_PERSON_TAG_COLOR,
      description: input.description ?? "",
      createdAt: at,
      updatedAt: at,
    }),
  );
  return toPersonTag(getTagRow(ctx, id) as PersonTagRow, 0);
}

export function updatePersonTag(ctx: Ctx, id: number, input: UpdatePersonTag): PersonTag {
  const current = getTagRow(ctx, id);
  if (!current) throw notFound("Person tag", id);
  if (input.name !== undefined) assertNameFree(ctx, input.name, id);
  const patch: Partial<PersonTagRow> = { updatedAt: now(ctx) };
  if (input.name !== undefined) {
    patch.name = input.name;
    patch.nameKey = foldCase(input.name);
  }
  if (input.color !== undefined) patch.color = input.color;
  if (input.description !== undefined) patch.description = input.description;
  const row = ctx.db
    .update(personTags)
    .set(patch)
    .where(owned(ctx, personTags, eq(personTags.id, id)))
    .returning()
    .get();
  return withCount(ctx, row as PersonTagRow);
}

/** Deletes a person tag; it disappears from everyone (cascade). */
export function deletePersonTag(ctx: Ctx, id: number): void {
  const result = ctx.db
    .delete(personTags)
    .where(owned(ctx, personTags, eq(personTags.id, id)))
    .run();
  if (result.changes === 0) throw notFound("Person tag", id);
}
