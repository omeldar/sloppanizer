import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordedCall } from "../../test/render.tsx";
import { makeMeeting, makeSeries } from "../../test/meetings.ts";
import { renderAppAt } from "../../test/renderApp.tsx";

// The routes load these pages lazily; loading them with the test file keeps that out of the first test.
await import("./MeetingsPage.tsx");
await import("./MeetingPage.tsx");

const LAZY_PAGE = { timeout: 5000 };
const NOT_FOUND = {
  status: 404,
  body: { error: { code: "not_found", message: "Meeting #99 does not exist." } },
};

beforeEach(() => {
  // Thursday 19.11.2026, 07:00 UTC: before the 09:00 standup in Zurich.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-19T07:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** The usual answers of the app shell, plus the meeting routes from `meetings`. */
function api(meetings: (call: RecordedCall) => { status?: number; body?: unknown } | undefined) {
  return (call: RecordedCall) => {
    const answer = meetings(call);
    if (answer) return answer;
    const path = call.path.split("?")[0];
    if (path === "/api/v1/projects" || path === "/api/v1/labels") return { body: [] };
    if (path === "/api/v1/meetings/occurrences") return { body: [] };
    return NOT_FOUND;
  };
}

describe("meetings list", () => {
  it("shows each meeting with its repeat, next date and what is left to say", async () => {
    renderAppAt(
      "/meetings",
      api(({ path }) =>
        path === "/api/v1/meetings"
          ? {
              body: [
                makeMeeting({ id: 8, name: "1:1 with Bo", type: "other", openCount: null, next: null }),
                makeMeeting(),
              ],
            }
          : undefined,
      ),
    );
    const cards = await screen.findAllByRole("link", { name: /Team standup|1:1 with Bo/ }, LAZY_PAGE);
    // The one with a next date first.
    expect(cards.map((c) => c.textContent)).toEqual([
      expect.stringContaining("Team standup"),
      expect.stringContaining("1:1 with Bo"),
    ]);
    expect(cards[0]?.textContent).toContain("every week on Thu, 09:00–09:15");
    expect(cards[0]?.textContent).toMatch(/Next Thu 19\.11\., \d\d:\d\d/);
    expect(cards[0]?.textContent).toContain("3 to say");
    expect(cards[1]?.textContent).toContain("No next date");
    expect(cards[1]?.textContent).not.toContain("to say");
  });
});

describe("new meeting", () => {
  it("picks Standup from the name until the type is chosen by hand", async () => {
    renderAppAt(
      "/meetings",
      api(({ path }) => (path === "/api/v1/meetings" ? { body: [] } : undefined)),
    );
    fireEvent.click(await screen.findByRole("button", { name: /New meeting/ }, LAZY_PAGE));
    const dialog = await screen.findByRole("dialog", { name: "New meeting" });
    const name = within(dialog).getByRole("textbox", { name: "Name" });
    const checked = () => within(dialog).getByRole("radio", { checked: true }).textContent;

    expect(checked()).toBe("Other");
    fireEvent.change(name, { target: { value: "Daily scrum" } });
    expect(checked()).toBe("Standup");
    expect(within(dialog).getByLabelText(/^Count from/)).toBeTruthy();
    fireEvent.change(name, { target: { value: "Coffee" } });
    expect(checked()).toBe("Other");
    expect(within(dialog).queryByLabelText(/^Count from/)).toBeNull();

    fireEvent.click(within(dialog).getByRole("radio", { name: "Standup" }));
    fireEvent.change(name, { target: { value: "Coffee chat" } });
    expect(checked()).toBe("Standup");
  });

  it("repeats on a schedule only: no 'does not repeat' and no counting from done", async () => {
    renderAppAt(
      "/meetings",
      api(({ path }) => (path === "/api/v1/meetings" ? { body: [] } : undefined)),
    );
    fireEvent.click(await screen.findByRole("button", { name: /New meeting/ }, LAZY_PAGE));
    const dialog = await screen.findByRole("dialog", { name: "New meeting" });
    const repeat = within(dialog).getByRole("button", { name: "Repeat" });
    expect(repeat.textContent).toBe("every week on Thu");
    fireEvent.click(repeat);
    const panel = await screen.findByRole("group", { name: "Repeat" });
    expect(within(panel).queryByRole("button", { name: "Does not repeat" })).toBeNull();
    fireEvent.click(within(panel).getByRole("button", { name: "Custom" }));
    const form = screen.getByRole("form", { name: "Custom repeat" });
    expect(within(form).queryByLabelText("from when it is done")).toBeNull();
  });

  it("creates a weekly standup and opens it; the list counts from the server's last date", async () => {
    const created = makeMeeting();
    const { calls, router } = renderAppAt(
      "/meetings",
      api(({ method, path }) => {
        if (path === "/api/v1/meetings") return method === "POST" ? { body: created } : { body: [] };
        if (path === "/api/v1/meetings/7") return { body: created };
        return undefined;
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: /New meeting/ }, LAZY_PAGE));
    const dialog = await screen.findByRole("dialog", { name: "New meeting" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), {
      target: { value: "Team standup" },
    });
    // The last Thursday before now is shown as where the list starts.
    expect(within(dialog).getByText(/since the last meeting, 12\.11\./)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Create meeting" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/meetings/7"));
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toEqual({
      name: "Team standup",
      type: "standup",
      schedule: {
        rule: { every: "week", interval: 1, weekdays: ["thu"], basis: "schedule" },
        startsOn: "2026-11-19",
        endsOn: null,
        startTime: "09:00",
        durationMinutes: 15,
      },
      filter: { projectIds: [], inbox: false, labelIds: [] },
    });
    expect(await screen.findByRole("heading", { name: "Team standup" })).toBeTruthy();
  });

  it("sends the day the user picked to count from", async () => {
    const { calls } = renderAppAt(
      "/meetings",
      api(({ method, path }) =>
        path === "/api/v1/meetings"
          ? method === "POST"
            ? { status: 422, body: { error: { code: "validation_failed", message: "Nope." } } }
            : { body: [] }
          : undefined,
      ),
    );
    fireEvent.click(await screen.findByRole("button", { name: /New meeting/ }, LAZY_PAGE));
    const dialog = await screen.findByRole("dialog", { name: "New meeting" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), { target: { value: "Standup" } });
    fireEvent.change(within(dialog).getByLabelText(/^Count from/), { target: { value: "2026-11-01" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create meeting" }));
    expect(await within(dialog).findByText("Nope.")).toBeTruthy();
    expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({ countFrom: "2026-11-01" });
  });
});

describe("one meeting", () => {
  it("says the meeting does not exist when the server answers 404 (another account's id)", async () => {
    renderAppAt(
      "/meetings/99",
      api(() => undefined),
    );
    expect(await screen.findByText(/There is no meeting 99/, {}, LAZY_PAGE)).toBeTruthy();
  });

  it("steps through the dates and shows a cancelled date with a restore", async () => {
    const meeting = makeMeeting({ type: "other", openCount: null });
    const { calls, router } = renderAppAt(
      "/meetings/7",
      api(({ method, path }) => {
        if (path === "/api/v1/meetings/7") return { body: meeting };
        if (path.startsWith("/api/v1/meetings/occurrences"))
          return {
            body: [
              {
                ...meeting.next,
                occursOn: "2026-11-26",
                startAt: "2026-11-26T08:00:00.000Z",
                status: "cancelled",
              },
            ],
          };
        if (method === "PATCH") return { body: meeting };
        return undefined;
      }),
    );
    const dates = await screen.findByRole("navigation", { name: "Meeting dates" }, LAZY_PAGE);
    expect(within(dates).getByText("Thu 19.11.")).toBeTruthy();
    fireEvent.click(within(dates).getByRole("button", { name: "Next date" }));
    await waitFor(() => expect(router.state.location.search).toEqual({ on: "2026-11-26" }));
    expect(await within(dates).findByText("Cancelled")).toBeTruthy();
    fireEvent.click(within(dates).getByRole("button", { name: "Restore" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")).toEqual({
        method: "PATCH",
        path: "/api/v1/meetings/7/occurrences/2026-11-26",
        body: { scope: "this", cancelled: false },
      }),
    );
  });

  it("asks which dates a new time is for and sends it from the shown date", async () => {
    const meeting = makeMeeting({ segments: [makeSeries()] });
    const { calls } = renderAppAt(
      "/meetings/7?on=2026-11-26",
      api(({ method, path }) => {
        if (path === "/api/v1/meetings/7") return { body: meeting };
        if (path.endsWith("/standup")) return undefined;
        if (method === "PATCH") return { body: meeting };
        return undefined;
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Edit meeting" }, LAZY_PAGE));
    const dialog = await screen.findByRole("dialog", { name: "Edit meeting" });
    fireEvent.change(within(dialog).getByLabelText("From"), { target: { value: "09:30" } });
    fireEvent.change(within(dialog).getByLabelText("To"), { target: { value: "09:45" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    const scope = await screen.findByRole("dialog", { name: "Change the repeat for" });
    expect(within(scope).getByRole("radio", { name: /This and following/ })).toHaveProperty("checked", true);
    fireEvent.click(within(scope).getByRole("radio", { name: /All/ }));
    fireEvent.click(within(scope).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "PATCH")).toEqual([
        {
          method: "PATCH",
          path: "/api/v1/meetings/7/schedule",
          body: { scope: "all", from: "2026-11-26", startTime: "09:30" },
        },
      ]),
    );
  });
});
