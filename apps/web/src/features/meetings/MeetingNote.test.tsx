import type { MeetingNote, Note } from "@organizer/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeMeeting } from "../../test/meetings.ts";
import type { RecordedCall } from "../../test/render.tsx";
import { renderAppAt } from "../../test/renderApp.tsx";

await import("./MeetingPage.tsx");

afterEach(() => vi.unstubAllGlobals());
// cmdk scrolls the picked option into view; jsdom has no layout.
Element.prototype.scrollIntoView ??= () => {};

const T = "2026-11-19T08:20:00.000Z";

function makeNote(id: number, title: string, bodyMd = ""): Note {
  return {
    id,
    projectId: null,
    project: null,
    title,
    bodyMd,
    pinnedAt: null,
    createdBy: "you",
    createdAt: T,
    updatedAt: T,
  };
}

const link = (on: string, note: Note): MeetingNote => {
  const { bodyMd, ...summary } = note;
  return { meetingId: 7, on, note: { ...summary, excerpt: bodyMd } };
};

/** A plain meeting (no standup list) with notes kept by the fake server. */
function renderMeeting(path: string, start: MeetingNote[], notes: Note[]) {
  let links = [...start];
  const meeting = makeMeeting({ type: "other", openCount: null });
  return renderAppAt(path, (call: RecordedCall) => {
    const url = call.path.split("?")[0] ?? "";
    if (url === "/api/v1/meetings/7") return { body: meeting };
    if (url === "/api/v1/meetings/occurrences") return { body: [] };
    if (url === "/api/v1/meetings/7/notes" && call.method === "GET") return { body: links };
    if (url === "/api/v1/meetings/7/notes" && call.method === "POST") {
      const { on, noteId } = call.body as { on: string; noteId?: number };
      const note = noteId ? notes.find((n) => n.id === noteId) : makeNote(40, "Team standup 19.11.2026");
      if (!note) return { status: 404, body: { error: { code: "not_found", message: "No note." } } };
      if (!noteId) notes.push(note);
      links = [link(on, note), ...links];
      return { status: 201, body: link(on, note) };
    }
    if (url.startsWith("/api/v1/meetings/7/notes/") && call.method === "DELETE") {
      const on = url.split("/").at(-1);
      links = links.filter((l) => l.on !== on);
      return { status: 204 };
    }
    if (url.startsWith("/api/v1/notes/")) {
      const note = notes.find((n) => n.id === Number(url.split("/").at(-1)));
      return note
        ? { body: note }
        : { status: 404, body: { error: { code: "not_found", message: "No note." } } };
    }
    if (url === "/api/v1/notes")
      return {
        body: { items: notes.map((n) => link("", n).note), total: notes.length, limit: 20, offset: 0 },
      };
    return { status: 404, body: { error: { code: "not_found", message: "Not here." } } };
  });
}

describe("note per meeting date", () => {
  it("adds a new note for the date and opens it to write", async () => {
    const { calls } = renderMeeting("/meetings/7?on=2026-11-19", [], []);
    const section = await screen.findByRole("region", { name: "Note" }, { timeout: 5000 });
    expect(within(section).getByRole("heading", { name: "Note for Thu 19.11." })).toBeTruthy();
    fireEvent.click(within(section).getByRole("button", { name: "Add note" }));
    expect(await within(section).findByRole("link", { name: "Team standup 19.11.2026" })).toBeTruthy();
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ on: "2026-11-19" });
    // Opens in write mode: the Write toggle is on.
    const toggle = await within(section).findByRole("group", { name: "Text view" });
    expect(within(toggle).getByRole("button", { name: "Write" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("links an existing note picked by search", async () => {
    const { calls } = renderMeeting("/meetings/7?on=2026-11-19", [], [makeNote(5, "Ideas for the team")]);
    const section = await screen.findByRole("region", { name: "Note" }, { timeout: 5000 });
    fireEvent.click(within(section).getByRole("button", { name: "Link a note" }));
    fireEvent.click(await screen.findByRole("option", { name: /Ideas for the team/ }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({ on: "2026-11-19", noteId: 5 }),
    );
    expect(await within(section).findByRole("link", { name: "Ideas for the team" })).toBeTruthy();
  });

  it("shows the date's note, unlinks it, and lists the other dates' notes", async () => {
    const thisWeek = makeNote(5, "Standup 19.11.", "Asked Bo about **DNS**.");
    const lastWeek = makeNote(6, "Standup 12.11.", "Nothing new.");
    const { calls, router } = renderMeeting(
      "/meetings/7?on=2026-11-19",
      [link("2026-11-19", thisWeek), link("2026-11-12", lastWeek)],
      [thisWeek, lastWeek],
    );
    const section = await screen.findByRole("region", { name: "Note" }, { timeout: 5000 });
    expect(within(section).getByRole("link", { name: "Standup 19.11." }).getAttribute("href")).toBe(
      "/notes/5",
    );
    expect(await within(section).findByText("DNS")).toBeTruthy();

    const other = within(section).getByRole("button", { name: /12\.11\.2026\s*Standup 12\.11\./ });
    fireEvent.click(within(section).getByRole("button", { name: "Unlink" }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === "DELETE" && c.path === "/api/v1/meetings/7/notes/2026-11-19"),
      ).toBe(true),
    );
    expect(await within(section).findByRole("button", { name: "Add note" })).toBeTruthy();

    fireEvent.click(other);
    await waitFor(() => expect(router.state.location.search).toEqual({ on: "2026-11-12" }));
    expect(await within(section).findByText("Nothing new.")).toBeTruthy();
  });
});
