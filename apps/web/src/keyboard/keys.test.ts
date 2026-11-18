import { describe, expect, it } from "vitest";
import { keyCaps, matchesChord, parseChord } from "./keys.ts";

const press = (key: string, mods: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...mods,
});

describe("shift chords", () => {
  it("matches the shifted letter the browser reports, not the plain one", () => {
    const chord = parseChord("shift+l");
    expect(matchesChord(chord, press("L"))).toBe(true);
    expect(matchesChord(chord, press("l"))).toBe(false);
  });

  it("keeps a plain letter binding off the shifted key", () => {
    expect(matchesChord(parseChord("l"), press("L"))).toBe(false);
  });

  it("ignores shift on keys that are not letters, where the browser already reports the result", () => {
    const chord = parseChord("shift+[");
    expect(chord.shift).toBe(false);
    expect(matchesChord(chord, press("["))).toBe(true);
  });

  it("shows Shift in the key caps", () => {
    expect(keyCaps("shift+h")).toEqual(["Shift", "H"]);
    expect(keyCaps("g b")).toEqual(["g", "b"]);
  });
});

describe("named keys", () => {
  it("shows Page Up and Page Down short, like the other named keys", () => {
    expect(keyCaps("PageUp")).toEqual(["PgUp"]);
    expect(keyCaps("PageDown")).toEqual(["PgDn"]);
    expect(keyCaps("Escape")).toEqual(["Esc"]);
  });

  it("matches the Page keys only without modifiers", () => {
    expect(matchesChord(parseChord("PageDown"), press("PageDown"))).toBe(true);
    expect(matchesChord(parseChord("PageDown"), press("PageDown", { ctrlKey: true }))).toBe(false);
  });
});
