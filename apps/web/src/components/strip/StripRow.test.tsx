import { addDays } from "@organizer/shared";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { formatDate, shortDate, today } from "../../lib/format.ts";
import { makeBrief, makeLabel, makeTodo, renderWithApp } from "../../test/render.tsx";
import { StripRow } from "./StripRow.tsx";

const DAY = 86_400_000;

function row(props: Partial<Parameters<typeof StripRow>[0]> = {}) {
  const onToggleDone = vi.fn<(...args: unknown[]) => void>();
  renderWithApp(
    <ol>
      <StripRow todo={makeTodo()} onToggleDone={onToggleDone} {...props} />
    </ol>,
  );
  return { onToggleDone };
}

describe("StripRow", () => {
  it("shows the mono id, the title as a link, pills, requesters and the aligned columns", async () => {
    row({
      todo: makeTodo({
        id: 142,
        title: "Renew SSL certs",
        createdAt: new Date(Date.now() - 41 * DAY).toISOString(),
        dueOn: addDays(today(), 5),
        labels: [makeLabel("priority::high"), makeLabel("homelab")],
        requestedBy: [makeBrief("Anna", "Meier")],
        projectId: 3,
        project: { id: 3, slug: "home-lab", name: "Home lab", color: "#4C9AFF" },
      }),
    });
    const item = await screen.findByRole("listitem");
    expect(within(item).getByText("#142")).toBeTruthy();
    expect(within(item).getByRole("link", { name: "Renew SSL certs" }).getAttribute("href")).toBe(
      "/todos/142",
    );
    expect(within(item).getByTitle("priority::high")).toBeTruthy();
    expect(within(item).getByText("from Anna Meier")).toBeTruthy();
    expect(within(item).getByText("open 41d")).toBeTruthy();
    expect(within(item).getByText("Home lab")).toBeTruthy();
    expect(item.dataset.priority).toBe("high");
  });

  it("names the shared project a todo comes from and opens it there", async () => {
    row({
      todo: makeTodo({ id: 3, title: "Book van" }),
      source: { name: "Home move", color: "#4C9AFF", href: "/u/anna/shared/7/todos/3" },
    });
    const item = await screen.findByRole("listitem");
    expect(within(item).getByText("from Home move")).toBeTruthy();
    expect(within(item).getAllByText("Home move")).toHaveLength(1);
    // Its number belongs to the shared project, so it is not shown next to your own.
    expect(within(item).queryByText("#3")).toBeNull();
    expect(within(item).getByRole("checkbox", { name: 'Mark "Book van" done' })).toBeTruthy();
    expect(within(item).getByRole("link", { name: "Book van" }).getAttribute("href")).toBe(
      "/u/anna/shared/7/todos/3",
    );
  });

  it("shows whom a todo of a shared project is assigned to", async () => {
    row({ todo: makeTodo({ id: 3, assignee: { accountId: 2, username: "bobo", name: "Bo Berg" } }) });
    expect((await screen.findByTitle("Assigned to Bo Berg")).textContent).toBe("@bobo");
  });

  it("shows the comment count only when there are comments", async () => {
    row({ todo: makeTodo({ id: 4, commentCount: 3 }) });
    expect((await screen.findByTitle("3 comments")).textContent).toContain("3");
  });

  it("leaves the comment column empty without comments", async () => {
    row({ todo: makeTodo({ id: 5, commentCount: 0 }) });
    await screen.findByText("#5");
    expect(screen.queryByTitle(/comment/)).toBeNull();
  });

  it("marks an overdue date red and a date today amber", async () => {
    row({ todo: makeTodo({ id: 1, dueOn: addDays(today(), -2) }) });
    const date = addDays(today(), -2);
    const due = await screen.findByText(shortDate(date));
    expect(due.dataset.state).toBe("overdue");
    expect(due.title).toBe(`${formatDate(date)}, overdue 2d`);
  });

  it("shows how long a done todo took instead of its age", async () => {
    row({
      todo: makeTodo({
        status: "done",
        durationMs: 3 * DAY + 4 * 3_600_000,
        doneAt: new Date().toISOString(),
      }),
    });
    const item = await screen.findByRole("listitem");
    expect(within(item).getByText("took 3d 4h")).toBeTruthy();
    expect(within(item).getByRole("checkbox", { name: "Reopen #1" })).toHaveProperty("checked", true);
    expect(item.dataset.done).toBe("true");
  });

  it("frames rank 1 as next and hides the priority reason that the pill already shows", async () => {
    row({
      rank: 1,
      todo: makeTodo({ labels: [makeLabel("priority::high")] }),
      reasons: [
        { kind: "priority", label: "priority::high", points: 25 },
        { kind: "overdue", label: "overdue 2d", points: 34 },
      ],
    });
    const item = await screen.findByRole("listitem");
    expect(item.dataset.next).toBe("true");
    expect(within(item).getByText("1")).toBeTruthy();
    expect(within(item).getByText("overdue 2d")).toBeTruthy();
    expect(within(item).queryAllByText("priority::high")).toHaveLength(0);
    expect(within(item).getByTitle("priority::high")).toBeTruthy();
  });

  it("shows the selection and has no priority band without a priority label", async () => {
    row({ selected: true });
    const item = await screen.findByRole("listitem");
    expect(item.dataset.selected).toBe("true");
    expect(item.dataset.priority).toBe("none");
  });

  it("marks done right away when the list keeps done rows", async () => {
    const { onToggleDone } = row({ collapseOnDone: false });
    await userEvent.click(await screen.findByRole("checkbox", { name: "Mark #1 done" }));
    expect(onToggleDone).toHaveBeenCalledTimes(1);
  });

  it("folds the row away first, then marks it done once", async () => {
    const { onToggleDone } = row({ collapseOnDone: true });
    await userEvent.click(await screen.findByRole("checkbox", { name: "Mark #1 done" }));
    expect((await screen.findByRole("listitem")).dataset.collapsing).toBe("true");
    expect(onToggleDone).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(onToggleDone).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(onToggleDone).toHaveBeenCalledTimes(1);
  });

  it("saves an edited title on Enter", async () => {
    const onTitleSave = vi.fn<(...args: unknown[]) => void>();
    const onTitleCancel = vi.fn<(...args: unknown[]) => void>();
    row({ editingTitle: true, onTitleSave, onTitleCancel });
    const input = await screen.findByRole("textbox", { name: "Title" });
    await userEvent.clear(input);
    await userEvent.type(input, "New title{Enter}");
    expect(onTitleSave).toHaveBeenCalledWith("New title");
    expect(onTitleCancel).not.toHaveBeenCalled();
  });

  it("cancels the title edit on Escape without saving", async () => {
    const onTitleSave = vi.fn<(...args: unknown[]) => void>();
    const onTitleCancel = vi.fn<(...args: unknown[]) => void>();
    row({ editingTitle: true, onTitleSave, onTitleCancel });
    const input = await screen.findByRole("textbox", { name: "Title" });
    await userEvent.type(input, " changed{Escape}");
    expect(onTitleCancel).toHaveBeenCalledTimes(1);
    expect(onTitleSave).not.toHaveBeenCalled();
  });
});
