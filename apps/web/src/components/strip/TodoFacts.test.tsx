import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeTodo, renderWithApp } from "../../test/render.tsx";
import { StripRow } from "./StripRow.tsx";
import { hasFacts, progressText } from "./TodoFacts.tsx";

const withProgress = (subtasks: [number, number], checklist: [number, number]) =>
  makeTodo({
    progress: {
      subtasks: { done: subtasks[0], total: subtasks[1] },
      checklist: { done: checklist[0], total: checklist[1] },
    },
  });

describe("strip facts", () => {
  it("adds subtasks and checklist items into one count with a spelled-out title", () => {
    expect(progressText(withProgress([2, 3], [0, 2]))).toEqual({
      text: "2/5",
      title: "2 of 3 subtasks, 0 of 2 checklist items done",
    });
    expect(progressText(withProgress([0, 0], [1, 4]))?.title).toBe("1 of 4 checklist items done");
    expect(progressText(withProgress([0, 0], [0, 0]))).toBeNull();
  });

  it("counts only open blockers of open todos as waiting", () => {
    const blockedBy = [{ id: 12, title: "Order switch", status: "done" as const }];
    expect(hasFacts(makeTodo({ links: { blocks: [], blockedBy, relatesTo: [] } }))).toBe(false);
    const open = [{ id: 12, title: "Order switch", status: "open" as const }];
    expect(hasFacts(makeTodo({ links: { blocks: [], blockedBy: open, relatesTo: [] } }))).toBe(true);
    expect(
      hasFacts(makeTodo({ status: "done", links: { blocks: [], blockedBy: open, relatesTo: [] } })),
    ).toBe(false);
  });

  it("shows progress, the repeat glyph and the waiting chip on a list strip, without a second waiting chip", async () => {
    const todo = makeTodo({
      progress: { subtasks: { done: 1, total: 2 }, checklist: { done: 0, total: 0 } },
      recurrence: { every: "week", interval: 1, basis: "schedule", weekdays: ["mon"] },
      links: { blocks: [], blockedBy: [{ id: 12, title: "Order switch", status: "open" }], relatesTo: [] },
    });
    renderWithApp(
      <ol>
        <StripRow
          todo={todo}
          onToggleDone={() => {}}
          reasons={[
            { kind: "waiting", label: "waiting on #12", points: 0 },
            { kind: "blocks", label: "blocks 2", points: 10 },
          ]}
        />
      </ol>,
    );
    expect(await screen.findByText("1/2")).toBeTruthy();
    expect(screen.getByTitle("Repeats every week on Mon")).toBeTruthy();
    expect(screen.getAllByText("waiting on #12")).toHaveLength(1);
    expect(screen.getByText("blocks 2")).toBeTruthy();
  });
});
