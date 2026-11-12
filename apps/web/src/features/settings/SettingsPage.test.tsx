import type { FolderExport, RestorePreview, Settings } from "@organizer/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatBytes } from "../../lib/format.ts";
import { mockApi, type RecordedCall, renderWithApp } from "../../test/render.tsx";
import { MAX_RESTORE_BYTES } from "./Restore.tsx";
import { SettingsPage } from "./SettingsPage.tsx";

afterEach(() => vi.unstubAllGlobals());

const T = "2026-11-12T09:00:00.000Z";
const UPLOAD = "a".repeat(32);

const settings: Settings = {
  exportDir: "/home/me/.local/share/organizer/exports",
  folderExportKeep: 4,
  dataDir: "/home/me/.local/share/organizer",
  lastExportAt: null,
  lastFolderExport: null,
  version: "0.1.0",
};

const zip = (name: string, bytes: number): FolderExport => ({
  at: T,
  path: `${settings.exportDir}/${name}`,
  fileName: name,
  bytes,
});

const preview: RestorePreview = {
  uploadId: UPLOAD,
  fileName: "organizer-export.zip",
  format: 3,
  exportedAt: "2026-11-01T08:00:00.000Z",
  appVersion: "0.1.0",
  schemaVersion: 6,
  inFile: { todos: 140, notes: 12, comments: 30, people: 25, projects: 4, labels: 9, attachments: 3 },
  now: { todos: 141, notes: 12, comments: 31, people: 25, projects: 4, labels: 9, attachments: 2 },
  attachments: { count: 3, bytes: 52_000, missing: [] },
  warnings: ["2 files in the zip are not used by any todo and were left out."],
  expiresAt: "2026-11-12T10:00:00.000Z",
};

type Handler = (call: RecordedCall) => { status?: number; body?: unknown } | undefined;

function setup(via: "session" | "token" = "session", extra: Handler = () => undefined) {
  let zips = [zip("organizer-export-20261111-080000.zip", 48_000)];
  const calls = mockApi((call) => {
    const answer = extra(call);
    if (answer) return answer;
    const { method, path } = call;
    if (path === "/api/v1/me") return { body: { actor: "you", via, scope: "write" } };
    if (path === "/api/v1/stats") {
      return {
        body: {
          open: 0,
          doneLast7Days: 0,
          overdue: 0,
          dueToday: 0,
          plannedToday: 0,
          inbox: 0,
          lastExportAt: null,
        },
      };
    }
    if (path === "/api/v1/settings") return { body: settings };
    if (method === "GET" && path === "/api/v1/export/folder") return { body: zips };
    if (method === "POST" && path === "/api/v1/export/folder") {
      const written = zip("organizer-export-20261112-090000.zip", 50_000);
      zips = [written, ...zips];
      return { status: 201, body: written };
    }
    if (path === "/api/v1/restore/backups") return { body: [] };
    if (method === "POST" && path.startsWith("/api/v1/restore?")) return { status: 201, body: preview };
    if (method === "DELETE" && path === `/api/v1/restore/${UPLOAD}`) return { status: 204 };
    return { status: 404, body: { error: { code: "not_found", message: "Not found" } } };
  });
  return { calls, ...renderWithApp(<SettingsPage />) };
}

function pickFile(file: File) {
  fireEvent.change(screen.getByLabelText("Export zip to restore"), { target: { files: [file] } });
}

const exportZip = () => new File(["PK"], "organizer-export.zip", { type: "application/zip" });

describe("settings: write to folder", () => {
  it("shows the fixed folder and its zips, and writes a new one", async () => {
    const user = userEvent.setup();
    const { calls } = setup();
    const folder = await screen.findByRole("textbox", { name: "Export folder" });
    expect((folder as HTMLInputElement).value).toBe(settings.exportDir);
    expect((folder as HTMLInputElement).readOnly).toBe(true);
    expect(screen.getByText(/keeps the newest 4/)).toBeTruthy();
    const list = await screen.findByRole("list", { name: "Zips in the export folder" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Write to folder" }));
    await screen.findByText(`Wrote organizer-export-20261112-090000.zip (${formatBytes(50_000)})`);
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/export/folder")).toBe(true);
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(2));
  });

  it("hides the folder and restore from a token and never asks for them", async () => {
    const { calls } = setup("token");
    await screen.findByRole("button", { name: "Download export" });
    await screen.findByText(/through the browser session|access/);
    expect(screen.queryByRole("button", { name: "Write to folder" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Restore" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Manage API tokens" })).toBeNull();
    const asked = calls.map((c) => c.path);
    expect(asked).not.toContain("/api/v1/settings");
    expect(asked.some((p) => p.startsWith("/api/v1/restore"))).toBe(false);
  });
});

describe("settings: restore", () => {
  it("checks the file, shows what is in it next to now, and cancels without a change", async () => {
    const user = userEvent.setup();
    const { calls } = setup();
    await screen.findByRole("heading", { name: "Restore" });
    pickFile(exportZip());
    const shown = await screen.findByRole("group", { name: "Restore preview" });
    const upload = calls.find((c) => c.method === "POST" && c.path.startsWith("/api/v1/restore?"));
    expect(upload?.path).toBe("/api/v1/restore?name=organizer-export.zip");
    const todos = within(shown).getByRole("row", { name: /Todos/ });
    expect(
      within(todos)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["140", "141"]);
    expect(within(shown).getByRole("row", { name: /Files/ }).textContent).toContain("3");
    expect(within(shown).getByText(/not used by any todo/)).toBeTruthy();

    await user.click(within(shown).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    expect(screen.queryByRole("group", { name: "Restore preview" })).toBeNull();
    expect(calls.some((c) => c.path.endsWith("/apply"))).toBe(false);
  });

  it("lists the problems of a file that cannot be restored", async () => {
    setup("session", ({ method, path }) =>
      method === "POST" && path.startsWith("/api/v1/restore?")
        ? {
            status: 422,
            body: {
              error: {
                code: "validation_failed",
                message: "This file cannot be restored.",
                details: { problems: ["manifest.json is missing.", "data.json is missing."] },
              },
            },
          }
        : undefined,
    );
    await screen.findByRole("heading", { name: "Restore" });
    pickFile(exportZip());
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("manifest.json is missing.")).toBeTruthy();
    expect(within(alert).getByText("Nothing was changed.")).toBeTruthy();
  });

  it("refuses files over 1 GB without uploading them", async () => {
    const { calls } = setup();
    await screen.findByRole("heading", { name: "Restore" });
    const big = exportZip();
    Object.defineProperty(big, "size", { value: MAX_RESTORE_BYTES + 1 });
    pickFile(big);
    expect(await screen.findByText(/Export files can be up to 1 GB/)).toBeTruthy();
    expect(calls.some((c) => c.path.startsWith("/api/v1/restore?"))).toBe(false);
  });

  it("replaces the data only after the typed confirm, then resets the cache and goes to Next up", async () => {
    const user = userEvent.setup();
    const { calls, client, router } = setup("session", ({ method, path }) =>
      method === "POST" && path === `/api/v1/restore/${UPLOAD}/apply`
        ? {
            body: {
              restoredAt: T,
              counts: preview.inFile,
              safetyCopy: {
                fileName: "organizer-before-restore-20261112-090000.zip",
                createdAt: T,
                bytes: 1,
              },
            },
          }
        : undefined,
    );
    await screen.findByRole("heading", { name: "Restore" });
    client.setQueryData(["todos", {}], { stale: true });
    pickFile(exportZip());
    const shown = await screen.findByRole("group", { name: "Restore preview" });
    await user.click(within(shown).getByRole("button", { name: "Replace all data" }));
    // Queries on screen (like the sidebar and status bar) must ask again, not keep the old answers.
    const settingsReads = () => calls.filter((c) => c.path === "/api/v1/settings").length;
    const readsBefore = settingsReads();

    const dialog = await screen.findByRole("dialog", { name: "Replace all data?" });
    expect(within(dialog).getByText(/A safety copy of your current data is saved first/)).toBeTruthy();
    const confirm = within(dialog).getByRole("button", { name: "Replace all data" });
    await user.type(within(dialog).getByLabelText(/Type "replace"/), "replac");
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await user.type(within(dialog).getByLabelText(/Type "replace"/), "e");
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    await user.click(confirm);

    await screen.findByText(
      /Restored 140 todos, 12 notes and 25 people\. Safety copy: organizer-before-restore/,
    );
    const apply = calls.find((c) => c.path.endsWith("/apply"));
    expect(apply?.body).toEqual({ confirm: "replace" });
    expect(client.getQueryData(["todos", {}])).toBeUndefined();
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    await waitFor(() => expect(settingsReads()).toBe(readsBefore + 1));
  });
});
