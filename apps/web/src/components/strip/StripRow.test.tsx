import { addDays } from "@organizer/shared";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { today } from "../../lib/format.ts";
import { makeLabel, makePerson, makeTodo, renderWithApp } from "../../test/render.tsx";
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
        requestedBy: [makePerson("Anna", "Meier")],
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

  it("marks an overdue date red and a date today amber", async () => {
    row({ todo: makeTodo({ id: 1, dueOn: addDays(today(), -2) }) });
    const due = await screen.findByText(addDays(today(), -2));
    expect(due.dataset.state).toBe("overdue");
    expect(due.title).toBe("overdue 2d");
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
