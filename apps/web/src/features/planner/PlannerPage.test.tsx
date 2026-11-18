import type { MeetingOccurrence, TimeBlock } from "@organizer/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeMeeting, makeOccurrence } from "../../test/meetings.ts";
import type { RecordedCall } from "../../test/render.tsx";
import { renderAppAt } from "../../test/renderApp.tsx";

await import("./PlannerPage.tsx");

const HOUR = 3_600_000;
const standup = makeOccurrence();
const focus: TimeBlock = {
  id: 3,
  todoId: null,
  title: "Focus time",
  startAt: "2026-11-19T12:00:00.000Z",
  endAt: "2026-11-19T13:00:00.000Z",
  todo: null,
  project: null,
  createdBy: "you",
  createdAt: "2026-11-18T09:00:00.000Z",
  updatedAt: "2026-11-18T09:00:00.000Z",
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-19T06:00:00.000Z"));
  // jsdom has no pointer capture.
  Element.prototype.setPointerCapture ??= () => {};
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function renderPlanner(occurrences: MeetingOccurrence[] = [standup]) {
  return renderAppAt("/planner?day=2026-11-19", (call: RecordedCall) => {
    const path = call.path.split("?")[0];
    if (path === "/api/v1/blocks") return call.method === "GET" ? { body: [focus] } : { body: focus };
    if (path?.startsWith("/api/v1/blocks/")) return { body: focus };
    if (path === "/api/v1/meetings/occurrences") return { body: occurrences };
    if (path === "/api/v1/meetings") return { body: [makeMeeting()] };
    if (path?.startsWith("/api/v1/meetings/7"))
      return call.method === "DELETE" ? { status: 204 } : { body: makeMeeting() };
    if (path === "/api/v1/todos") return { body: { items: [], total: 0, limit: 200, offset: 0 } };
    if (path === "/api/v1/next")
      return {
        body: { mode: "smart", today: "2026-11-19", generatedAt: standup.startAt, items: [], blocked: [] },
      };
    return { status: 404, body: { error: { code: "not_found", message: "Not here." } } };
  });
}

/** Drags a card with the mouse by `dy` pixels (52 px is an hour) and lets go. */
function dragDown(card: HTMLElement, dy: number) {
  const at = { pointerId: 1, pointerType: "mouse", button: 0, clientX: 100 };
  fireEvent.pointerDown(card, { ...at, clientY: 200 });
  fireEvent.pointerMove(card, { ...at, clientY: 200 + dy / 2 });
  fireEvent.pointerMove(card, { ...at, clientY: 200 + dy });
  fireEvent.pointerUp(card, { ...at, clientY: 200 + dy });
}

const patches = (calls: RecordedCall[]) => calls.filter((c) => c.method === "PATCH" || c.method === "DELETE");

describe("meetings in the planner", () => {
  it("shows the meeting date next to blocks, marked as a meeting", async () => {
    renderPlanner();
    const card = await screen.findByTitle(/Team standup, .*, meeting/, {}, { timeout: 5000 });
    expect(card.dataset.meeting).toBe("true");
    expect(screen.getByTitle(/^Focus time, /).dataset.meeting).toBeUndefined();
  });

  it("leaves out cancelled dates", async () => {
    renderPlanner([{ ...standup, status: "cancelled" }]);
    await screen.findByTitle(/^Focus time, /, {}, { timeout: 5000 });
    expect(screen.queryByTitle(/Team standup/)).toBeNull();
  });

  it("asks which dates a dropped meeting is for, and Cancel puts it back", async () => {
    const { calls } = renderPlanner();
    const card = await screen.findByTitle(/Team standup, /, {}, { timeout: 5000 });
    const before = card.style.top;
    dragDown(card, 52);
    const ask = await screen.findByRole("dialog", { name: "Move Team standup" });
    expect(
      within(ask)
        .getAllByRole("radio")
        .map((r) => (r as HTMLInputElement).disabled),
    ).toEqual([false, false, false]);
    // While asked, the card shows where it was dropped.
    expect(screen.getByTitle(/Team standup, /).style.top).not.toBe(before);
    fireEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Move Team standup" })).toBeNull());
    expect(screen.getByTitle(/Team standup, /).style.top).toBe(before);
    expect(patches(calls)).toEqual([]);
  });

  it("moves the dropped meeting for the picked dates", async () => {
    const { calls } = renderPlanner();
    const card = await screen.findByTitle(/Team standup, /, {}, { timeout: 5000 });
    dragDown(card, 52);
    const ask = await screen.findByRole("dialog", { name: "Move Team standup" });
    fireEvent.click(within(ask).getByRole("radio", { name: /This and following/ }));
    fireEvent.click(within(ask).getByRole("button", { name: "Move" }));
    await waitFor(() =>
      expect(patches(calls)).toEqual([
        {
          method: "PATCH",
          path: "/api/v1/meetings/7/occurrences/2026-11-19",
          body: {
            scope: "following",
            startAt: new Date(Date.parse(standup.startAt) + HOUR).toISOString(),
            endAt: new Date(Date.parse(standup.endAt) + HOUR).toISOString(),
          },
        },
      ]),
    );
  });

  it("still moves a plain block straight away, without asking", async () => {
    const { calls } = renderPlanner();
    const block = await screen.findByTitle(/^Focus time, /, {}, { timeout: 5000 });
    dragDown(block, 52);
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0]).toEqual({
      method: "PATCH",
      path: "/api/v1/blocks/3",
      body: { startAt: "2026-11-19T13:00:00.000Z", endAt: "2026-11-19T14:00:00.000Z" },
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("cancels one date from its dialog, with an Undo", async () => {
    const { calls } = renderPlanner();
    fireEvent.click(await screen.findByTitle(/Team standup, /, {}, { timeout: 5000 }));
    const dialog = await screen.findByRole("dialog", { name: "Team standup" });
    expect(within(dialog).getByRole("link", { name: "Open the standup list" }).getAttribute("href")).toBe(
      "/meetings/7?on=2026-11-19",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel date" }));
    const ask = await screen.findByRole("dialog", { name: /^Cancel Team standup on Thu 19\.11\./ });
    expect(within(ask).getByRole("radio", { name: /All/ }).closest("label")?.textContent).toContain(
      "Deletes the meeting",
    );
    fireEvent.click(within(ask).getByRole("button", { name: "Cancel dates" }));
    await waitFor(() =>
      expect(patches(calls)).toEqual([
        {
          method: "PATCH",
          path: "/api/v1/meetings/7/occurrences/2026-11-19",
          body: { scope: "this", cancelled: true },
        },
      ]),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(patches(calls)[1]?.body).toEqual({ scope: "this", cancelled: false }));
  });

  it("deletes the meeting when all dates are cancelled", async () => {
    const { calls } = renderPlanner();
    fireEvent.click(await screen.findByTitle(/Team standup, /, {}, { timeout: 5000 }));
    const dialog = await screen.findByRole("dialog", { name: "Team standup" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel date" }));
    const ask = await screen.findByRole("dialog", { name: /^Cancel Team standup/ });
    fireEvent.click(within(ask).getByRole("radio", { name: /All/ }));
    fireEvent.click(within(ask).getByRole("button", { name: "Cancel dates" }));
    await waitFor(() =>
      expect(patches(calls)).toEqual([{ method: "DELETE", path: "/api/v1/meetings/7", body: undefined }]),
    );
  });

  it("moves a date from its dialog to another day and time", async () => {
    const { calls } = renderPlanner();
    fireEvent.click(await screen.findByTitle(/Team standup, /, {}, { timeout: 5000 }));
    const dialog = await screen.findByRole("dialog", { name: "Team standup" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Move" }));
    const form = within(dialog).getByRole("form", { name: "Move to" });
    fireEvent.change(within(form).getByLabelText("Day"), { target: { value: "2026-11-20" } });
    fireEvent.click(within(form).getByRole("button", { name: "Move" }));
    const ask = await screen.findByRole("dialog", { name: "Move Team standup" });
    fireEvent.click(within(ask).getByRole("button", { name: "Move" }));
    await waitFor(() =>
      expect(patches(calls)[0]?.body).toEqual({
        scope: "this",
        startAt: new Date(Date.parse(standup.startAt) + 24 * HOUR).toISOString(),
        endAt: new Date(Date.parse(standup.endAt) + 24 * HOUR).toISOString(),
      }),
    );
  });
});

/** A long press on the card, then the finger moves down by dy and lets go. */
async function longPress(card: HTMLElement, dy: number) {
  const at = (y: number) => [{ identifier: 1, target: card, clientX: 100, clientY: y }];
  fireEvent.touchStart(card, { touches: at(200), changedTouches: at(200) });
  await new Promise((done) => setTimeout(done, 450));
  fireEvent.touchMove(card, { touches: at(200 + dy / 2), changedTouches: at(200 + dy / 2) });
  fireEvent.touchMove(card, { touches: at(200 + dy), changedTouches: at(200 + dy) });
  fireEvent.touchEnd(card, { touches: [], changedTouches: at(200 + dy) });
}

describe("touch on a phone", () => {
  it("moves a short meeting card on a long press instead of resizing it", async () => {
    const { calls } = renderPlanner();
    const card = await screen.findByTitle(/Team standup, /, {}, { timeout: 5000 });
    // jsdom has no layout: give the 15 minute card its real size.
    card.getBoundingClientRect = () => ({
      top: 190,
      bottom: 212,
      height: 22,
      left: 0,
      right: 100,
      width: 100,
      x: 0,
      y: 190,
      toJSON: () => ({}),
    });
    await longPress(card, 52);
    const ask = await screen.findByRole("dialog", { name: "Move Team standup" });
    fireEvent.click(within(ask).getByRole("button", { name: "Move" }));
    await waitFor(() =>
      expect(patches(calls)[0]?.body).toEqual({
        scope: "this",
        startAt: new Date(Date.parse(standup.startAt) + HOUR).toISOString(),
        endAt: new Date(Date.parse(standup.endAt) + HOUR).toISOString(),
      }),
    );
  });
});
