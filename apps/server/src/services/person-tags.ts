import type { PersonTag } from "@organizer/shared";
import { count, eq, inArray } from "drizzle-orm";
import { personTagLinks, personTags } from "../db/schema.ts";
import type { Tx } from "./context.ts";
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
