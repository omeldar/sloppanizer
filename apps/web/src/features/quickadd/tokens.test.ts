import { describe, expect, it } from "vitest";
import { TODO_TITLE_MAX } from "@organizer/shared";
import { fitTitle, parseQuickTitle } from "./tokens.ts";

const known = [{ name: "homelab" }, { name: "priority::high" }, { name: "priority::low" }];

describe("parseQuickTitle", () => {
  it("takes known ~labels out of the title in their stored spelling", () => {
    expect(parseQuickTitle("Renew certs ~HomeLab ~priority::high", known)).toEqual({
      title: "Renew certs",
      labels: ["homelab", "priority::high"],
      unknown: [],
    });
  });

  it("keeps unknown tokens in the title and reports them", () => {
    expect(parseQuickTitle("Buy ~cables now", known)).toEqual({
      title: "Buy ~cables now",
      labels: [],
      unknown: ["cables"],
    });
  });

  it("lets the later label of a scope win", () => {
    expect(parseQuickTitle("Task ~priority::high ~priority::low", known).labels).toEqual(["priority::low"]);
  });

  it("ignores a tilde inside a word", () => {
    expect(parseQuickTitle("approx~homelab", known)).toEqual({
      title: "approx~homelab",
      labels: [],
      unknown: [],
    });
  });
});

describe("fitTitle", () => {
  it("keeps a title that fits as it is", () => {
    expect(fitTitle("Renew certs")).toEqual({ title: "Renew certs", cutFrom: null });
    const full = "x".repeat(TODO_TITLE_MAX);
    expect(fitTitle(full)).toEqual({ title: full, cutFrom: null });
  });

  it("cuts a longer title to the limit and says how long it was", () => {
    const long = `${"word ".repeat(70)}end`;
    const fitted = fitTitle(long);
    expect(fitted.cutFrom).toBe(long.length);
    expect(fitted.title.length).toBeLessThanOrEqual(TODO_TITLE_MAX);
    expect(long.startsWith(fitted.title)).toBe(true);
    expect(fitted.title.endsWith(" ")).toBe(false);
  });

  it("never splits a character made of two code units", () => {
    const long = `${"a".repeat(TODO_TITLE_MAX - 1)}😀 more`;
    expect(fitTitle(long)).toEqual({ title: "a".repeat(TODO_TITLE_MAX - 1), cutFrom: long.length });
  });
});
