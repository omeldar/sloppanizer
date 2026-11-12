import { describe, expect, it } from "vitest";
import { highlightParts, hitTarget } from "./hits.tsx";

describe("highlightParts", () => {
  it("marks the matched ranges and keeps the text between them", () => {
    expect(highlightParts("Ask Max about firewall rules", [[14, 22]])).toEqual([
      { text: "Ask Max about ", hit: false },
      { text: "firewall", hit: true },
      { text: " rules", hit: false },
    ]);
  });

  it("merges overlapping ranges, sorts them and clamps them to the text", () => {
    const parts = highlightParts("abcdef", [
      [4, 99],
      [1, 3],
      [2, 4],
      [-5, 0],
    ]);
    expect(parts).toEqual([
      { text: "a", hit: false },
      { text: "bcdef", hit: true },
    ]);
    expect(parts.map((p) => p.text).join("")).toBe("abcdef");
  });

  it("returns the plain text without ranges", () => {
    expect(highlightParts("plain", [])).toEqual([{ text: "plain", hit: false }]);
  });
});

describe("hitTarget", () => {
  const base = { title: "", snippet: "", highlights: [], status: null, subtitle: null };
  it("opens a comment on its todo, scrolled to the comment", () => {
    expect(hitTarget({ ...base, kind: "comment", id: 9, todoId: 5 })).toEqual({
      to: "/todos/$id",
      params: { id: "5" },
      search: { comment: 9 },
    });
  });

  it("opens notes and people on their pages", () => {
    expect(hitTarget({ ...base, kind: "note", id: 3, todoId: null }).to).toBe("/notes/$id");
    expect(hitTarget({ ...base, kind: "person", id: 2, todoId: null }).params).toEqual({ id: "2" });
  });
});
