import { describe, expect, it } from "vitest";
import { parseQuickTitle } from "./tokens.ts";

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
