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
      "planned for 14.11.2026",
    );
    expect(dates({ dueOn: null, plannedOn: "2026-11-14" }, { dueOn: null, plannedOn: null })).toBe(
      "removed the plan date",
    );
    expect(dates({ dueOn: null, plannedOn: null }, { dueOn: "2026-11-20", plannedOn: "2026-11-14" })).toBe(
      "planned for 14.11.2026 and set the due date to 20.11.2026",
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

const ref = (id: number, title: string | null = "x") => ({ id, title });
const links = (kind: string, added: object[], removed: object[] = []) =>
  describeEvent(event("links_changed", { kind, added, removed }));

describe("describeEvent for step 3 kinds", () => {
  it("describes parent and subtask changes, also for deleted todos", () => {
    expect(describeEvent(event("parent_changed", { from: null, to: ref(42) }))).toBe(
      "made this a subtask of #42",
    );
    expect(describeEvent(event("parent_changed", { from: ref(42, null), to: null }))).toBe(
      "moved out of #42",
    );
    expect(describeEvent(event("parent_changed", { from: ref(41), to: ref(42) }))).toBe(
      "made this a subtask of #42",
    );
    expect(describeEvent(event("subtasks_changed", { added: [ref(43)], removed: [] }))).toBe(
      "added subtask #43",
    );
    expect(describeEvent(event("subtasks_changed", { added: [], removed: [ref(43, null)] }))).toBe(
      "removed subtask #43",
    );
    expect(describeEvent(event("subtasks_changed", { added: [ref(43), ref(44)], removed: [ref(45)] }))).toBe(
      "added subtasks #43 and #44 and removed subtask #45",
    );
  });

  it("describes links of each kind", () => {
    expect(links("blocks", [ref(12)])).toBe("linked: blocks #12");
    expect(links("blocked_by", [ref(12)])).toBe("linked: blocked by #12");
    expect(links("relates", [ref(9)])).toBe("linked: relates to #9");
    expect(links("blocks", [], [ref(12, null)])).toBe("removed link: blocks #12");
    expect(links("relates", [ref(9), ref(10)])).toBe("linked: relates to #9 and #10");
  });

  it("describes checklist clicks", () => {
    expect(describeEvent(event("checklist_changed", { text: "Order cables", checked: true }))).toBe(
      'checked "Order cables"',
    );
    expect(describeEvent(event("checklist_changed", { text: "Order cables", checked: false }))).toBe(
      'unchecked "Order cables"',
    );
  });

  it("describes repeat changes and the next occurrence", () => {
    const weekly = { every: "week", interval: 1, weekdays: ["mon"], basis: "schedule" };
    expect(describeEvent(event("recurrence_changed", { from: null, to: weekly }))).toBe(
      "set it to repeat every week on Mon",
    );
    expect(
      describeEvent(event("recurrence_changed", { from: weekly, to: { every: "week", interval: 2 } })),
    ).toBe("changed the repeat to every 2 weeks");
    expect(describeEvent(event("recurrence_changed", { from: weekly, to: null }))).toBe("stopped repeating");
    expect(
      describeEvent(
        event("recurred", { next: { id: 143, title: "x", dueOn: "2026-11-19", plannedOn: null } }),
      ),
    ).toBe("created the next one, #143, for 19.11.2026");
    expect(
      describeEvent(
        event("recurred", { next: { id: 143, title: null, dueOn: null, plannedOn: "2026-11-20" } }),
      ),
    ).toBe("created the next one, #143, for 20.11.2026");
  });
});
