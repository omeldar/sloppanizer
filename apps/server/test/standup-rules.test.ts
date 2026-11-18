import { describe, expect, it } from "vitest";
import { classify, mayBeItem, type RuleTodo } from "../src/services/standup-rules.ts";

const CUTOFF = "2026-11-05T08:00:00.000Z";
const BEFORE = "2026-11-01T10:00:00.000Z";
const AFTER = "2026-11-10T10:00:00.000Z";
const LATER = "2026-11-10T11:00:00.000Z";

const todo = (more: Partial<RuleTodo>): RuleTodo => ({
  status: "in_progress",
  doneAt: null,
  lastActivityAt: BEFORE,
  statusSince: null,
  ...more,
});

describe("standup rules", () => {
  it("never lists open todos, whatever happened to them", () => {
    const open = todo({ status: "open", lastActivityAt: AFTER });
    expect(classify(open, [{ createdAt: AFTER }], CUTOFF, false)).toBeNull();
    expect(mayBeItem(open, CUTOFF, false)).toBe(false);
  });

  it("lists done todos by their done time, not by later comments", () => {
    const done = todo({ status: "done", doneAt: AFTER, lastActivityAt: LATER });
    expect(classify(done, [{ createdAt: LATER }], CUTOFF, false)).toEqual({ kind: "done", at: AFTER });
    // Said after it was done: a later comment does not bring it back.
    expect(classify(done, [{ createdAt: LATER }], AFTER, true)).toBeNull();
    expect(mayBeItem(done, AFTER, true)).toBe(false);
    // Done before the window, with a comment in it: not news.
    const old = todo({ status: "done", doneAt: BEFORE, lastActivityAt: AFTER });
    expect(classify(old, [{ createdAt: AFTER }], CUTOFF, false)).toBeNull();
    expect(mayBeItem(old, CUTOFF, false)).toBe(false);
  });

  it("lists in-progress todos as started, updated, or started when never marked", () => {
    const working = todo({ lastActivityAt: LATER });
    expect(
      classify(working, [{ createdAt: AFTER, start: true }, { createdAt: LATER }], CUTOFF, false),
    ).toEqual({ kind: "started", at: LATER });
    expect(classify(working, [{ createdAt: LATER }], CUTOFF, true)).toEqual({ kind: "updated", at: LATER });
    // Never marked and quiet: always there, at the time it moved to in progress.
    const quiet = todo({ statusSince: BEFORE });
    expect(classify(quiet, [], CUTOFF, false)).toEqual({ kind: "started", at: BEFORE });
    expect(classify(todo({ statusSince: null }), [], CUTOFF, false)).toEqual({ kind: "started", at: BEFORE });
    // Marked and quiet since: gone.
    expect(classify(quiet, [], CUTOFF, true)).toBeNull();
    expect(mayBeItem(quiet, CUTOFF, true)).toBe(false);
  });

  it("counts only activity after the cutoff", () => {
    const working = todo({ lastActivityAt: AFTER });
    expect(classify(working, [{ createdAt: AFTER, start: true }], LATER, true)).toBeNull();
    expect(classify(working, [{ createdAt: BEFORE, start: true }], CUTOFF, true)).toBeNull();
  });

  it("lists blocked todos with news after the cutoff", () => {
    const blocked = todo({ status: "blocked", lastActivityAt: AFTER, statusSince: AFTER });
    expect(classify(blocked, [{ createdAt: AFTER }], CUTOFF, true)).toEqual({ kind: "blocked", at: AFTER });
    expect(classify(blocked, [], AFTER, true)).toBeNull();
  });
});
