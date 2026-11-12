import { normalizeTopic, type Team, type Topic, type TopicQuery } from "@organizer/shared";
import { count, eq, inArray, sql } from "drizzle-orm";
import { people, personTopics, topics } from "../db/schema.ts";
import { ApiError, notFound } from "../http/errors.ts";
import { type Ctx, type Tx } from "./context.ts";
import { compareNames } from "./text.ts";
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

/** Topics by name; q matches any part of the name, without case. */
export function listTopics(db: Tx, query: TopicQuery): Topic[] {
  const q = query.q ? normalizeTopic(query.q) : "";
  const rows = db
    .select()
    .from(topics)
    .where(q ? sql`${topics.name} LIKE ${`%${escapeLike(q)}%`} ESCAPE '\\'` : undefined)
    .all()
    .toSorted((a, b) => compareNames(a.name, b.name))
    .slice(0, query.limit);
  return toTopics(db, rows);
}

/** Topic rows for the names (already normalized), created when missing. Same order, no duplicates. */
export function findOrCreateTopics(tx: Tx, at: string, names: readonly string[]): TopicRow[] {
  const out = new Map<number, TopicRow>();
  for (const name of names) {
    const row =
      tx.select().from(topics).where(eq(topics.name, name)).get() ??
      tx.insert(topics).values({ name, createdAt: at }).returning().get();
    out.set(row.id, row);
  }
  return [...out.values()];
}

/** Existing topic rows for the names; unknown names are skipped (removing them changes nothing). */
export function findTopics(tx: Tx, names: readonly string[]): TopicRow[] {
  return names.flatMap((name) => tx.select().from(topics).where(eq(topics.name, name)).all());
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
    const other = tx.select().from(topics).where(eq(topics.name, name)).get();
    if (other && other.id !== id) {
      throw new ApiError(
        "conflict",
        `A topic named "${other.name}" already exists. Pick another name, or remove this topic from its people.`,
        { existing: toTopics(tx, [other])[0] },
      );
    }
    const row = tx.update(topics).set({ name }).where(eq(topics.id, id)).returning().get() as TopicRow;
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

/** Distinct non-empty teams without case; the first stored spelling (lowest person id) names them. */
export function listTeams(db: Tx): Team[] {
  const rows = db.all<{ name: string; peopleCount: number }>(sql`
    SELECT (SELECT p2.team FROM ${people} p2 WHERE lower(p2.team) = lower(p.team) ORDER BY p2.id LIMIT 1) AS name,
      count(*) AS peopleCount
    FROM ${people} p WHERE p.team <> '' GROUP BY lower(p.team)`);
  return rows.toSorted((a, b) => compareNames(a.name, b.name));
}
