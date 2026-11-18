import type { Standup, StandupItem, StandupKind } from "@organizer/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeItem, makeMeeting, makeStandup } from "../../test/meetings.ts";
import { mockApi, type RecordedCall, renderWithApp } from "../../test/render.tsx";
import { renderAppAt } from "../../test/renderApp.tsx";
import { StandupList } from "./StandupList.tsx";

await import("./MeetingPage.tsx");

afterEach(() => vi.unstubAllGlobals());

const ITEMS: StandupItem[] = [
  makeItem("done", 11, "Ship the release", { at: "2026-11-18T15:00:00.000Z" }),
  makeItem("done", 12, "Renew the certs", { at: "2026-11-17T09:00:00.000Z" }),
  makeItem("started", 13, "Write the docs", {
    changes: ["changed status from Open to In progress"],
    project: { id: 3, slug: "home-lab", name: "Home lab", color: "#4C9AFF" },
  }),
  makeItem("updated", 14, "Move the mail server", {
    lastComment: { actor: "Bo", excerpt: "DNS is ready", createdAt: "2026-11-18T09:00:00.000Z" },
    newCommentCount: 2,
    again: true,
  }),
  makeItem("blocked", 15, "Fix the VPN", { parent: { id: 9, title: "Network", status: "open" } }),
];

/** A server that keeps the marks: said and dismissed todos leave the list, undo brings them back. */
function standupServer(items: StandupItem[], options: { refuseMarks?: boolean } = {}) {
  let open = [...items];
  let list: Standup = makeStandup(open);
  const rebuild = (said: Standup["said"], dismissed: number) => {
    list = { ...makeStandup(open), said, dismissedCount: dismissed };
  };
  return mockApi((call: RecordedCall) => {
    const path = call.path.split("?")[0] ?? "";
    if (call.method === "GET" && path === "/api/v1/meetings/7/standup") {
      const kind = new URL(call.path, "http://x").searchParams.get("kind") as StandupKind | null;
      return { body: kind ? { ...list, items: list.items.filter((i) => i.kind === kind) } : list };
    }
    if (call.method === "POST" && path === "/api/v1/meetings/7/standup/marks") {
      if (options.refuseMarks)
        return { status: 422, body: { error: { code: "validation_failed", message: "No marks today." } } };
      const [mark] = (call.body as { marks: { todoId: number; kind: string }[] }).marks;
      const item = open.find((i) => i.todo.id === mark?.todoId);
      open = open.filter((i) => i !== item);
      if (mark?.kind === "said" && item)
        rebuild(
          [{ todo: item.todo, project: item.project, markedAt: "2026-11-19T08:01:00.000Z" }, ...list.said],
          list.dismissedCount,
        );
      else rebuild(list.said, list.dismissedCount + 1);
      return { body: list };
    }
    if (call.method === "DELETE" && path.startsWith("/api/v1/meetings/7/standup/marks/2026-11-19/")) {
      const todoId = Number(path.split("/").at(-1));
      const item = items.find((i) => i.todo.id === todoId);
      if (item && !open.includes(item)) open = items.filter((i) => open.includes(i) || i === item);
      rebuild(
        list.said.filter((s) => s.todo.id !== todoId),
        list.said.some((s) => s.todo.id === todoId)
          ? list.dismissedCount
          : Math.max(0, list.dismissedCount - 1),
      );
      return { status: 204 };
    }
    return { status: 404, body: { error: { code: "not_found", message: "Not here." } } };
  });
}

function renderList(kind: StandupKind | null = null) {
  const onKind = vi.fn<(kind: StandupKind | null) => void>();
  renderWithApp(<StandupList meetingId={7} on="2026-11-19" kind={kind} onKind={onKind} />);
  return onKind;
}

const titles = (scope: HTMLElement) =>
  within(scope)
    .queryAllByRole("button", { expanded: false })
    .concat(within(scope).queryAllByRole("button", { expanded: true }))
    .map((b) => b.querySelector("span")?.textContent);

describe("standup list", () => {
  it("groups by kind in the order Done, Started, Updates, Blocked, newest first, with counts", async () => {
    standupServer(ITEMS);
    renderList();
    const list = await screen.findByRole("region", { name: "To say" });
    const groups = within(list).getAllByRole("region");
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual([
      "Done",
      "Started",
      "Updates",
      "Blocked",
    ]);
    expect(titles(groups[0]!)).toEqual(["Ship the release", "Renew the certs"]);
    const chips = within(within(list).getByRole("group", { name: "Show" })).getAllByRole("button");
    expect(chips.map((c) => c.textContent)).toEqual([
      "All 5",
      "Done 2",
      "Started 1",
      "Updates 1",
      "Blocked 1",
    ]);
    expect(within(list).getByText("Since 12.11.")).toBeTruthy();

    // Each row shows its project, parent, first change or comment, and "again".
    const started = groups[1]!;
    expect(within(started).getByText("Home lab")).toBeTruthy();
    expect(within(started).getByText("changed status from Open to In progress")).toBeTruthy();
    expect(within(groups[2]!).getByText("Bo: DNS is ready")).toBeTruthy();
    expect(within(groups[2]!).getByText("new since you said it")).toBeTruthy();
    expect(within(groups[3]!).getByText("in Network")).toBeTruthy();
  });

  it("ticks an item at once, sends what it covered, and undoes it from Said at", async () => {
    const calls = standupServer(ITEMS);
    renderList();
    const list = await screen.findByRole("region", { name: "To say" });
    fireEvent.click(within(list).getByRole("button", { name: "Said: Write the docs" }));
    // Gone from the list, and the count follows.
    await waitFor(() =>
      expect(within(list).queryByRole("button", { name: "Said: Write the docs" })).toBeNull(),
    );
    expect(within(list).queryByRole("region", { name: "Started" })).toBeNull();
    expect(within(list).getByRole("button", { name: /^Started/ }).textContent).toBe("Started 0");
    expect(calls.find((c) => c.method === "POST")).toEqual({
      method: "POST",
      path: "/api/v1/meetings/7/standup/marks",
      body: {
        on: "2026-11-19",
        marks: [{ todoId: 13, kind: "said", coveredUntil: "2026-11-18T10:00:00.000Z" }],
      },
    });

    const said = within(list).getByRole("region", { name: "Said at 19.11." });
    const head = within(said).getByRole("button", { expanded: false });
    expect(head.textContent).toBe("Said at 19.11. 1");
    fireEvent.click(head);
    expect(within(said).getByText("Write the docs")).toBeTruthy();
    fireEvent.click(within(said).getByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.method === "DELETE" && c.path === "/api/v1/meetings/7/standup/marks/2026-11-19/13",
        ),
      ).toBe(true),
    );
    expect(await within(list).findByRole("button", { name: "Said: Write the docs" })).toBeTruthy();
    expect(within(list).queryByRole("region", { name: "Said at 19.11." })).toBeNull();
  });

  it("dismisses from the opened row, with an Undo in the toast", async () => {
    const calls = standupServer(ITEMS);
    renderList();
    const list = await screen.findByRole("region", { name: "To say" });
    const row = within(list).getByText("Move the mail server").closest("button") as HTMLElement;
    fireEvent.click(row);
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(within(list).getByText(/Bo, .* \(2 new comments\)/)).toBeTruthy();
    expect(within(list).getByRole("link", { name: "Open todo #14" }).getAttribute("href")).toBe("/todos/14");
    fireEvent.click(within(list).getByRole("button", { name: "Dismiss" }));

    await waitFor(() => expect(within(list).queryByText("Move the mail server")).toBeNull());
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      on: "2026-11-19",
      marks: [{ todoId: 14, kind: "dismissed", coveredUntil: "2026-11-18T10:00:00.000Z" }],
    });
    // Dismissed is not said.
    expect(within(list).queryByRole("region", { name: "Said at 19.11." })).toBeNull();
    expect(await within(list).findByText("Since 12.11., 1 dismissed")).toBeTruthy();

    const toast = await screen.findByRole("status", { name: "" });
    expect(toast.textContent).toContain('Dismissed "Move the mail server"');
    fireEvent.click(within(toast).getByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "DELETE" && c.path.endsWith("/marks/2026-11-19/14"))).toBe(true),
    );
    expect(await within(list).findByText("Move the mail server")).toBeTruthy();
  });

  it("puts the item back and says why when the server refuses the tick", async () => {
    standupServer(ITEMS, { refuseMarks: true });
    renderList();
    const list = await screen.findByRole("region", { name: "To say" });
    fireEvent.click(within(list).getByRole("button", { name: "Said: Fix the VPN" }));
    expect(await screen.findByText("No marks today.")).toBeTruthy();
    expect(within(list).getByRole("button", { name: "Said: Fix the VPN" })).toBeTruthy();
    expect(within(list).getByRole("button", { name: /^Blocked/ }).textContent).toBe("Blocked 1");
  });

  it("ticks down the list from the keyboard: j picks the first row, x ticks and moves on", async () => {
    const calls = standupServer(ITEMS);
    renderList();
    await screen.findByRole("region", { name: "To say" });
    fireEvent.keyDown(window, { key: "j" });
    fireEvent.keyDown(window, { key: "x" });
    fireEvent.keyDown(window, { key: "x" });
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(2));
    const ticked = calls
      .filter((c) => c.method === "POST")
      .map((c) => (c.body as { marks: { todoId: number }[] }).marks[0]?.todoId);
    expect(ticked).toEqual([11, 12]);
  });

  it("filters by kind through the chips; the pressed chip shows all again", async () => {
    standupServer(ITEMS);
    const onKind = renderList("blocked");
    const list = await screen.findByRole("region", { name: "To say" });
    const chips = within(list).getByRole("group", { name: "Show" });
    expect(within(chips).getByRole("button", { pressed: true }).textContent).toBe("Blocked 1");
    // Counts stay for every kind while one is shown.
    expect(within(chips).getByRole("button", { name: /^All/ }).textContent).toBe("All 5");
    expect(
      within(list)
        .getAllByRole("region")
        .map((g) => g.getAttribute("aria-label")),
    ).toEqual(["Blocked"]);
    fireEvent.click(within(chips).getByRole("button", { name: /^Done/ }));
    expect(onKind).toHaveBeenLastCalledWith("done");
    fireEvent.click(within(chips).getByRole("button", { name: /^Blocked/ }));
    expect(onKind).toHaveBeenLastCalledWith(null);
  });

  it("says there is nothing to say, or nothing of the kind with a way back", async () => {
    standupServer([]);
    const onKind = renderList("done");
    expect(await screen.findByText(/No done to say\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(onKind).toHaveBeenCalledWith(null);
  });
});

describe("standup list on the meeting page", () => {
  it("asks the server for the chosen kind of the shown date, kept in the address", async () => {
    const meeting = makeMeeting();
    const { calls, router } = renderAppAt("/meetings/7?on=2026-11-19", (call) => {
      const path = call.path.split("?")[0];
      if (path === "/api/v1/meetings/7") return { body: meeting };
      if (path === "/api/v1/meetings/7/standup") return { body: makeStandup(ITEMS) };
      if (path === "/api/v1/meetings/occurrences") return { body: [] };
      return { status: 404, body: { error: { code: "not_found", message: "Not here." } } };
    });
    const list = await screen.findByRole("region", { name: "To say" }, { timeout: 5000 });
    fireEvent.click(within(list).getByRole("button", { name: /^Updates/ }));
    await waitFor(() => expect(router.state.location.search).toEqual({ on: "2026-11-19", kind: "updated" }));
    await waitFor(() =>
      expect(calls.map((c) => c.path)).toContain("/api/v1/meetings/7/standup?on=2026-11-19&kind=updated"),
    );
  });
});
