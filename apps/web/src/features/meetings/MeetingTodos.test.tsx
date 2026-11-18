import type { Meeting, MeetingTodo, Todo, TodoMeeting } from "@organizer/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeItem, makeMeeting, makeMeetingTodo, makeStandup } from "../../test/meetings.ts";
import { makeMe, makeTodo, type RecordedCall } from "../../test/render.tsx";
import { renderAppAt } from "../../test/renderApp.tsx";

await import("./MeetingPage.tsx");
await import("../todos/TodoPage.tsx");

const LAZY_PAGE = { timeout: 5000 };
const NOT_FOUND = { status: 404, body: { error: { code: "not_found", message: "Not here." } } };
// cmdk scrolls the picked option into view; jsdom has no layout.
Element.prototype.scrollIntoView ??= () => {};

beforeEach(() => {
  // Thursday 19.11.2026, 10:00 UTC: after this week's standup, so the next date is Thu 26.11.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-19T10:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const NEXT = "2026-11-26";

/** Meeting 7 with the todos added by hand kept by the fake server; todo #14 can be found by id. */
function renderMeeting(start: MeetingTodo[], meeting: Meeting = makeMeeting({ type: "other" })) {
  let items = [...start];
  const found = makeTodo({ id: 14, title: "Hiring plan", dueOn: "2026-12-24" });
  return renderAppAt("/meetings/7?on=2026-11-19", (call: RecordedCall) => {
    const url = call.path.split("?")[0] ?? "";
    if (url === "/api/v1/meetings/7") return { body: meeting };
    if (url === "/api/v1/meetings/7/todos" && call.method === "GET")
      return { body: { meetingId: 7, nextOn: meeting.next ? NEXT : null, items } };
    if (url === "/api/v1/meetings/7/todos" && call.method === "POST") {
      const { todoId } = call.body as { todoId: number };
      const item = makeMeetingTodo(todoId, todoId === 14 ? "Hiring plan" : `Todo ${todoId}`);
      items = [...items, item];
      return { status: 201, body: item };
    }
    const due = /^\/api\/v1\/meetings\/7\/todos\/(\d+)\/due$/.exec(url);
    if (due && call.method === "POST") {
      const id = Number(due[1]);
      items = items.map((i) => (i.todo.id === id ? { ...i, dueOn: NEXT } : i));
      return { body: makeTodo({ id, dueOn: NEXT }) };
    }
    const one = /^\/api\/v1\/meetings\/7\/todos\/(\d+)$/.exec(url);
    if (one && call.method === "DELETE") {
      items = items.filter((i) => i.todo.id !== Number(one[1]));
      return { status: 204 };
    }
    if (url === "/api/v1/todos/14") return { body: found };
    if (url === "/api/v1/meetings/7/standup")
      return { body: makeStandup([makeItem("blocked", 20, "Waiting for parts")]) };
    if (url === "/api/v1/meetings/occurrences" || url.endsWith("/notes")) return { body: [] };
    if (url === "/api/v1/projects" || url === "/api/v1/labels") return { body: [] };
    return NOT_FOUND;
  });
}

const section = () => screen.findByRole("region", { name: /Todos on this meeting/ }, LAZY_PAGE);

describe("todos on the meeting page", () => {
  it("lists the todos added by hand and sets the next date as due date only on the button", async () => {
    const { calls } = renderMeeting([
      makeMeetingTodo(12, "Budget", {
        project: { id: 1, slug: "lab", name: "Lab", color: "#4c9aff" },
      }),
      makeMeetingTodo(13, "Cables", { dueOn: NEXT, parent: { id: 3, title: "Rack", status: "open" } }),
    ]);
    const added = await section();
    const rows = await within(added).findAllByRole("listitem");
    expect(rows.map((r) => within(r).getByRole("link").textContent)).toEqual([
      expect.stringContaining("Budget"),
      expect.stringContaining("Cables"),
    ]);
    expect(rows[0]?.textContent).toContain("Lab");
    expect(rows[1]?.textContent).toContain("in Rack");
    expect(
      within(rows[0] as HTMLElement)
        .getByRole("link")
        .getAttribute("href"),
    ).toBe("/todos/12");
    // Already due at the next date: no button, the row says so.
    expect(rows[1]?.textContent).toContain("Due at next meeting");
    expect(within(rows[1] as HTMLElement).queryByRole("button", { name: /Due at next meeting/ })).toBeNull();
    // Nothing changed a due date by itself.
    expect(calls.some((c) => c.path.endsWith("/due"))).toBe(false);

    fireEvent.click(
      within(rows[0] as HTMLElement).getByRole("button", { name: "Due at next meeting (Thu 26.11.)" }),
    );
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual([
        "/api/v1/meetings/7/todos/12/due",
      ]),
    );
    await waitFor(() =>
      expect(within(added).queryByRole("button", { name: /Due at next meeting/ })).toBeNull(),
    );
  });

  it("removes a todo from the meeting, and Undo puts it back", async () => {
    const { calls } = renderMeeting([makeMeetingTodo(12, "Budget")]);
    const added = await section();
    fireEvent.click(await within(added).findByRole("button", { name: 'Remove "Budget" from this meeting' }));
    await waitFor(() => expect(within(added).queryByRole("listitem")).toBeNull());
    expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/v1/meetings/7/todos/12")).toBe(true);
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(within(added).getAllByRole("listitem")).toHaveLength(1));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ todoId: 12 });
  });

  it("adds a todo found by its #id and leaves its due date alone", async () => {
    const { calls } = renderMeeting([]);
    const added = await section();
    expect(await within(added).findByText(/They stay here on every date until you remove them/)).toBeTruthy();
    fireEvent.click(within(added).getByRole("button", { name: "Add a todo" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a todo to Team standup" });
    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: "#14" } });
    fireEvent.click(await within(dialog).findByRole("option", { name: /Hiring plan/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.filter((c) => c.method !== "GET").map((c) => [c.method, c.path, c.body])).toEqual([
      ["POST", "/api/v1/meetings/7/todos", { todoId: 14 }],
    ]);
    expect(await within(added).findByRole("link", { name: /Hiring plan/ })).toBeTruthy();
  });

  it("shows no due button when the meeting has no next date", async () => {
    renderMeeting([makeMeetingTodo(12, "Budget")], makeMeeting({ type: "other", next: null }));
    const added = await section();
    expect(await within(added).findAllByRole("listitem")).toHaveLength(1);
    expect(within(added).queryByRole("button", { name: /Due at next meeting/ })).toBeNull();
  });

  it("keeps them as their own group on a standup, apart from the worked-out list", async () => {
    renderMeeting([makeMeetingTodo(12, "Budget")], makeMeeting());
    const added = await section();
    const toSay = await screen.findByRole("region", { name: "To say" });
    expect(await within(toSay).findByText("Waiting for parts")).toBeTruthy();
    expect(await within(added).findByText("Budget")).toBeTruthy();
    expect(within(toSay).queryByText("Budget")).toBeNull();
    expect(within(added).queryByText("Waiting for parts")).toBeNull();
  });
});

describe("meetings on the todo page", () => {
  function renderTodo(start: TodoMeeting[]) {
    let on = [...start];
    const todo: Todo = makeTodo({ id: 1, title: "Budget" });
    const meetings = [makeMeeting(), makeMeeting({ id: 8, name: "Review", type: "other" })];
    return renderAppAt("/todos/1", (call: RecordedCall) => {
      const url = call.path.split("?")[0] ?? "";
      if (url === "/api/v1/todos/1") return { body: todo };
      if (url === "/api/v1/todos/1/activity") return { body: { todoId: 1, items: [] } };
      if (url === "/api/v1/todos/1/meetings") return { body: on };
      if (url === "/api/v1/meetings") return { body: meetings };
      const add = /^\/api\/v1\/meetings\/(\d+)\/todos$/.exec(url);
      if (add && call.method === "POST") {
        const meeting = meetings.find((m) => m.id === Number(add[1])) as Meeting;
        on = [
          ...on,
          {
            meeting: { id: meeting.id, name: meeting.name, type: meeting.type },
            nextOn: NEXT,
            addedAt: "2026-11-19T10:00:00.000Z",
          },
        ];
        return { status: 201, body: makeMeetingTodo(1, "Budget") };
      }
      if (url.endsWith("/todos/1/due")) return { body: makeTodo({ id: 1, dueOn: NEXT }) };
      if (/^\/api\/v1\/meetings\/\d+\/todos\/1$/.test(url) && call.method === "DELETE") {
        on = on.filter((m) => !url.includes(`/meetings/${m.meeting.id}/`));
        return { status: 204 };
      }
      if (url === "/api/v1/me") return { body: makeMe() };
      if (url === "/api/v1/projects" || url === "/api/v1/labels") return { body: [] };
      return NOT_FOUND;
    });
  }

  const standupEntry: TodoMeeting = {
    meeting: { id: 7, name: "Team standup", type: "standup" },
    nextOn: NEXT,
    addedAt: "2026-11-12T10:00:00.000Z",
  };

  it("shows the meetings it is on, sets the due date and removes it", async () => {
    const { calls } = renderTodo([standupEntry]);
    const meetings = await screen.findByRole("region", { name: "Meetings" }, LAZY_PAGE);
    const link = await within(meetings).findByRole("link", { name: /Team standup/ });
    expect(link.getAttribute("href")).toBe("/meetings/7");
    expect(link.textContent).toContain("Standup, next Thu 26.11.");
    fireEvent.click(within(meetings).getByRole("button", { name: "Due at next meeting (Thu 26.11.)" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/meetings/7/todos/1/due")).toBe(
        true,
      ),
    );
    fireEvent.click(within(meetings).getByRole("button", { name: "Remove from Team standup" }));
    await waitFor(() => expect(within(meetings).queryByRole("link")).toBeNull());
    expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/v1/meetings/7/todos/1")).toBe(true);
  });

  it("adds it to a meeting it is not on yet, picked from the list", async () => {
    const { calls } = renderTodo([standupEntry]);
    const meetings = await screen.findByRole("region", { name: "Meetings" }, LAZY_PAGE);
    await within(meetings).findByRole("link", { name: /Team standup/ });
    fireEvent.click(within(meetings).getByRole("button", { name: "Add to meeting" }));
    const dialog = await screen.findByRole("dialog", { name: "Add #1 to a meeting" });
    // The standup it is on already is not offered again.
    const options = await within(dialog).findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([expect.stringContaining("Review")]);
    fireEvent.click(options[0] as HTMLElement);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.filter((c) => c.method === "POST").map((c) => [c.path, c.body])).toEqual([
      ["/api/v1/meetings/8/todos", { todoId: 1 }],
    ]);
    expect(await within(meetings).findByRole("link", { name: /Review/ })).toBeTruthy();
    // Adding does not change the due date.
    expect(calls.some((c) => c.method === "PATCH" || c.path.endsWith("/due"))).toBe(false);
  });
});
