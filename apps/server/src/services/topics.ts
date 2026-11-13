import { normalizeTopic, type Team, type Topic, type TopicQuery } from "@organizer/shared";
import { asc, count, eq, inArray, ne, sql } from "drizzle-orm";
import { people, personTopics, topics } from "../db/schema.ts";
import { ApiError, notFound } from "../http/errors.ts";
import { type Ctx, inTx, type Scoped } from "./context.ts";
import { insertOwnedRow, owned } from "./owned.ts";
import { compareNames, foldCase } from "./text.ts";
import { reindexPeople } from "./search-index.ts";
import { escapeLike } from "./sql.ts";

export type TopicRow = typeof topics.$inferSelect;

function peopleCounts(sc: Scoped, ids: readonly number[]): Map<number, number> {
  if (ids.length === 0) return new Map();
  return new Map(
    sc.db
      .select({ topicId: personTopics.topicId, n: count() })
      .from(personTopics)
      .where(owned(sc, personTopics, inArray(personTopics.topicId, [...ids])))
      .groupBy(personTopics.topicId)
      .all()
      .map((r) => [r.topicId, r.n]),
  );
}

function toTopics(sc: Scoped, rows: readonly TopicRow[]): Topic[] {
  const counts = peopleCounts(
    sc,
    rows.map((r) => r.id),
  );
  return rows.map((r) => ({ id: r.id, name: r.name, peopleCount: counts.get(r.id) ?? 0 }));
}

/** Topics by name; q matches any part of the name, without case (any script). */
export function listTopics(sc: Scoped, query: TopicQuery): Topic[] {
  const q = query.q ? foldCase(normalizeTopic(query.q)) : "";
  const rows = sc.db
    .select()
    .from(topics)
    .where(owned(sc, topics, q ? sql`${topics.nameKey} LIKE ${`%${escapeLike(q)}%`} ESCAPE '\\'` : undefined))
    .all()
    .toSorted((a, b) => compareNames(a.name, b.name))
    .slice(0, query.limit);
  return toTopics(sc, rows);
}

const byKey = (sc: Scoped, name: string) => owned(sc, topics, eq(topics.nameKey, foldCase(name)));

const getTopicRow = (sc: Scoped, id: number): TopicRow | undefined =>
  sc.db
    .select()
    .from(topics)
    .where(owned(sc, topics, eq(topics.id, id)))
    .get();

/**
 * Topic rows for the names (already normalized), created when missing; names that differ only in case
 * are one topic. Same order, no duplicates.
 */
export function findOrCreateTopics(sc: Scoped, at: string, names: readonly string[]): TopicRow[] {
  const out = new Map<number, TopicRow>();
  for (const name of names) {
    const row =
      sc.db.select().from(topics).where(byKey(sc, name)).get() ??
      (getTopicRow(
        sc,
        insertOwnedRow(sc, topics, { name, nameKey: foldCase(name), createdAt: at }),
      ) as TopicRow);
    out.set(row.id, row);
  }
  return [...out.values()];
}

/** Existing topic rows for the names; unknown names are skipped (removing them changes nothing). */
export function findTopics(sc: Scoped, names: readonly string[]): TopicRow[] {
  return names.flatMap((name) => sc.db.select().from(topics).where(byKey(sc, name)).all());
}

/** Deletes topics no one has any more (keeps the autocomplete clean). */
export function deleteOrphanTopics(sc: Scoped): void {
  sc.db.run(
    sql`DELETE FROM ${topics} WHERE ${topics.accountId} = ${sc.accountId} AND NOT EXISTS (
      SELECT 1 FROM ${personTopics} pt WHERE pt.account_id = ${topics.accountId} AND pt.topic_id = ${topics.id})`,
  );
}

function topicPeopleIds(sc: Scoped, topicId: number): number[] {
  return sc.db
    .select({ id: personTopics.personId })
    .from(personTopics)
    .where(owned(sc, personTopics, eq(personTopics.topicId, topicId)))
    .all()
    .map((r) => r.id);
}

/** Renames a topic for everyone; another topic with that name is a 409 (no silent merge). */
export function renameTopic(ctx: Ctx, id: number, name: string): Topic {
  return ctx.db.transaction((tx) => {
    const sc = inTx(ctx, tx);
    const current = getTopicRow(sc, id);
    if (!current) throw notFound("Topic", id);
    const other = tx.select().from(topics).where(byKey(sc, name)).get();
    if (other && other.id !== id) {
      throw new ApiError(
        "conflict",
        `A topic named "${other.name}" already exists. Pick another name, or remove this topic from its people.`,
        { existing: toTopics(sc, [other])[0] },
      );
    }
    const row = tx
      .update(topics)
      .set({ name, nameKey: foldCase(name) })
      .where(owned(sc, topics, eq(topics.id, id)))
      .returning()
      .get() as TopicRow;
    reindexPeople(sc, topicPeopleIds(sc, id));
    return toTopics(sc, [row])[0] as Topic;
  });
}

/** Deletes a topic; it disappears from everyone (cascade). */
export function deleteTopic(ctx: Ctx, id: number): void {
  ctx.db.transaction((tx) => {
    const sc = inTx(ctx, tx);
    const ids = topicPeopleIds(sc, id);
    const result = tx
      .delete(topics)
      .where(owned(sc, topics, eq(topics.id, id)))
      .run();
    if (result.changes === 0) throw notFound("Topic", id);
    reindexPeople(sc, ids);
  });
}

/** Distinct non-empty teams without case (any script); the first stored spelling (lowest person id) names them. */
export function listTeams(sc: Scoped): Team[] {
  const teams = new Map<string, Team>();
  for (const { team } of sc.db
    .select({ team: people.team })
    .from(people)
    .where(owned(sc, people, ne(people.team, "")))
    .orderBy(asc(people.id))
    .all()) {
    const key = foldCase(team);
    const entry = teams.get(key);
    if (entry) entry.peopleCount += 1;
    else teams.set(key, { name: team, peopleCount: 1 });
  }
  return [...teams.values()].toSorted((a, b) => compareNames(a.name, b.name));
}
