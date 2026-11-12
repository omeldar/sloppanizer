import { describe, expect, it } from "vitest";
import { countChecklist, parseChecklist, resetChecklist, setChecklistItem } from "./checklist.ts";

const texts = (md: string) => parseChecklist(md).map((i) => `${i.checked ? "x" : " "} ${i.text}`);

describe("parseChecklist", () => {
  it("finds every marker style, numbered items and capital X", () => {
    const md = ["- [ ] Order cables", "* [x] Label ports", "+ [X] Test", "1. [ ] One", "2) [x] Two"].join(
      "\n",
    );
    expect(texts(md)).toEqual(["  Order cables", "x Label ports", "x Test", "  One", "x Two"]);
    expect(parseChecklist(md)[3]).toEqual({ index: 3, text: "One", checked: false, line: 3 });
  });

  it("accepts nested items at any indent and CRLF line ends", () => {
    const md = "- [ ] Parent\r\n  - [x] Child\r\n    - [ ] Grandchild\r\n\t- [ ] Tabbed\r\n";
    expect(texts(md)).toEqual(["  Parent", "x Child", "  Grandchild", "  Tabbed"]);
  });

  it("ignores fenced and indented code blocks and plain text", () => {
    const md = [
      "Intro - [ ] not an item",
      "````md",
      "- [ ] in a fence",
      "```",
      "- [ ] still fenced",
      "````",
      "- [ ] real one",
      "",
      "~~~",
      "- [x] tilde fence",
      "~~~",
      "",
      "    - [ ] indented code",
      "",
      "Paragraph",
      "- [x] real two",
      "-[ ] no space",
      "- [ ]no space after",
      "- [] empty",
      "> - [ ] quoted",
    ].join("\n");
    expect(texts(md)).toEqual(["  real one", "x real two"]);
  });

  it("keeps a deep nested item inside a list (not code) and returns empty text for bare boxes", () => {
    const md = "- [ ] a\n\n    - [x] deep\n- [ ]";
    expect(texts(md)).toEqual(["  a", "x deep", "  "]);
    expect(countChecklist(md)).toEqual({ total: 3, done: 1 });
    expect(countChecklist("no items")).toEqual({ total: 0, done: 0 });
  });
});

describe("setChecklistItem", () => {
  const md = "# Plan\r\n\n- [ ] Order cables\n  * [X] Label ports  \n```\n- [ ] code\n```\n1. [ ] Test\n";

  it("changes only the one bracket and keeps every other byte", () => {
    const checked = setChecklistItem(md, 0, true);
    expect(checked).toBe(md.replace("- [ ] Order", "- [x] Order"));
    const unchecked = setChecklistItem(md, 1, false);
    expect(unchecked).toBe(md.replace("[X] Label", "[ ] Label"));
    expect(setChecklistItem(md, 2, true)).toBe(md.replace("1. [ ] Test", "1. [x] Test"));
    expect(setChecklistItem(md, 2, true)).toContain("- [ ] code");
  });

  it("returns the same text when the item already has that state, and throws for unknown items", () => {
    expect(setChecklistItem(md, 1, true)).toBe(md);
    expect(setChecklistItem(md, 0, false)).toBe(md);
    expect(() => setChecklistItem(md, 3, true)).toThrow(RangeError);
  });
});

describe("resetChecklist", () => {
  it("unchecks every item and nothing else", () => {
    const md = "- [x] a\n- [ ] b\n  - [X] c\n```\n- [x] code\n```\n";
    expect(resetChecklist(md)).toBe("- [ ] a\n- [ ] b\n  - [ ] c\n```\n- [x] code\n```\n");
    expect(resetChecklist("plain")).toBe("plain");
  });
});
