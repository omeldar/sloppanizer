import { normalizeTopic, type Team, type Topic, type TopicQuery } from "@organizer/shared";
import { asc, count, eq, inArray, ne, sql } from "drizzle-orm";
import { people, personTopics, topics } from "../db/schema.ts";
import { ApiError, notFound } from "../http/errors.ts";
import { type Ctx, type Tx } from "./context.ts";
import { compareNames, foldCase } from "./text.ts";
import { reindexPeople } from "./search-index.ts";
import { escapeLike } from "./sql.ts";

export type TopicRow = typeof topics.$inferSelect;

function peopleCounts(db: Tx, ids: readonly number[]): Map<number, number> {
  if (ids.length === 0) return new Map();
  return new Map(
    db
      .select({ topicId: personTopics.topicId, n: count() })
      .from(personTopics)
      .where(inArray(personTopics.topicId, [...ids]))
      .groupBy(personTopics.topicId)
      .all()
      .map((r) => [r.topicId, r.n]),
  );
}

function toTopics(db: Tx, rows: readonly TopicRow[]): Topic[] {
  const counts = peopleCounts(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => ({ id: r.id, name: r.name, peopleCount: counts.get(r.id) ?? 0 }));
}

/** Topics by name; q matches any part of the name, without case (any script). */
export function listTopics(db: Tx, query: TopicQuery): Topic[] {
  const q = query.q ? foldCase(normalizeTopic(query.q)) : "";
  const rows = db
    .select()
    .from(topics)
    .where(q ? sql`${topics.nameKey} LIKE ${`%${escapeLike(q)}%`} ESCAPE '\\'` : undefined)
    .all()
    .toSorted((a, b) => compareNames(a.name, b.name))
    .slice(0, query.limit);
  return toTopics(db, rows);
}

const byKey = (name: string) => eq(topics.nameKey, foldCase(name));

/**
 * Topic rows for the names (already normalized), created when missing; names that differ only in case
 * are one topic. Same order, no duplicates.
 */
export function findOrCreateTopics(tx: Tx, at: string, names: readonly string[]): TopicRow[] {
  const out = new Map<number, TopicRow>();
  for (const name of names) {
    const row =
      tx.select().from(topics).where(byKey(name)).get() ??
      tx
        .insert(topics)
        .values({ name, nameKey: foldCase(name), createdAt: at })
        .returning()
        .get();
    out.set(row.id, row);
  }
  return [...out.values()];
}

/** Existing topic rows for the names; unknown names are skipped (removing them changes nothing). */
export function findTopics(tx: Tx, names: readonly string[]): TopicRow[] {
  return names.flatMap((name) => tx.select().from(topics).where(byKey(name)).all());
}

/** Deletes topics no one has any more (keeps the autocomplete clean). */
export function deleteOrphanTopics(tx: Tx): void {
  tx.run(
    sql`DELETE FROM ${topics} WHERE NOT EXISTS (SELECT 1 FROM ${personTopics} pt WHERE pt.topic_id = ${topics.id})`,
  );
}

function topicPeopleIds(tx: Tx, topicId: number): number[] {
  return tx
    .select({ id: personTopics.personId })
    .from(personTopics)
    .where(eq(personTopics.topicId, topicId))
    .all()
    .map((r) => r.id);
}

/** Renames a topic for everyone; another topic with that name is a 409 (no silent merge). */
export function renameTopic(ctx: Ctx, id: number, name: string): Topic {
  return ctx.db.transaction((tx) => {
    const current = tx.select().from(topics).where(eq(topics.id, id)).get();
    if (!current) throw notFound("Topic", id);
    const other = tx.select().from(topics).where(byKey(name)).get();
    if (other && other.id !== id) {
      throw new ApiError(
        "conflict",
        `A topic named "${other.name}" already exists. Pick another name, or remove this topic from its people.`,
        { existing: toTopics(tx, [other])[0] },
      );
    }
    const row = tx
      .update(topics)
      .set({ name, nameKey: foldCase(name) })
      .where(eq(topics.id, id))
      .returning()
      .get() as TopicRow;
    reindexPeople(tx, topicPeopleIds(tx, id));
    return toTopics(tx, [row])[0] as Topic;
  });
}

/** Deletes a topic; it disappears from everyone (cascade). */
export function deleteTopic(ctx: Ctx, id: number): void {
  ctx.db.transaction((tx) => {
    const ids = topicPeopleIds(tx, id);
    const result = tx.delete(topics).where(eq(topics.id, id)).run();
    if (result.changes === 0) throw notFound("Topic", id);
    reindexPeople(tx, ids);
  });
}

/** Distinct non-empty teams without case (any script); the first stored spelling (lowest person id) names them. */
export function listTeams(db: Tx): Team[] {
  const teams = new Map<string, Team>();
  for (const { team } of db
    .select({ team: people.team })
    .from(people)
    .where(ne(people.team, ""))
    .orderBy(asc(people.id))
    .all()) {
    const key = foldCase(team);
    const entry = teams.get(key);
    if (entry) entry.peopleCount += 1;
    else teams.set(key, { name: team, peopleCount: 1 });
  }
  return [...teams.values()].toSorted((a, b) => compareNames(a.name, b.name));
}
