import { describe, expect, it } from "vitest";
import {
  applyLabelChange,
  findScopeConflicts,
  labelNameProblem,
  parseLabelName,
  priorityOf,
  sortLabels,
} from "./labels.ts";

describe("parseLabelName", () => {
  it.each([
    ["homelab", null, "homelab"],
    ["priority::high", "priority", "high"],
    ["env::prod::eu", "env::prod", "eu"],
    ["a:b", null, "a:b"],
  ])("%s -> scope %s, value %s", (name, scope, value) => {
    expect(parseLabelName(name)).toEqual({ scope, value });
  });
});

describe("labelNameProblem", () => {
  it.each(["homelab", "priority::high", "env::prod::eu", "needs review"])("accepts %s", (name) => {
    expect(labelNameProblem(name)).toBeNull();
  });

  it.each(["", " padded", "::high", "priority::", "a:::b", "a::::b", "x,y", "x".repeat(101)])(
    "rejects %j with a message",
    (name) => {
      expect(labelNameProblem(name)).toEqual(expect.any(String));
    },
  );
});

describe("findScopeConflicts", () => {
  it("finds two labels of one scope, case-insensitively", () => {
    expect(findScopeConflicts(["priority::high", "Priority::low", "homelab"])).toEqual(["priority"]);
  });

  it("does not count the same label twice or plain labels", () => {
    expect(findScopeConflicts(["priority::high", "PRIORITY::HIGH", "a", "b"])).toEqual([]);
  });

  it("keeps nested scopes apart", () => {
    expect(findScopeConflicts(["env::prod::eu", "env::prod::us", "env::dev"])).toEqual(["env::prod"]);
  });
});

describe("applyLabelChange", () => {
  it("adding a scoped label replaces its sibling and keeps other labels", () => {
    expect(applyLabelChange(["priority::low", "homelab", "env::dev"], { add: ["priority::high"] })).toEqual([
      "homelab",
      "env::dev",
      "priority::high",
    ]);
  });

  it("does not touch labels of a nested or parent scope", () => {
    expect(applyLabelChange(["env::prod::eu", "env::dev"], { add: ["env::prod::us"] })).toEqual([
      "env::dev",
      "env::prod::us",
    ]);
  });

  it("matches existing names case-insensitively and does not duplicate", () => {
    expect(applyLabelChange(["Homelab"], { add: ["homelab"] })).toEqual(["homelab"]);
    expect(applyLabelChange(["homelab", "work"], { remove: ["HOMELAB"] })).toEqual(["work"]);
  });

  it("a full set replaces everything, then add and remove apply", () => {
    expect(
      applyLabelChange(["a", "b"], { set: ["c", "priority::low"], add: ["priority::high"], remove: ["c"] }),
    ).toEqual(["priority::high"]);
    expect(applyLabelChange(["a"], { set: [] })).toEqual([]);
  });

  it("keeps the current labels when nothing changes", () => {
    expect(applyLabelChange(["a", "A", "b"], {})).toEqual(["a", "b"]);
  });
});

const label = (name: string, rank: number | null = null) => ({ ...parseLabelName(name), name, rank });

describe("sortLabels", () => {
  it("puts scoped labels first by scope then rank, then plain labels by name", () => {
    const sorted = sortLabels([
      label("zebra"),
      label("priority::low", 3),
      label("Apple"),
      label("area::web"),
      label("priority::critical", 0),
      label("area::api"),
      label("priority::custom"),
    ]);
    expect(sorted.map((l) => l.name)).toEqual([
      "area::api",
      "area::web",
      "priority::critical",
      "priority::low",
      "priority::custom",
      "Apple",
      "zebra",
    ]);
  });

  it("does not change the input array", () => {
    const input = [label("b"), label("a")];
    sortLabels(input);
    expect(input.map((l) => l.name)).toEqual(["b", "a"]);
  });
});

describe("priorityOf", () => {
  it("reads the priority label", () => {
    expect(priorityOf([{ name: "homelab" }, { name: "priority::critical" }])).toBe("critical");
    expect(priorityOf([{ name: "homelab" }])).toBeNull();
    expect(priorityOf([{ name: "priority::someday" }])).toBeNull();
    expect(priorityOf([{ name: "x::priority::high" }])).toBeNull();
  });
});
