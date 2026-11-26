import { MAX_MEETING_PEOPLE, type PersonBrief, type PersonRef } from "@organizer/shared";
import { and, eq, inArray } from "drizzle-orm";
import { meetingPeople, people } from "../db/schema.ts";
import { ApiError } from "../http/errors.ts";
import type { Scoped } from "./context.ts";
import { owned } from "./owned.ts";
import { compareNames } from "./text.ts";
import { resolvePeople, toPersonBrief } from "./people.ts";
import { chunks } from "./sql.ts";

/**
 * People in a meeting (meeting_people): the same on every date of it. They come from the people
 * directory; a name that is not there yet is added to it, like a todo's requesters and contacts.
 */

/** The people of each meeting, by name. */
export function peopleOf(sc: Scoped, meetingIds: readonly number[]): Map<number, PersonBrief[]> {
  const out = new Map<number, PersonBrief[]>();
  for (const part of chunks([...new Set(meetingIds)])) {
    for (const row of sc.db
      .select({ meetingId: meetingPeople.meetingId, person: people })
      .from(meetingPeople)
      .innerJoin(
        people,
        and(eq(people.accountId, meetingPeople.accountId), eq(people.id, meetingPeople.personId)),
      )
      .where(owned(sc, meetingPeople, inArray(meetingPeople.meetingId, part)))
      .all()) {
      const list = out.get(row.meetingId) ?? [];
      list.push(toPersonBrief(row.person));
      out.set(row.meetingId, list);
    }
  }
  for (const list of out.values())
    list.sort((a, b) => compareNames(a.displayName, b.displayName) || a.id - b.id);
  return out;
}

const personIdsOf = (sc: Scoped, meetingId: number): number[] =>
  sc.db
    .select({ id: meetingPeople.personId })
    .from(meetingPeople)
    .where(owned(sc, meetingPeople, eq(meetingPeople.meetingId, meetingId)))
    .all()
    .map((r) => r.id);

/**
 * Changes a meeting's people: `set` replaces them all, `add` and `remove` change only those. Names are
 * found or created (never for remove). Returns whether anything changed.
 */
export function changeMeetingPeople(
  sc: Scoped,
  meetingId: number,
  change: { set?: readonly PersonRef[]; add?: readonly PersonRef[]; remove?: readonly PersonRef[] },
  at: string,
): boolean {
  const current = new Set(personIdsOf(sc, meetingId));
  const next = new Set(change.set ? resolvePeople(sc, at, change.set, true).map((p) => p.id) : current);
  for (const p of resolvePeople(sc, at, change.add ?? [], true)) next.add(p.id);
  for (const p of resolvePeople(sc, at, change.remove ?? [], false)) next.delete(p.id);
  if (next.size > MAX_MEETING_PEOPLE)
    throw new ApiError(
      "validation_failed",
      `A meeting can have at most ${MAX_MEETING_PEOPLE} people. Remove someone first.`,
    );
  const gone = [...current].filter((id) => !next.has(id));
  const added = [...next].filter((id) => !current.has(id));
  for (const part of chunks(gone)) {
    sc.db
      .delete(meetingPeople)
      .where(
        owned(
          sc,
          meetingPeople,
          eq(meetingPeople.meetingId, meetingId),
          inArray(meetingPeople.personId, part),
        ),
      )
      .run();
  }
  if (added.length > 0)
    sc.db
      .insert(meetingPeople)
      .values(added.map((personId) => ({ accountId: sc.accountId, meetingId, personId, addedAt: at })))
      .run();
  return gone.length > 0 || added.length > 0;
}
