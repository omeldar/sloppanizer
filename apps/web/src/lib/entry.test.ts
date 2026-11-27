import { describe, expect, it } from "vitest";
import type { AccountStore } from "./accounts.ts";
import { resolveEntry } from "./entry.ts";

const anna = {
  accountId: 1,
  username: "anna",
  displayName: "Anna",
  color: "#8B95A5" as const,
  role: "user" as const,
  sessionId: "s",
  refreshToken: "r",
  addedAt: "2026-11-01T10:00:00.000Z",
  signedOut: false,
};
const store: AccountStore = { version: 1, lastUsed: "anna", accounts: [anna] };

describe("resolveEntry", () => {
  it("opens the phone's drawing page without an account, also when nobody is signed in", () => {
    expect(resolveEntry("/draw", "", store)).toEqual({ kind: "draw" });
    expect(resolveEntry("/draw/", "", { version: 1, lastUsed: null, accounts: [] })).toEqual({
      kind: "draw",
    });
    expect(resolveEntry("/drawing", "", store).kind).toBe("redirect");
  });

  it("opens the account's own data under /u/<username>", () => {
    expect(resolveEntry("/u/anna/board", "", store)).toEqual({
      kind: "app",
      account: anna,
      basepath: "/u/anna",
      spaceId: null,
    });
  });

  it("opens a shared project under /u/<username>/shared/<id>, with its own base path", () => {
    expect(resolveEntry("/u/anna/shared/7/projects/move", "", store)).toEqual({
      kind: "app",
      account: anna,
      basepath: "/u/anna/shared/7",
      spaceId: 7,
    });
    expect(resolveEntry("/u/anna/shared/7", "", store)).toEqual({
      kind: "redirect",
      to: "/u/anna/shared/7/",
    });
    // Not a number: an ordinary (unknown) page of the account.
    expect(resolveEntry("/u/anna/shared/x", "", store)).toMatchObject({ spaceId: null, basepath: "/u/anna" });
  });
});
