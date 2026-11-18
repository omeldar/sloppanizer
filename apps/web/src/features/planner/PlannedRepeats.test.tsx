import type { BlockOccurrence, BlockSeries, RecurringTodo, Series } from "@organizer/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTodo, type RecordedCall } from "../../test/render.tsx";
import { renderAppAt } from "../../test/renderApp.tsx";

await import("./PlannerPage.tsx");
await import("../recurring/RecurringPage.tsx");

// Thursday 19.11.2026, 07:00 in Zurich.
const LAZY_PAGE = { timeout: 5000 };
const HOUR = 3_600_000;
const NOT_FOUND = { status: 404, body: { error: { code: "not_found", message: "Not here." } } };
const weekly = {
  every: "week" as const,
  interval: 1,
  weekdays: ["thu" as const],
  basis: "schedule" as const,
};

const segment: Series = {
  id: 4,
  rule: weekly,
  startsOn: "2026-11-12",
  endsOn: null,
  startTime: "10:00",
  durationMinutes: 60,
  text: "every week on Thu, 10:00–11:00",
};

/** Team report #12, planned Thursdays 10:00; last week's date belongs to #11, which is done. */
function occurrence(occursOn: string, overrides: Partial<BlockOccurrence> = {}): BlockOccurrence {
  return {
    seriesId: 4,
    ownerTodoId: 12,
    todo: { id: 12, title: "Team report", status: "open" },
    project: null,
    occursOn,
    startAt: `${occursOn}T09:00:00.000Z`,
    endAt: `${occursOn}T10:00:00.000Z`,
    status: "scheduled",
    ...overrides,
  };
}
const thisWeek = occurrence("2026-11-19");
const plan: BlockSeries = { todoId: 12, schedule: segment, segments: [segment], next: thisWeek };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-19T06:00:00.000Z"));
  Element.prototype.setPointerCapture ??= () => {};
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const reportTodo = makeTodo({ id: 12, title: "Team report", plannedOn: "2026-11-20", recurrence: weekly });

function renderPlanner(options: { repeats?: BlockOccurrence[]; hasPlan?: boolean } = {}) {
  const repeats = options.repeats ?? [thisWeek];
  return renderAppAt("/planner?day=2026-11-19", (call: RecordedCall) => {
    const path = call.path.split("?")[0];
    if (path === "/api/v1/blocks/series") return { body: repeats };
    if (path === "/api/v1/blocks") return call.method === "GET" ? { body: [] } : { status: 201, body: {} };
    if (path === "/api/v1/todos/12/plan") {
      if (call.method === "DELETE") return { status: 204 };
      if (call.method === "POST") return { status: 201, body: plan };
      return options.hasPlan === false ? NOT_FOUND : { body: plan };
    }
    if (path?.startsWith("/api/v1/todos/12/plan/")) return { body: plan };
    if (path === "/api/v1/todos/12") return { body: reportTodo };
    if (path === "/api/v1/todos") return { body: { items: [reportTodo], total: 1, limit: 200, offset: 0 } };
    if (path === "/api/v1/meetings/occurrences" || path === "/api/v1/meetings") return { body: [] };
    if (path === "/api/v1/next")
      return {
        body: { mode: "smart", today: "2026-11-19", generatedAt: thisWeek.startAt, items: [], blocked: [] },
      };
    return NOT_FOUND;
  });
}

const changes = (calls: RecordedCall[]) =>
  calls.filter((c) => c.method !== "GET").map((c) => [c.method, c.path, c.body]);

function dragDown(card: HTMLElement, dy: number) {
  const at = { pointerId: 1, pointerType: "mouse", button: 0, clientX: 100 };
  fireEvent.pointerDown(card, { ...at, clientY: 200 });
  fireEvent.pointerMove(card, { ...at, clientY: 200 + dy / 2 });
  fireEvent.pointerMove(card, { ...at, clientY: 200 + dy });
  fireEvent.pointerUp(card, { ...at, clientY: 200 + dy });
}

describe("planned time that repeats with a todo, in the planner", () => {
  it("shows each planned date marked as repeating, and a done date as done", async () => {
    renderPlanner({
      repeats: [
        occurrence("2026-11-16", { todo: { id: 11, title: "Team report", status: "done" } }),
        thisWeek,
      ],
    });
    const cards = await screen.findAllByTitle(/^Team report, .*, repeats$/, {}, LAZY_PAGE);
    expect(cards.map((c) => [c.dataset.repeats, c.dataset.done])).toEqual([
      ["true", "true"],
      ["true", undefined],
    ]);
  });

  it("asks which dates a dropped date is for, then moves this and following", async () => {
    const { calls } = renderPlanner();
    dragDown(await screen.findByTitle(/^Team report, /, {}, LAZY_PAGE), 52);
    const ask = await screen.findByRole("dialog", { name: "Move Team report" });
    fireEvent.click(within(ask).getByRole("radio", { name: /This and following/ }));
    fireEvent.click(within(ask).getByRole("button", { name: "Move" }));
    await waitFor(() =>
      expect(changes(calls)).toEqual([
        [
          "PATCH",
          "/api/v1/todos/12/plan/2026-11-19",
          {
            scope: "following",
            startAt: new Date(Date.parse(thisWeek.startAt) + HOUR).toISOString(),
            endAt: new Date(Date.parse(thisWeek.endAt) + HOUR).toISOString(),
          },
        ],
      ]),
    );
  });

  it("removes every date from its dialog, and one date with an Undo", async () => {
    const { calls } = renderPlanner();
    fireEvent.click(await screen.findByTitle(/^Team report, /, {}, LAZY_PAGE));
    const dialog = await screen.findByRole("dialog", { name: "Team report" });
    expect(await within(dialog).findByText(/every week on Thu, 10:00–11:00/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    let ask = await screen.findByRole("dialog", { name: /^Remove Team report on Thu 19\.11\./ });
    fireEvent.click(within(ask).getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(changes(calls)).toEqual([
        ["PATCH", "/api/v1/todos/12/plan/2026-11-19", { scope: "this", cancelled: true }],
      ]),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(changes(calls)[1]?.[2]).toEqual({ scope: "this", cancelled: false }));

    fireEvent.click(screen.getByTitle(/^Team report, /));
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "Team report" })).getByRole("button", {
        name: "Remove",
      }),
    );
    ask = await screen.findByRole("dialog", { name: /^Remove Team report/ });
    fireEvent.click(within(ask).getByRole("radio", { name: /All/ }));
    fireEvent.click(within(ask).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(changes(calls)[2]).toEqual(["DELETE", "/api/v1/todos/12/plan", undefined]));
  });

  it("plans time for a repeating todo on every date by default, or for one day when unticked", async () => {
    const { calls } = renderPlanner({ repeats: [], hasPlan: false });
    fireEvent.click(await screen.findByRole("button", { name: "Team report" }, LAZY_PAGE));
    let dialog = await screen.findByRole("dialog", { name: "Plan time" });
    const repeat = await within(dialog).findByRole("checkbox", {
      name: /Repeat with the todo \(every week on Thu\)/,
    });
    expect((repeat as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Plan" }));
    await waitFor(() => expect(changes(calls).map((c) => c[1])).toEqual(["/api/v1/todos/12/plan"]));

    fireEvent.click(await screen.findByRole("button", { name: "Team report" }));
    dialog = await screen.findByRole("dialog", { name: "Plan time" });
    fireEvent.click(await within(dialog).findByRole("checkbox", { name: /Repeat with the todo/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Plan" }));
    await waitFor(() =>
      expect(changes(calls).map((c) => c[1])).toEqual(["/api/v1/todos/12/plan", "/api/v1/blocks"]),
    );
  });
});

describe("the Recurring view", () => {
  const recurring: RecurringTodo[] = [
    {
      todo: reportTodo,
      text: "every week on Thu",
      nextOn: "2026-11-19",
      ended: false,
      doneCount: 3,
      lastDoneAt: "2026-11-12T15:00:00.000Z",
      plan,
    },
    {
      todo: makeTodo({ id: 4, title: "Course", status: "done" }),
      text: "every week until 01.11.2026",
      nextOn: null,
      ended: true,
      doneCount: 1,
      lastDoneAt: "2026-10-29T15:00:00.000Z",
      plan: null,
    },
  ];

  it("lists each repeat with its next date and planned time, and Done keeps it in the list", async () => {
    let list = recurring;
    const { calls } = renderAppAt("/recurring", (call: RecordedCall) => {
      const path = call.path.split("?")[0];
      if (path === "/api/v1/todos/recurring") return { body: list };
      if (path === "/api/v1/todos/12" && call.method === "PATCH") {
        list = [
          {
            ...recurring[0],
            todo: { ...reportTodo, id: 13 },
            nextOn: "2026-11-26",
            doneCount: 4,
          } as RecurringTodo,
          recurring[1] as RecurringTodo,
        ];
        return {
          body: {
            ...reportTodo,
            status: "done",
            nextOccurrence: { id: 13, title: "Team report", status: "open" },
          },
        };
      }
      return NOT_FOUND;
    });
    const repeating = await screen.findByRole("list", { name: "Repeating todos" }, LAZY_PAGE);
    const [card] = await within(repeating).findAllByRole("listitem");
    expect(card?.textContent).toContain("every week on Thu");
    expect(card?.textContent).toContain("Thu 19.11.");
    expect(card?.textContent).toContain("3×, last Thu 12.11.");
    expect(
      within(card as HTMLElement)
        .getByRole("link", { name: /next Thu 19\.11\., \d\d:00/ })
        .getAttribute("href"),
    ).toBe("/planner?day=2026-11-19");
    const ended = screen.getByRole("list", { name: "Ended repeats" });
    expect(within(ended).getByText("Course")).toBeTruthy();
    expect(within(ended).queryByRole("button", { name: "Done" })).toBeNull();

    fireEvent.click(within(card as HTMLElement).getByRole("button", { name: "Done" }));
    expect(await screen.findByText("Done. Team report comes back as #13.")).toBeTruthy();
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ status: "done" });
    await waitFor(() => expect(within(repeating).getByText("#13")).toBeTruthy());
  });
});
