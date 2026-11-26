import { describe, expect, it } from "vitest";
import { ActionNeededInput } from "./inputs.ts";
import { MarkNotifications, mentionedUsernames } from "./notifications.ts";

describe("notifications contract (S5#6)", () => {
  it("finds @usernames in a comment, not e-mail addresses", () => {
    expect(mentionedUsernames("@anna and **@Bo-2**, see anna@example.com. Thanks @cyra.")).toEqual([
      "anna",
      "bo-2",
      "cyra",
    ]);
    expect(mentionedUsernames("no one here")).toEqual([]);
  });

  it("marks some or all, not both or neither", () => {
    expect(MarkNotifications.parse({ ids: [1, 2] })).toEqual({ ids: [1, 2], read: true });
    expect(MarkNotifications.safeParse({ all: true, read: false }).success).toBe(true);
    expect(MarkNotifications.safeParse({}).success).toBe(false);
    expect(MarkNotifications.safeParse({ ids: [1], all: true }).success).toBe(false);
  });

  it("takes an action needed reason, an empty one or null", () => {
    expect(ActionNeededInput.parse("  Sign it ")).toBe("Sign it");
    expect(ActionNeededInput.parse("")).toBe("");
    expect(ActionNeededInput.parse(null)).toBeNull();
    expect(ActionNeededInput.safeParse("x".repeat(501)).success).toBe(false);
  });
});
