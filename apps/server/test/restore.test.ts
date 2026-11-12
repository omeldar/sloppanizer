import type { BackupFile, RestorePreview, RestoreResult, Settings, Todo } from "@organizer/shared";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { setSetting } from "../src/services/settings.ts";
import { fillEveryTable } from "./fixtures.ts";
import { json, makeApp, type TestApp } from "./helpers.ts";

type Files = Record<string, Uint8Array>;

const exportZip = async (t: TestApp): Promise<Buffer> => {
  const res = await t.call("GET", "/api/v1/export.zip");
  expect(res.statusCode).toBe(200);
  return res.rawPayload;
};

const upload = (t: TestApp, zip: Uint8Array, name = "organizer-export.zip") =>
  t.call("POST", `/api/v1/restore?name=${encodeURIComponent(name)}`, Buffer.from(zip), {
    "content-type": "application/zip",
  });

const readJson = (files: Files, name: string) => JSON.parse(strFromU8(files[name] as Uint8Array));

/** Changes manifest.json and data.json of a zip and packs it again (loose JSON on purpose). */
// oxlint-disable-next-line typescript/no-explicit-any
function rework(zip: Uint8Array, change: (manifest: any, data: any, files: Files) => void): Uint8Array {
  const files = unzipSync(zip);
  const manifest = readJson(files, "manifest.json");
  const data = readJson(files, "data.json");
  change(manifest, data, files);
  files["manifest.json"] = strToU8(JSON.stringify(manifest));
  files["data.json"] = strToU8(JSON.stringify(data));
  return zipSync(files);
}

// oxlint-disable-next-line typescript/no-explicit-any
const problems = (res: { json: () => any }): string[] => res.json().error.details.problems;

const dataOf = (zip: Uint8Array) => readJson(unzipSync(zip), "data.json");
const manifest = (zip: Uint8Array) => readJson(unzipSync(zip), "manifest.json");

describe("restore upload and preview", () => {
  it("checks a valid export and shows what it holds next to the data now", async () => {
    const t = await makeApp();
    await fillEveryTable(t);
    const zip = await exportZip(t);
    const res = await upload(t, zip, "C:\\Users\\x\\organizer-export-20261111.zip");
    expect(res.statusCode).toBe(201);
    const preview = res.json() as RestorePreview;
    expect(preview).toMatchObject({
      fileName: "organizer-export-20261111.zip",
      format: 3,
      exportedAt: "2026-11-11T10:00:00.000Z",
      appVersion: "0.1.0",
      schemaVersion: 6,
      attachments: { count: 1, bytes: 11, missing: [] },
      warnings: [],
      expiresAt: "2026-11-11T11:00:00.000Z",
    });
    expect(preview.uploadId).toMatch(/^[0-9a-f]{32}$/);
    expect(preview.inFile).toEqual(preview.now);
    expect(preview.inFile.todos).toBe(4);
    expect(json<RestorePreview>(await t.call("GET", `/api/v1/restore/${preview.uploadId}`))).toEqual(preview);
    const staged = join(t.dataDir, "restore", `${preview.uploadId}.zip`);
    expect(statSync(staged).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(staged)).mode & 0o777).toBe(0o700);
    // No scratch database is left behind.
    expect(readdirSync(dirname(staged)).filter((n) => n.includes(".db"))).toEqual([]);

    // A new upload replaces the staged one; staged uploads expire after an hour.
    const second = json<RestorePreview>(await upload(t, zip));
    expect((await t.call("GET", `/api/v1/restore/${preview.uploadId}`)).statusCode).toBe(404);
    t.advance(61 * 60_000);
    expect((await t.call("GET", `/api/v1/restore/${second.uploadId}`)).statusCode).toBe(404);
    expect(existsSync(join(t.dataDir, "restore", `${second.uploadId}.zip`))).toBe(false);
  });

  it("drops a staged upload on DELETE", async () => {
    const t = await makeApp();
    const preview = json<RestorePreview>(await upload(t, await exportZip(t)));
    expect((await t.call("DELETE", `/api/v1/restore/${preview.uploadId}`)).statusCode).toBe(204);
    expect((await t.call("GET", `/api/v1/restore/${preview.uploadId}`)).statusCode).toBe(404);
    expect((await t.call("DELETE", `/api/v1/restore/${preview.uploadId}`)).statusCode).toBe(404);
    expect((await t.call("GET", "/api/v1/restore/not-an-id")).statusCode).toBe(422);
  });

  it("refuses files that are not restorable, with plain problems", async () => {
    const t = await makeApp();
    await fillEveryTable(t);
    const zip = await exportZip(t);
    const check = async (bytes: Uint8Array, pattern: RegExp) => {
      const res = await upload(t, bytes);
      expect(res.statusCode).toBe(422);
      expect(problems(res).join("\n")).toMatch(pattern);
    };
    await check(Buffer.from("not a zip at all, just text"), /not a zip/);
    await check(new Uint8Array(0), /empty/);
    await check(zipSync({ "hello.txt": strToU8("hi") }), /manifest\.json is missing/);
    await check(
      rework(zip, (m) => (m.app = "other")),
      /organizer export/,
    );
    await check(
      rework(zip, (m) => (m.format = 9)),
      /format 9 is not known/,
    );
    await check(
      rework(zip, (m) => (m.schemaVersion = 99)),
      /newer organizer\. Update this one first/,
    );
    await check(
      rework(zip, (_m, d) => (d.gadgets = [])),
      /table "gadgets"/,
    );
    await check(
      rework(zip, (_m, d) => delete d.labels),
      /misses the table "labels"/,
    );
    await check(
      rework(zip, (_m, d) => (d.todos[0].colour = "red")),
      /todos: unknown column colour/,
    );
    await check(
      rework(zip, (_m, d) => (d.todos[0].position = "first")),
      /todos \d+: wrong type in position/,
    );
    await check(
      rework(zip, (_m, d) => d.todo_labels.push({ todo_id: d.todos[0].id, label_id: 999 })),
      /todo_labels \d+: points to a missing row in labels/,
    );
    await check(
      rework(zip, (_m, d) => (d.todos[1].title = "")),
      /todos \d+: CHECK constraint failed/,
    );
    // The data stayed as it was.
    expect(json<{ total: number }>(await t.call("GET", "/api/v1/todos")).total).toBe(3);
  });

  it("refuses duplicate entry names and damaged sizes", async () => {
    const t = await makeApp();
    const zip = await exportZip(t);
    // Two entries named data.json: pack "data.jsoo" and rename it in place.
    const files = unzipSync(zip);
    files["data.jsoo"] = files["data.json"] as Uint8Array;
    const doubled = Buffer.from(zipSync(files));
    let at = doubled.indexOf("data.jsoo");
    while (at !== -1) {
      doubled.write("data.json", at, "latin1");
      at = doubled.indexOf("data.jsoo");
    }
    const res = await upload(t, doubled);
    expect(res.statusCode).toBe(422);
    expect(problems(res)).toContain('The archive has the entry "data.json" twice.');

    // The directory says data.json is 10 bytes; the real data is longer.
    const lying = Buffer.from(zip);
    const central = lying.lastIndexOf(Buffer.from("data.json")) - 46;
    expect(lying.readUInt32LE(central)).toBe(0x02014b50);
    lying.writeUInt32LE(10, central + 24);
    const damaged = await upload(t, lying);
    expect(damaged.statusCode).toBe(422);
    expect(problems(damaged).join()).toMatch(/data\.json/);
  });

  it("checks attachments by name, size and checksum, and ignores other entries", async () => {
    const t = await makeApp();
    const { file } = await fillEveryTable(t);
    const zip = await exportZip(t);
    const name = `attachments/${file.id}-${file.name}`;

    const wrong = rework(zip, (_m, _d, files) => (files[name] = strToU8("tampered!!!")));
    expect(problems(await upload(t, wrong)).join()).toMatch(/does not match its size or checksum/);

    const missing = rework(zip, (_m, _d, files) => delete files[name]);
    expect(problems(await upload(t, missing)).join()).toMatch(/attachment \d+ \(shot\.png\) is missing/);

    const listed = rework(zip, (m, _d, files) => {
      delete files[name];
      m.attachments.missing = [file.id];
    });
    const ok = await upload(t, listed);
    expect(ok.statusCode).toBe(201);
    expect(ok.json().warnings).toEqual([
      `1 file was already missing when the export was made (attachment ${file.id}).`,
    ]);

    const extra = rework(zip, (_m, _d, files) => {
      files["../../evil.txt"] = strToU8("evil");
      files["attachments/../../../evil2.txt"] = strToU8("evil");
      files[`attachments/999-other.bin`] = strToU8("x");
    });
    const preview = await upload(t, extra);
    expect(preview.statusCode).toBe(201);
    expect(preview.json().warnings).toEqual([
      "2 files in attachments/ belong to no attachment and are ignored.",
    ]);
    const applied = await t.call("POST", `/api/v1/restore/${preview.json().uploadId}/apply`, {
      confirm: "replace",
    });
    expect(applied.statusCode).toBe(200);
    for (const dir of [t.dataDir, dirname(t.dataDir), dirname(dirname(t.dataDir))]) {
      expect(readdirSync(dir).filter((n) => n.startsWith("evil"))).toEqual([]);
    }
    expect(readdirSync(join(t.dataDir, "attachments"))).toEqual([String(file.id)]);
  });

  it("answers 413 above the upload limit and 422 above the unpacked limits", async () => {
    const small = await makeApp({ limits: { uploadBytes: 2000 } });
    await fillEveryTable(small);
    const big = await upload(small, await exportZip(small));
    expect(big.statusCode).toBe(413);
    expect(big.json().error).toMatchObject({ code: "too_large", message: "Export files can be up to 1 GB." });

    const tight = await makeApp({ limits: { dataJsonBytes: 1000 } });
    await fillEveryTable(tight);
    expect(problems(await upload(tight, await exportZip(tight))).join()).toMatch(/data\.json is larger than/);
    const total = await makeApp({ limits: { totalBytes: 5000 } });
    await fillEveryTable(total);
    expect(problems(await upload(total, await exportZip(total))).join()).toMatch(/larger than 4 GB/);
  });

  it("is for the browser session only", async () => {
    const t = await makeApp();
    const zip = await exportZip(t);
    const preview = json<RestorePreview>(await upload(t, zip));
    const calls = [t.token("r", "read"), t.token("w", "write")].flatMap((raw) => [
      t.app.inject({
        method: "POST",
        url: "/api/v1/restore",
        payload: Buffer.from(zip),
        headers: { authorization: `Bearer ${raw}`, "content-type": "application/zip" },
      }),
      t.withToken(raw, "GET", `/api/v1/restore/${preview.uploadId}`),
      t.withToken(raw, "DELETE", `/api/v1/restore/${preview.uploadId}`),
      t.withToken(raw, "POST", `/api/v1/restore/${preview.uploadId}/apply`, { confirm: "replace" }),
      t.withToken(raw, "GET", "/api/v1/restore/backups"),
    ]);
    const statuses = (await Promise.all(calls)).map((res) => res.statusCode);
    expect(statuses).toEqual(Array.from({ length: 10 }, () => 403));
  });

  it("allows one restore at a time", async () => {
    const t = await makeApp();
    const zip = await exportZip(t);
    const preview = json<RestorePreview>(await upload(t, zip));
    t.deps.restoreLock.busy = true;
    expect((await upload(t, zip)).statusCode).toBe(409);
    expect(
      (await t.call("POST", `/api/v1/restore/${preview.uploadId}/apply`, { confirm: "replace" })).statusCode,
    ).toBe(409);
    t.deps.restoreLock.busy = false;
    expect(
      (await t.call("POST", `/api/v1/restore/${preview.uploadId}/apply`, { confirm: "yes" })).statusCode,
    ).toBe(422);
  });
});

describe("restore apply", () => {
  it("replaces everything, keeps tokens and device settings, saves a safety copy, and round trips", async () => {
    const t = await makeApp();
    const { todo, file } = await fillEveryTable(t);
    const original = await exportZip(t);
    const originalFile = (await t.call("GET", `/api/v1/attachments/${file.id}`)).rawPayload;

    // Change things after the export.
    t.advance(60_000);
    await t.call("DELETE", `/api/v1/todos/${todo.id}`);
    const added = await t.create<Todo>("/api/v1/todos", { title: "Added later" });
    const mcp = t.token("mcp", "write");
    setSetting(t.deps.db, "lastFolderExport", {
      at: "2026-11-11T10:01:00.000Z",
      path: "/x",
      fileName: "x.zip",
      bytes: 1,
    });

    const preview = json<RestorePreview>(await upload(t, original));
    expect(preview.now.todos).toBe(4);
    const res = await t.call("POST", `/api/v1/restore/${preview.uploadId}/apply`, { confirm: "replace" });
    expect(res.statusCode).toBe(200);
    const result = res.json() as RestoreResult;
    expect(result.restoredAt).toBe("2026-11-11T10:01:00.000Z");
    expect(result.counts.todos).toBe(4);
    expect(result.safetyCopy.fileName).toBe("organizer-before-restore-20261111-110100.zip");
    const copyPath = join(t.dataDir, "backups", result.safetyCopy.fileName);
    expect(statSync(copyPath).mode & 0o777).toBe(0o600);
    // The safety copy holds the data before the restore and did not count as an export.
    expect(dataOf(readFileSync(copyPath)).todos.map((r: Todo) => r.title)).toContain("Added later");

    // Data is back: the deleted todo returns, the added one is gone, files are byte-identical.
    expect((await t.call("GET", `/api/v1/todos/${todo.id}`)).statusCode).toBe(200);
    expect((await t.call("GET", `/api/v1/todos/${added.id}`)).statusCode).toBe(404);
    expect(
      Buffer.compare((await t.call("GET", `/api/v1/attachments/${file.id}`)).rawPayload, originalFile),
    ).toBe(0);
    // Search works on the restored data.
    expect(json<{ counts: { todo: number } }>(await t.call("GET", "/api/v1/search?q=Rack")).counts.todo).toBe(
      1,
    );
    // Tokens and device settings stay; the session keeps working.
    expect((await t.withToken(mcp, "GET", "/api/v1/me")).statusCode).toBe(200);
    const settings = json<Settings>(await t.call("GET", "/api/v1/settings"));
    expect(settings.lastFolderExport?.fileName).toBe("x.zip");
    expect(settings.lastExportAt).toBe("2026-11-11T10:00:00.000Z");
    // The staged upload and staging folders are gone.
    expect(readdirSync(join(t.dataDir, "restore"))).toEqual([]);
    expect(readdirSync(t.dataDir).filter((n) => n.startsWith("attachments."))).toEqual([]);

    // Round trip: a new export equals the first one except lastExportAt; next ids stay unused.
    t.advance(60_000);
    const again = await exportZip(t);
    const before = dataOf(original);
    const after = dataOf(again);
    expect({ ...after, settings: [] }).toEqual({ ...before, settings: [] });
    expect(after.settings.filter((s: { key: string }) => s.key !== "lastExportAt")).toEqual(
      before.settings.filter((s: { key: string }) => s.key !== "lastExportAt"),
    );
    expect(manifest(again).counts).toEqual(manifest(original).counts);
    expect(manifest(again).sequences).toEqual(manifest(original).sequences);
    const next = await t.create<Todo>("/api/v1/todos", { title: "New" });
    expect(next.id).toBe(manifest(original).sequences.todos + 1);

    // The safety copy can be listed and downloaded.
    const backups = json<BackupFile[]>(await t.call("GET", "/api/v1/restore/backups"));
    expect(backups.map((b) => b.fileName)).toEqual([result.safetyCopy.fileName]);
    const download = await t.call("GET", `/api/v1/restore/backups/${result.safetyCopy.fileName}`);
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toBe("application/zip");
    expect((await t.call("GET", "/api/v1/restore/backups/..%2Fsecret")).statusCode).toBe(404);
    expect(
      (await t.call("GET", "/api/v1/restore/backups/organizer-before-restore-20990101-000000.zip"))
        .statusCode,
    ).toBe(404);
  });

  it("keeps the newest 5 safety copies", async () => {
    const t = await makeApp();
    const zip = await exportZip(t);
    const names: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- restores run one after the other
      const preview = json<RestorePreview>(await upload(t, zip));
      const result = json<RestoreResult>(
        // oxlint-disable-next-line no-await-in-loop -- restores run one after the other
        await t.call("POST", `/api/v1/restore/${preview.uploadId}/apply`, { confirm: "replace" }),
      );
      names.push(result.safetyCopy.fileName);
      t.advance(1000);
    }
    const kept = json<BackupFile[]>(await t.call("GET", "/api/v1/restore/backups")).map((b) => b.fileName);
    expect(kept).toEqual(names.slice(1).toReversed());
    expect(readdirSync(join(t.dataDir, "backups")).toSorted()).toEqual(names.slice(1).toSorted());
  });

  it("restores format 1 and 2 archives with defaults for newer columns and repairs scope labels", async () => {
    const t = await makeApp();
    await fillEveryTable(t);
    const zip = await exportZip(t);
    const format2 = rework(zip, (m, d) => {
      m.format = 2;
      m.schemaVersion = 5;
      delete m.sequences;
      delete d.todo_links;
      for (const row of d.todos) {
        delete row.recurrence;
        delete row.recurrence_prev_id;
      }
      // Two priority labels on one todo, as an old rename could leave it.
      const high = d.labels.find((l: { name: string }) => l.name === "priority::high");
      const low = d.labels.find((l: { name: string }) => l.name === "priority::low");
      const tagged = d.todo_labels.find((r: { label_id: number }) => r.label_id === high.id);
      d.todo_labels.push({ todo_id: tagged.todo_id, label_id: low.id });
    });
    const preview2 = json<RestorePreview>(await upload(t, format2));
    expect(preview2.format).toBe(2);
    expect(Object.keys(preview2.inFile)).not.toContain("todo_links");
    expect(
      (await t.call("POST", `/api/v1/restore/${preview2.uploadId}/apply`, { confirm: "replace" })).statusCode,
    ).toBe(200);
    const rack = json<{ items: Todo[] }>(await t.call("GET", "/api/v1/todos?q=Rack")).items[0];
    expect(rack?.labels.map((l) => l.name)).toEqual(["priority::high", "homelab"]);
    expect(t.deps.db.$client.prepare("SELECT count(*) AS n FROM todo_links").get()).toEqual({ n: 0 });

    const format1 = zipSync({
      "manifest.json": strToU8(
        JSON.stringify({
          app: "organizer",
          format: 1,
          exportedAt: "2026-11-01T10:00:00.000Z",
          appVersion: "0.1.0",
          schemaVersion: 2,
          counts: {},
        }),
      ),
      "data.json": strToU8(
        JSON.stringify({
          projects: [],
          labels: [
            {
              id: 1,
              name: "priority::high",
              scope: "priority",
              value: "high",
              color: "#FFB224",
              description: "",
              rank: 1,
              created_at: "2026-11-01T10:00:00.000Z",
              updated_at: "2026-11-01T10:00:00.000Z",
            },
          ],
          people: [
            {
              id: 1,
              first_name: "Anna",
              last_name: "Meier",
              note: "",
              created_at: "2026-11-01T10:00:00.000Z",
              updated_at: "2026-11-01T10:00:00.000Z",
            },
          ],
          todos: [
            {
              id: 7,
              project_id: null,
              parent_id: null,
              title: "Old todo",
              description_md: "",
              status: "open",
              due_on: null,
              planned_on: null,
              position: 0,
              created_at: "2026-11-01T10:00:00.000Z",
              updated_at: "2026-11-01T10:00:00.000Z",
              done_at: null,
              last_activity_at: "2026-11-01T10:00:00.000Z",
            },
          ],
          todo_labels: [{ todo_id: 7, label_id: 1 }],
          todo_people: [
            { todo_id: 7, person_id: 1, role: "requester", created_at: "2026-11-01T10:00:00.000Z" },
          ],
          events: [],
          settings: [{ key: "lastExportAt", value: '"2026-11-01T10:00:00.000Z"' }],
        }),
      ),
    });
    const preview1 = json<RestorePreview>(await upload(t, format1));
    expect(preview1).toMatchObject({ format: 1, attachments: { count: 0, bytes: 0, missing: [] } });
    expect(
      (await t.call("POST", `/api/v1/restore/${preview1.uploadId}/apply`, { confirm: "replace" })).statusCode,
    ).toBe(200);
    const restored = json<Todo>(await t.call("GET", "/api/v1/todos/7"));
    expect(restored.requestedBy).toEqual([
      {
        id: 1,
        firstName: "Anna",
        lastName: "Meier",
        displayName: "Anna Meier",
        note: "",
        team: "",
        email: "",
      },
    ]);
    expect(json<{ total: number }>(await t.call("GET", "/api/v1/todos?status=all")).total).toBe(1);
    expect(readdirSync(join(t.dataDir, "attachments"))).toEqual([]);
    // Ids are not reused even though format 1 has no sequences: the next todo comes after 7.
    expect((await t.create<Todo>("/api/v1/todos", { title: "n" })).id).toBe(8);
  });
});

const restart = async (t: TestApp) => {
  const config = {
    ...loadConfig({ ORGANIZER_DATA_DIR: t.dataDir, ORGANIZER_TZ: "Europe/Zurich" }),
    webDir: t.webDir,
  };
  const second = await buildApp({ config, clock: () => new Date("2026-11-11T12:00:00.000Z") });
  await second.app.close();
};

/** A restore that committed its transaction: staging folder with the new files plus the marker. */
function committed(t: TestApp, uploadId: string) {
  const staging = join(t.dataDir, `attachments.restore-${uploadId}`);
  mkdirSync(staging);
  writeFileSync(join(staging, "1"), "new");
  writeFileSync(join(t.dataDir, "attachments", "1"), "old");
  setSetting(t.deps.db, "restoreInProgress", { uploadId, stagingDir: staging });
  return staging;
}

describe("start-up recovery", () => {
  it("finishes the folder swap when the crash came right after the commit", async () => {
    const t = await makeApp();
    const id = "a".repeat(32);
    const staging = committed(t, id);
    await restart(t);
    expect(readFileSync(join(t.dataDir, "attachments", "1"), "utf8")).toBe("new");
    expect(existsSync(staging)).toBe(false);
    expect(existsSync(join(t.dataDir, `attachments.old-${id}`))).toBe(false);
    expect(
      t.deps.db.$client.prepare("SELECT count(*) AS n FROM settings WHERE key = 'restoreInProgress'").get(),
    ).toEqual({ n: 0 });
  });

  it("finishes the folder swap when the crash came between the two renames", async () => {
    const t = await makeApp();
    const id = "b".repeat(32);
    committed(t, id);
    const { renameSync } = await import("node:fs");
    renameSync(join(t.dataDir, "attachments"), join(t.dataDir, `attachments.old-${id}`));
    await restart(t);
    expect(readFileSync(join(t.dataDir, "attachments", "1"), "utf8")).toBe("new");
    expect(existsSync(join(t.dataDir, `attachments.old-${id}`))).toBe(false);
  });

  it("removes leftover staging folders and expired uploads when no restore was running", async () => {
    const t = await makeApp();
    mkdirSync(join(t.dataDir, `attachments.restore-${"c".repeat(32)}`));
    const preview = json<RestorePreview>(await upload(t, await exportZip(t)));
    await restart(t); // 2 hours later: the staged upload has expired
    expect(readdirSync(t.dataDir).filter((n) => n.startsWith("attachments."))).toEqual([]);
    expect(existsSync(join(t.dataDir, "restore", `${preview.uploadId}.zip`))).toBe(false);
  });
});
