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
    if (path?.endsWith("/notes")) return { body: [] };
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
    const checked = () =>
      within(within(dialog).getByRole("radiogroup", { name: "Type" })).getByRole("radio", { checked: true })
        .textContent;

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
    expect(within(dialog).getByText(/since the last meeting on Thu 12\.11\./)).toBeTruthy();
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

  it("creates a one-time meeting with people: no repeat in the request (S5#5)", async () => {
    const created = makeMeeting({ type: "other", oneTime: true });
    const { calls } = renderAppAt(
      "/meetings",
      api(({ method, path }) => {
        if (path === "/api/v1/meetings") return method === "POST" ? { body: created } : { body: [] };
        if (path === "/api/v1/meetings/7") return { body: created };
        if (path === "/api/v1/people") return { body: [] };
        if (path === "/api/v1/users") return { body: [] };
        return undefined;
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: /New meeting/ }, LAZY_PAGE));
    const dialog = await screen.findByRole("dialog", { name: "New meeting" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), {
      target: { value: "Kick-off" },
    });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Once" }));
    expect(within(dialog).queryByText("Repeats", { selector: "span" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Create meeting" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      name: "Kick-off",
      type: "other",
      schedule: { startsOn: "2026-11-19", startTime: "09:00", durationMinutes: 15 },
    });
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

  it("shows the meeting's people and removes one with a pick (S5#5)", async () => {
    const bo = {
      id: 4,
      firstName: "Bo",
      lastName: "Berg",
      displayName: "Bo Berg",
      note: "",
      team: "Ops",
      email: "",
    };
    const meeting = makeMeeting({ type: "other", openCount: null, people: [bo] });
    const { calls } = renderAppAt(
      "/meetings/7",
      api(({ method, path }) => {
        if (path === "/api/v1/meetings/7")
          return { body: method === "PATCH" ? { ...meeting, people: [] } : meeting };
        if (path === "/api/v1/people")
          return {
            body: [
              {
                ...bo,
                notesMd: "",
                username: "",
                languages: [],
                topics: [],
                tags: [],
                counts: { requested: 0, requestedOpen: 0, requestedDone: 0, contact: 0, contactOpen: 0 },
                createdAt: "2026-11-01T09:00:00.000Z",
                updatedAt: "2026-11-01T09:00:00.000Z",
              },
            ],
          };
        if (path === "/api/v1/users") return { body: [] };
        return undefined;
      }),
    );
    const section = await screen.findByRole("region", { name: "People" }, LAZY_PAGE);
    expect(
      within(section)
        .getByRole("link", { name: /Bo Berg/ })
        .getAttribute("href"),
    ).toBe("/people/4");
    fireEvent.click(within(section).getByRole("button", { name: "People: add or remove" }));
    fireEvent.click(await screen.findByRole("option", { name: /Bo Berg/ }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")).toEqual({
        method: "PATCH",
        path: "/api/v1/meetings/7",
        body: { removePeople: [{ personId: 4 }] },
      }),
    );
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

  it("says when the shown date is no longer a date of the meeting, and offers no ticks there", async () => {
    const { calls } = renderAppAt(
      "/meetings/7?on=2026-11-20",
      api(({ path }) => (path === "/api/v1/meetings/7" ? { body: makeMeeting() } : undefined)),
    );
    expect(await screen.findByText("Not a date of this meeting any more", {}, LAZY_PAGE)).toBeTruthy();
    expect(screen.queryByRole("region", { name: "To say" })).toBeNull();
    expect(calls.some((c) => c.path.includes("/standup"))).toBe(false);
    // The steps still lead to real dates around it.
    expect(screen.getByRole("button", { name: "Next date" })).toHaveProperty("disabled", false);
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
