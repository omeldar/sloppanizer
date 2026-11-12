import type { ActivityItem, Comment } from "@organizer/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeBrief, makeTodo, mockApi, renderWithApp } from "../../test/render.tsx";
import { Activity, canChangeComment, visibleItems } from "./Activity.tsx";

const T = "2026-11-10T09:00:00.000Z";

function comment(id: number, actor: string, bodyMd: string, editedAt: string | null = null): Comment {
  return { id, todoId: 1, actor, bodyMd, createdAt: T, updatedAt: T, editedAt };
}

const items: ActivityItem[] = [
  { type: "event", event: { id: 1, todoId: 1, actor: "you", kind: "created", data: {}, createdAt: T } },
  {
    type: "event",
    event: {
      id: 2,
      todoId: 1,
      actor: "you",
      kind: "status_changed",
      data: { from: "open", to: "done" },
      createdAt: T,
    },
  },
  {
    type: "event",
    event: {
      id: 3,
      todoId: 1,
      actor: "assistant",
      kind: "people_changed",
      data: { role: "contact", from: [], to: [{ id: 5, name: "Max Muster" }] },
      createdAt: T,
    },
  },
  { type: "comment", comment: comment(10, "you", "Looks **good**") },
  { type: "comment", comment: comment(11, "assistant", "Checked the logs", T) },
];

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

function setup(me: { actor: string; via: "session" | "token"; scope: "read" | "write" }) {
  return mockApi(({ method, path, body }) => {
    if (path === "/api/v1/me") return { body: me };
    if (path === "/api/v1/todos/1/activity") return { body: { todoId: 1, items } };
    if (method === "POST" && path === "/api/v1/todos/1/comments") {
      return { status: 201, body: comment(12, "you", (body as { bodyMd: string }).bodyMd) };
    }
    return { status: 404, body: { error: { code: "not_found", message: "Not found" } } };
  });
}

const todo = makeTodo({ id: 1, contacts: [makeBrief("Max", "Muster", 5)] });

describe("Activity thread", () => {
  it("shows history lines in plain words and comments as Markdown, oldest first", async () => {
    setup({ actor: "you", via: "session", scope: "write" });
    renderWithApp(<Activity todo={todo} />);
    expect(await screen.findByText("changed status from Open to Done")).toBeTruthy();
    expect(screen.getByText("added contact Max Muster")).toBeTruthy();
    expect(screen.getByText("good").tagName).toBe("STRONG");
    const thread = screen.getByRole("list");
    const texts = within(thread)
      .getAllByRole("listitem")
      .map((li) => li.textContent ?? "");
    expect(texts[0]).toContain("created the todo");
    expect(texts.at(-1)).toContain("Checked the logs");
    expect(texts.at(-1)).toContain("edited");
  });

  it("hides the history with Show changes off and remembers the choice", async () => {
    setup({ actor: "you", via: "session", scope: "write" });
    renderWithApp(<Activity todo={todo} />);
    await screen.findByText("created the todo");
    await userEvent.click(screen.getByRole("checkbox", { name: "Show changes" }));
    expect(screen.queryByText("created the todo")).toBeNull();
    expect(screen.getByText("Checked the logs")).toBeTruthy();
    expect(localStorage.getItem("organizer.activity.changes")).toBe("false");
  });

  it("lets the browser session edit and delete every comment", async () => {
    setup({ actor: "you", via: "session", scope: "write" });
    renderWithApp(<Activity todo={todo} />);
    await screen.findByText("Checked the logs");
    expect(screen.getAllByRole("button", { name: "Edit" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Delete" })).toHaveLength(2);
  });

  it("sends a comment with ctrl+enter and clears the box", async () => {
    const calls = setup({ actor: "you", via: "session", scope: "write" });
    renderWithApp(<Activity todo={todo} />);
    const box = await screen.findByLabelText("New comment");
    await userEvent.click(box);
    await userEvent.keyboard("Ship it");
    fireEvent.keyDown(screen.getByLabelText("New comment"), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(calls.find((c) => c.method === "POST")?.body).toEqual({ bodyMd: "Ship it" }));
    await waitFor(() => expect(screen.getByLabelText("New comment").textContent).not.toContain("Ship it"));
  });
});

describe("comment permissions", () => {
  const mine = { actor: "assistant" };
  it("allows a write token only its own comments", () => {
    const token = { actor: "assistant", via: "token", scope: "write" } as const;
    expect(canChangeComment(mine, token)).toBe(true);
    expect(canChangeComment({ actor: "you" }, token)).toBe(false);
  });

  it("allows nothing for a read token or before /me answered", () => {
    expect(canChangeComment(mine, { actor: "assistant", via: "token", scope: "read" })).toBe(false);
    expect(canChangeComment(mine, undefined)).toBe(false);
  });

  it("keeps comments when changes are hidden", () => {
    expect(visibleItems(items, false).map((i) => i.type)).toEqual(["comment", "comment"]);
    expect(visibleItems(items, true)).toHaveLength(5);
  });
});
