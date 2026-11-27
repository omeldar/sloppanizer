import type { FileList, ManagedFile } from "@organizer/shared";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { makeMe, mockApi, renderWithApp } from "../../test/render.tsx";
import { FilesPage, shownFiles } from "./FilesPage.tsx";

const MB = 1024 * 1024;

function file(id: number, name: string, size: number, usedIn: ManagedFile["usedIn"] = []): ManagedFile {
  return {
    id,
    name,
    mimeType: "image/png",
    size,
    sha256: "x".repeat(64),
    url: `/api/v1/attachments/${id}/${name}`,
    inline: true,
    createdBy: "you",
    createdAt: `2026-11-${String(10 + id).padStart(2, "0")}T09:00:00.000Z`,
    usedIn,
  };
}

const used = file(1, "shot.png", 3 * MB, [{ kind: "todo", id: 7, todoId: null, title: "Renew certs" }]);
const old = file(2, "old-video.bin", 40 * MB);
const small = file(3, "tiny.png", 1000, [{ kind: "comment", id: 4, todoId: 7, title: "Renew certs" }]);

function setup() {
  let items = [small, old, used];
  const calls = mockApi(({ method, path }) => {
    if (path === "/api/v1/me") return { body: makeMe() };
    if (method === "GET" && path === "/api/v1/attachments") {
      const list: FileList = {
        usedBytes: items.reduce((sum, f) => sum + f.size, 0),
        limitBytes: 1024 * MB,
        items,
      };
      return { body: list };
    }
    if (method === "DELETE" && path === "/api/v1/attachments/2") {
      items = items.filter((f) => f.id !== 2);
      return { status: 204 };
    }
    return { status: 404, body: { error: { code: "not_found", message: "Not found" } } };
  });
  return { calls, ...renderWithApp(<FilesPage />) };
}

describe("files page (S5#11)", () => {
  it("lists every file with its size and where it is used, against the 1 GB limit", async () => {
    setup();
    const list = await screen.findByRole("list", { name: "Files" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((r) => within(r).getAllByRole("button")[0]?.textContent)).toEqual([
      "tiny.png",
      "old-video.bin",
      "shot.png",
    ]);
    expect(rows[2]?.textContent).toContain("Used in todo Renew certs");
    expect(rows[0]?.textContent).toContain("comment on Renew certs");
    expect(rows[1]?.textContent).toContain("Not used anywhere");
    expect(screen.getByRole("meter", { name: "Space used" }).getAttribute("aria-valuemax")).toBe(
      String(1024 * MB),
    );
    expect(screen.getByText(/1 not used anywhere/)).toBeTruthy();
  });

  it("deletes a file after asking, and the list and the space follow", async () => {
    const { calls } = setup();
    await userEvent.click(await screen.findByRole("button", { name: "Delete old-video.bin" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Nothing links to it.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete file" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Delete old-video.bin" })).toBeNull());
  });

  it("warns before deleting a file that is still linked", async () => {
    setup();
    await userEvent.click(await screen.findByRole("button", { name: "Delete shot.png" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("still linked from 1 place");
  });
});

describe("shownFiles", () => {
  it("filters to unused files and orders by size", () => {
    const items = [small, old, used];
    expect(shownFiles(items, "unused", "newest").map((f) => f.id)).toEqual([2]);
    expect(shownFiles(items, "all", "biggest").map((f) => f.id)).toEqual([2, 1, 3]);
    expect(shownFiles(items, "all", "newest").map((f) => f.id)).toEqual([3, 2, 1]);
  });
});
