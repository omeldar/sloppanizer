import { describe, expect, it } from "vitest";
import { describeEvent } from "./activity.ts";
import type { ActivityEvent } from "./entities.ts";

const event = (kind: ActivityEvent["kind"], data: Record<string, unknown>): ActivityEvent => ({
  id: 1,
  todoId: 142,
  actor: "you",
  kind,
  data,
  createdAt: "2026-11-12T13:03:00.000Z",
});

const dates = (from: object, to: object) => describeEvent(event("dates_changed", { from, to }));

const anna = { id: 1, name: "Anna Meier" };
const max = { id: 2, name: "Max Muster" };
const bo = { id: 3, name: "Bo Li" };

describe("describeEvent", () => {
  it("describes creation, title and description edits", () => {
    expect(describeEvent(event("created", { to: { title: "x" } }))).toBe("created the todo");
    expect(describeEvent(event("title_changed", { from: "Old", to: "New" }))).toBe(
      'renamed from "Old" to "New"',
    );
    expect(describeEvent(event("description_changed", { fromChars: 3, toChars: 40 }))).toBe(
      "edited the description",
    );
  });

  it("names statuses the way people read them", () => {
    expect(describeEvent(event("status_changed", { from: "open", to: "done" }))).toBe(
      "changed status from Open to Done",
    );
    expect(describeEvent(event("status_changed", { from: "in_progress", to: "blocked" }))).toBe(
      "changed status from In progress to Blocked",
    );
  });

  it("lists added and removed labels, ignoring case", () => {
    expect(describeEvent(event("labels_changed", { from: [], to: ["priority::high"] }))).toBe(
      "added label priority::high",
    );
    expect(describeEvent(event("labels_changed", { from: ["a", "b", "c"], to: [] }))).toBe(
      "removed labels a, b and c",
    );
    expect(describeEvent(event("labels_changed", { from: ["Home", "x"], to: ["home", "y", "z"] }))).toBe(
      "added labels y and z and removed label x",
    );
  });

  it("says requester or contact, with old events defaulting to requester", () => {
    expect(describeEvent(event("people_changed", { role: "contact", from: [], to: [max] }))).toBe(
      "added contact Max Muster",
    );
    expect(describeEvent(event("people_changed", { role: "requester", from: [anna, max], to: [bo] }))).toBe(
      "added requester Bo Li and removed requesters Anna Meier and Max Muster",
    );
    expect(describeEvent(event("people_changed", { from: [anna], to: [] }))).toBe(
      "removed requester Anna Meier",
    );
  });

  it("prefers current names from the people map", () => {
    const renamed = new Map([[2, "Maximilian Muster"]]);
    expect(describeEvent(event("people_changed", { role: "contact", from: [], to: [max] }), renamed)).toBe(
      "added contact Maximilian Muster",
    );
  });

  it("describes project moves incl. the Inbox and deleted projects", () => {
    expect(describeEvent(event("project_changed", { from: null, to: { id: 4, name: "Homelab" } }))).toBe(
      "moved to project Homelab",
    );
    expect(describeEvent(event("project_changed", { from: { id: 4, name: "Homelab" }, to: null }))).toBe(
      "moved to the Inbox",
    );
    expect(describeEvent(event("project_changed", { from: null, to: { id: 9, name: null } }))).toBe(
      "moved to a project that was deleted",
    );
  });

  it("describes planned and due date changes", () => {
    expect(dates({ dueOn: null, plannedOn: null }, { dueOn: null, plannedOn: "2026-11-14" })).toBe(
      "planned for 2026-11-14",
    );
    expect(dates({ dueOn: null, plannedOn: "2026-11-14" }, { dueOn: null, plannedOn: null })).toBe(
      "removed the plan date",
    );
    expect(dates({ dueOn: null, plannedOn: null }, { dueOn: "2026-11-20", plannedOn: "2026-11-14" })).toBe(
      "planned for 2026-11-14 and set the due date to 2026-11-20",
    );
    expect(dates({ dueOn: "2026-11-20", plannedOn: null }, { dueOn: null, plannedOn: null })).toBe(
      "removed the due date",
    );
  });

  it("does not crash on malformed data", () => {
    expect(describeEvent(event("labels_changed", {}))).toBe("changed the labels");
    expect(describeEvent(event("people_changed", { role: "contact", from: "x", to: [{ id: "1" }] }))).toBe(
      "changed the contacts",
    );
    expect(describeEvent(event("dates_changed", {}))).toBe("changed the dates");
  });
});
