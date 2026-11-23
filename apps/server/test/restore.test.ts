import type {
  BackupFile,
  MeetingTodos,
  Person,
  RestorePreview,
  RestoreResult,
  Settings,
  Todo,
} from "@organizer/shared";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp, VERSION } from "../src/app.ts";
import { attachmentFileName } from "../src/services/export.ts";
import { setSetting } from "../src/services/settings.ts";
import { fillEveryTable } from "./fixtures.ts";
import { json, makeApp, type TestApp } from "./helpers.ts";

type Files = Record<string, Uint8Array>;

const exportZip = async (t: Pick<TestApp, "call">): Promise<Buffer> => {
  const res = await t.call("GET", "/api/v1/export.zip");
  expect(res.statusCode).toBe(200);
  return res.rawPayload;
};

const upload = (t: Pick<TestApp, "call">, zip: Uint8Array, name = "sloppanizer-export.zip") =>
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
const todoSeries = (d: any) => d.series.find((s: { owner_kind: string }) => s.owner_kind === "todo");

// oxlint-disable-next-line typescript/no-explicit-any
const problems = (res: { json: () => any }): string[] => res.json().error.details.problems;

/** Where the account's staged uploads, safety copies and restore folders live. */
const stagedZip = (t: TestApp, uploadId: string) =>
  join(t.dataDir, "restore", `${t.account.id}-${uploadId}.zip`);
const backupsOf = (t: TestApp) => join(t.config.backupDir, "accounts", String(t.account.id));
const filesRoot = (t: TestApp) => dirname(t.filesDir);

const dataOf = (zip: Uint8Array) => readJson(unzipSync(zip), "data.json");
const manifest = (zip: Uint8Array) => readJson(unzipSync(zip), "manifest.json");

describe("restore upload and preview", () => {
  it("checks a valid export and shows what it holds next to the data now", async () => {
    const t = await makeApp();
    await fillEveryTable(t);
    const zip = await exportZip(t);
    const res = await upload(t, zip, "C:\\Users\\x\\sloppanizer-export-20261111.zip");
    expect(res.statusCode).toBe(201);
    const preview = res.json() as RestorePreview;
    expect(preview).toMatchObject({
      fileName: "sloppanizer-export-20261111.zip",
      source: "sloppanizer",
      format: 8,
      exportedAt: "2026-11-11T10:00:00.000Z",
      appVersion: VERSION,
      schemaVersion: 21,
      attachments: { count: 1, bytes: 11, missing: [] },
      warnings: [],
      expiresAt: "2026-11-11T11:00:00.000Z",
    });
    expect(preview.uploadId).toMatch(/^[0-9a-f]{32}$/);
    expect(preview.inFile).toEqual(preview.now);
    expect(preview.inFile.todos).toBe(4);
    expect(json<RestorePreview>(await t.call("GET", `/api/v1/restore/${preview.uploadId}`))).toEqual(preview);
    const staged = stagedZip(t, preview.uploadId);
    expect(statSync(staged).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(staged)).mode & 0o777).toBe(0o700);
    // No scratch database is left behind.
    expect(readdirSync(dirname(staged)).filter((n) => n.includes(".db"))).toEqual([]);

    // A new upload replaces the staged one; staged uploads expire after an hour.
    const second = json<RestorePreview>(await upload(t, zip));
    expect((await t.call("GET", `/api/v1/restore/${preview.uploadId}`)).statusCode).toBe(404);
    t.advance(61 * 60_000);
    expect((await t.call("GET", `/api/v1/restore/${second.uploadId}`)).statusCode).toBe(404);
    expect(existsSync(stagedZip(t, second.uploadId))).toBe(false);
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
      /Sloppanizer export/,
    );
    await check(
      rework(zip, (m) => (m.format = 9)),
      /format 9 of app "sloppanizer" is not known/,
    );
    await check(
      rework(zip, (m) => (m.schemaVersion = 99)),
      /newer Sloppanizer/,
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

    // A bomb: data.json claims a huge file, the zip directory a tiny one, the data inflates to much more.
    // It is refused before anything is unpacked.
    const bomb = rework(zip, (_m, d, files) => {
      files[name] = new Uint8Array(4 * 1024 * 1024);
      d.attachments.find((a: { id: number }) => a.id === file.id).size = 4 * 1024 ** 3;
    });
    const lying = Buffer.from(bomb);
    const central = lying.lastIndexOf(Buffer.from(name)) - 46;
    expect(lying.readUInt32LE(central)).toBe(0x02014b50);
    lying.writeUInt32LE(11, central + 24);
    expect(problems(await upload(t, lying)).join()).toMatch(
      /has 11 bytes in the archive, but data\.json says 4294967296/,
    );

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
    expect(readdirSync(t.filesDir)).toEqual([String(file.id)]);
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
  it("replaces everything, keeps tokens, saves a safety copy, and round trips", async () => {
    const t = await makeApp();
    const { todo, file } = await fillEveryTable(t);
    const original = await exportZip(t);
    const originalFile = (await t.call("GET", `/api/v1/attachments/${file.id}`)).rawPayload;

    // Change things after the export.
    t.advance(60_000);
    await t.call("DELETE", `/api/v1/todos/${todo.id}`);
    const added = await t.create<Todo>("/api/v1/todos", { title: "Added later" });
    const mcp = t.token("mcp", "write");

    const preview = json<RestorePreview>(await upload(t, original));
    expect(preview.now.todos).toBe(4);
    const res = await t.call("POST", `/api/v1/restore/${preview.uploadId}/apply`, { confirm: "replace" });
    expect(res.statusCode).toBe(200);
    const result = res.json() as RestoreResult;
    expect(result.restoredAt).toBe("2026-11-11T10:01:00.000Z");
    expect(result.counts.todos).toBe(4);
    expect(result.safetyCopy.fileName).toBe("sloppanizer-before-restore-20261111-110100.zip");
    const copyPath = join(backupsOf(t), result.safetyCopy.fileName);
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
    // Tokens stay; the session keeps working.
    expect((await t.withToken(mcp, "GET", "/api/v1/me")).statusCode).toBe(200);
    const settings = json<Settings>(await t.call("GET", "/api/v1/settings"));
    expect(settings.lastExportAt).toBe("2026-11-11T10:00:00.000Z");
    // The staged upload and staging folders are gone.
    expect(readdirSync(join(t.dataDir, "restore"))).toEqual([]);
    expect(readdirSync(filesRoot(t)).filter((n) => n.startsWith("."))).toEqual([]);

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
      (await t.call("GET", "/api/v1/restore/backups/sloppanizer-before-restore-20990101-000000.zip"))
        .statusCode,
    ).toBe(404);
  });

  it("merges names that differ only in non-ASCII case from an older export and ignores name keys in the file", async () => {
    const t = await makeApp();
    await fillEveryTable(t);
    const at = "2026-11-01T10:00:00.000Z";
    const zip = rework(await exportZip(t), (_m, d) => {
      const anna = d.people.find((p: { first_name: string }) => p.first_name === "Anna");
      const bo = d.people.find((p: { first_name: string }) => p.first_name === "Bo");
      // An export from before the fix could hold both spellings.
      d.topics.push({ id: 90, name: "Ärzte", created_at: at }, { id: 91, name: "ärzte", created_at: at });
      d.person_topics.push(
        { person_id: anna.id, topic_id: 90, created_at: at },
        { person_id: anna.id, topic_id: 91, created_at: at },
        { person_id: bo.id, topic_id: 91, created_at: at },
      );
      // A key in the file is never trusted: it is computed again.
      d.labels[0].name_key = "something else";
    });
    const preview = json<RestorePreview>(await upload(t, zip));
    expect(preview.inFile.topics).toBe(3);
    expect(
      (await t.call("POST", `/api/v1/restore/${preview.uploadId}/apply`, { confirm: "replace" })).statusCode,
    ).toBe(200);
    const topics = json<{ name: string; peopleCount: number }[]>(await t.call("GET", "/api/v1/topics"));
    expect(topics).toEqual([
      expect.objectContaining({ name: "Ärzte", peopleCount: 2 }),
      expect.objectContaining({ name: "dns" }),
    ]);
    const labels = t.deps.db.$client
      .prepare("SELECT name, name_key FROM labels WHERE account_id = ?")
      .all(t.account.id) as {
      name: string;
      name_key: string;
    }[];
    expect(labels.every((l) => l.name_key === l.name.toLowerCase())).toBe(true);
    // The merged topic is in the search index under the remaining spelling.
    expect(
      json<{ counts: { person: number } }>(
        await t.call("GET", `/api/v1/search?q=${encodeURIComponent("ärzte")}`),
      ).counts.person,
    ).toBe(2);
  });

  it("takes type and name of restored attachments from the file, never from data.json", async () => {
    const t = await makeApp();
    const html = Buffer.from("<script>alert(1)</script>");
    const up = await t.call("POST", "/api/v1/attachments?name=page.html", html, {
      "content-type": "text/html",
    });
    const page = up.json() as { id: number; name: string };
    const { file } = await fillEveryTable(t);
    const crafted = "../x<i>.html";
    const zip = rework(await exportZip(t), (_m, d, files) => {
      for (const row of d.attachments) {
        // A crafted export: HTML served as HTML, and a name with markup and path parts.
        if (row.id === page.id) Object.assign(row, { mime_type: "text/html", name: crafted });
        if (row.id === file.id) row.mime_type = "text/html";
      }
      files[`attachments/${attachmentFileName({ id: page.id, name: crafted })}`] = files[
        `attachments/${page.id}-${page.name}`
      ] as Uint8Array;
      delete files[`attachments/${page.id}-${page.name}`];
    });
    const preview = json<RestorePreview>(await upload(t, zip));
    expect(
      (await t.call("POST", `/api/v1/restore/${preview.uploadId}/apply`, { confirm: "replace" })).statusCode,
    ).toBe(200);
    const meta = json<{ name: string; mimeType: string }>(
      await t.call("GET", `/api/v1/attachments/${page.id}/meta`),
    );
    expect(meta).toMatchObject({ name: "x-i-.html", mimeType: "application/octet-stream" });
    const served = await t.call("GET", `/api/v1/attachments/${page.id}`);
    expect(served.headers["content-type"]).toBe("application/octet-stream");
    expect(served.headers["content-disposition"]).toMatch(/^attachment;/);
    // The real PNG gets its type back from its bytes.
    expect(
      json<{ mimeType: string }>(await t.call("GET", `/api/v1/attachments/${file.id}/meta`)).mimeType,
    ).toBe("image/png");
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
    expect(readdirSync(backupsOf(t)).toSorted()).toEqual(names.slice(1).toSorted());
  });

  it("restores a format 5 export, which has no meetings, and refuses meeting tables in it", async () => {
    const t = await makeApp();
    await fillEveryTable(t);
    const zip = await exportZip(t);
    const meetingTables = [
      "meetings",
      "series",
      "series_exceptions",
      "meeting_notes",
      "standup_marks",
      "meeting_todos",
    ];
    const format5 = rework(zip, (m, d) => {
      m.format = 5;
      m.schemaVersion = 14;
      for (const table of meetingTables) {
        delete d[table];
        delete m.counts[table];
      }
      delete m.sequences.meetings;
      delete m.sequences.series;
    });
    const preview = json<RestorePreview>(await upload(t, format5));
    expect(preview).toMatchObject({ format: 5, source: "sloppanizer", warnings: [] });
    expect(Object.keys(preview.inFile)).not.toContain("meetings");
    const applied = await t.call("POST", `/api/v1/restore/${preview.uploadId}/apply`, { confirm: "replace" });
    expect(applied.statusCode).toBe(200);
    expect(json<unknown[]>(await t.call("GET", "/api/v1/meetings"))).toEqual([]);
    expect(json<{ total: number }>(await t.call("GET", "/api/v1/todos?status=all")).total).toBe(4);

    const withMeetings = rework(zip, (m) => {
      m.format = 5;
    });
    const refused = await upload(t, withMeetings);
    expect(refused.statusCode).toBe(422);
    expect(problems(refused)).toContain('data.json has a table "meetings" that format 5 does not have.');
    const missing = await upload(
      t,
      rework(zip, (_m, d) => {
        delete d.standup_marks;
      }),
    );
    expect(problems(missing)).toContain('data.json misses the table "standup_marks".');
  });

  it("restores a format 6 export, which has no todos on meetings, and refuses them in it", async () => {
    const t = await makeApp();
    const { meeting } = await fillEveryTable(t);
    const zip = await exportZip(t);
    const format6 = rework(zip, (m, d) => {
      m.format = 6;
      m.schemaVersion = 15;
      delete d.meeting_todos;
      delete m.counts.meeting_todos;
    });
    const preview = json<RestorePreview>(await upload(t, format6));
    expect(preview).toMatchObject({ format: 6, source: "sloppanizer", warnings: [] });
    const applied = await t.call("POST", `/api/v1/restore/${preview.uploadId}/apply`, { confirm: "replace" });
    expect(applied.statusCode).toBe(200);
    expect(json<unknown[]>(await t.call("GET", "/api/v1/meetings"))).toHaveLength(1);
    expect(json<MeetingTodos>(await t.call("GET", `/api/v1/meetings/${meeting.id}/todos`)).items).toEqual([]);

    const withTodos = await upload(
      t,
      rework(zip, (m) => {
        m.format = 6;
      }),
    );
    expect(withTodos.statusCode).toBe(422);
    expect(problems(withTodos)).toContain(
      'data.json has a table "meeting_todos" that format 6 does not have.',
    );
    const missing = await upload(
      t,
      rework(zip, (_m, d) => {
        delete d.meeting_todos;
      }),
    );
    expect(problems(missing)).toContain('data.json misses the table "meeting_todos".');
  });

  it("restores a format 4 export, which has no web links, time blocks or meetings", async () => {
    const t = await makeApp();
    await fillEveryTable(t);
    const zip = await exportZip(t);
    const format4 = rework(zip, (m, d) => {
      m.format = 4;
      m.schemaVersion = 12;
      for (const table of [
        "todo_urls",
        "time_blocks",
        "meetings",
        "series",
        "series_exceptions",
        "meeting_notes",
        "standup_marks",
        "meeting_todos",
      ]) {
        delete d[table];
        delete m.counts[table];
      }
      for (const sequence of ["todo_urls", "time_blocks", "meetings", "series"]) delete m.sequences[sequence];
    });
    const preview = json<RestorePreview>(await upload(t, format4));
    expect(preview).toMatchObject({ format: 4, source: "sloppanizer", warnings: [] });
    const applied = await t.call("POST", `/api/v1/restore/${preview.uploadId}/apply`, { confirm: "replace" });
    expect(applied.statusCode).toBe(200);
    expect(json<unknown[]>(await t.call("GET", "/api/v1/meetings"))).toEqual([]);
    expect(json<{ total: number }>(await t.call("GET", "/api/v1/todos?status=all")).total).toBe(4);
  });

  it("refuses meeting rows the services could not read, and more meetings than an account may have", async () => {
    const t = await makeApp();
    await fillEveryTable(t);
    const zip = await exportZip(t);
    // oxlint-disable-next-line typescript/no-explicit-any
    const check = async (change: (data: any) => void, pattern: RegExp) => {
      const res = await upload(
        t,
        rework(zip, (_m, d) => change(d)),
      );
      expect(res.statusCode).toBe(422);
      expect(problems(res).join("\n")).toMatch(pattern);
    };
    await check((d) => (d.series[0].rule = '{"every":"fortnight"}'), /^series \d+: not a usable repeat/);
    await check((d) => (d.series[0].rule = '{"every":"day","basis":"done"}'), /not a usable repeat/);
    await check((d) => (d.series[0].ends_on = "9999-12-31"), /not a usable repeat/);
    await check((d) => (d.series[0].owner_kind = "block"), /owner_kind must be "meeting" or "todo"/);
    await check((d) => (todoSeries(d).todo_id = null), /todo_id is missing/);
    await check(
      (d) => (todoSeries(d).meeting_id = d.meetings[0].id),
      /a todo's planned time has no meeting_id/,
    );
    await check(
      (d) =>
        (d.series.find((s: { owner_kind: string }) => s.owner_kind === "meeting").todo_id =
          todoSeries(d).todo_id),
      /a meeting's repeat has no todo_id/,
    );
    await check((d) => {
      const part = todoSeries(d);
      d.series.push(...Array.from({ length: 50 }, (_, i) => ({ ...part, id: 1000 + i })));
    }, /the planned time of todo \d+ has more than 50 parts/);
    await check((d) => (d.meetings[0].filter = '{"projectIds":"all"}'), /filter is not a standup filter/);
    await check((d) => (d.meetings[0].since = "last week"), /since is not a UTC time/);
    await check((d) => (d.series_exceptions[0].start_at = "soon"), /a moved date needs start_at and end_at/);
    await check((d) => (d.standup_marks[0].covered_until = "now"), /covered_until and marked_at/);
    await check((d) => (d.meeting_notes[0].occurs_on = "12.11.2026"), /occurs_on is not a date/);
    await check((d) => (d.meeting_todos[0].added_at = "yesterday"), /added_at is not a UTC time/);
    await check((d) => {
      const [link] = d.meeting_todos;
      d.meeting_todos = Array.from({ length: 101 }, (_, i) => ({ ...link, todo_id: 1000 + i }));
    }, /meeting_todos: meeting \d+ has more than 100 todos/);
    await check((d) => {
      const [meeting] = d.meetings;
      d.meetings = Array.from({ length: 101 }, (_, i) => ({ ...meeting, id: 1000 + i }));
    }, /meetings: more than 100 meetings in one account/);
    // The account still has its meetings.
    expect(json<unknown[]>(await t.call("GET", "/api/v1/meetings"))).toHaveLength(1);
  });

  it("restores meetings with their dates, marks, note links and todos", async () => {
    const t = await makeApp();
    const { meeting } = await fillEveryTable(t);
    const before = {
      meeting: json<unknown>(await t.call("GET", `/api/v1/meetings/${meeting.id}`)),
      standup: json<unknown>(await t.call("GET", `/api/v1/meetings/${meeting.id}/standup?on=2026-11-12`)),
      notes: json<unknown>(await t.call("GET", `/api/v1/meetings/${meeting.id}/notes`)),
      todos: json<MeetingTodos>(await t.call("GET", `/api/v1/meetings/${meeting.id}/todos`)),
    };
    expect(before.todos.items).toHaveLength(1);
    const zip = await exportZip(t);
    await t.call("DELETE", `/api/v1/meetings/${meeting.id}`);
    const preview = json<RestorePreview>(await upload(t, zip));
    await t.call("POST", `/api/v1/restore/${preview.uploadId}/apply`, { confirm: "replace" });
    expect({
      meeting: json<unknown>(await t.call("GET", `/api/v1/meetings/${meeting.id}`)),
      standup: json<unknown>(await t.call("GET", `/api/v1/meetings/${meeting.id}/standup?on=2026-11-12`)),
      notes: json<unknown>(await t.call("GET", `/api/v1/meetings/${meeting.id}/notes`)),
      todos: json<MeetingTodos>(await t.call("GET", `/api/v1/meetings/${meeting.id}/todos`)),
    }).toEqual(before);
  });

  it("restores format 1 and 2 archives with defaults for newer columns and repairs scope labels", async () => {
    const t = await makeApp();
    await fillEveryTable(t);
    const zip = await exportZip(t);
    const format2 = rework(zip, (m, d) => {
      m.app = "organizer";
      m.format = 2;
      m.schemaVersion = 5;
      delete m.sequences;
      delete d.todo_links;
      delete d.todo_urls;
      delete d.time_blocks;
      for (const table of [
        "meetings",
        "series",
        "series_exceptions",
        "meeting_notes",
        "standup_marks",
        "meeting_todos",
      ])
        delete d[table];
      for (const row of d.todos) {
        delete row.recurrence;
        delete row.recurrence_prev_id;
      }
      // Older files name the comment author only; "you" is the session.
      for (const row of d.comments) delete row.author_kind;
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
    expect(t.deps.db.$client.prepare("SELECT DISTINCT actor, author_kind FROM comments").all()).toEqual([
      { actor: "you", author_kind: "session" },
    ]);

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
    // Columns the old format lacks get their defaults: no languages.
    expect(json<Person>(await t.call("GET", "/api/v1/people/1")).languages).toEqual([]);
    expect(json<{ total: number }>(await t.call("GET", "/api/v1/todos?status=all")).total).toBe(1);
    expect(readdirSync(t.filesDir)).toEqual([]);
    // Ids are not reused even though format 1 has no sequences: the next todo comes after 7.
    expect((await t.create<Todo>("/api/v1/todos", { title: "n" })).id).toBe(8);
  });
});

const withoutExportTime = (zip: Uint8Array) => {
  const data = dataOf(zip);
  return { ...data, settings: data.settings.filter((s: { key: string }) => s.key !== "lastExportAt") };
};

describe("restore between accounts", () => {
  it("leaves other accounts alone and hides one account's uploads and safety copies from another", async () => {
    const t = await makeApp();
    await fillEveryTable(t);
    const bo = await t.asAccount({ username: "bo" });
    await bo.call("POST", "/api/v1/todos", { title: "Bo's own todo" });
    await bo.call("POST", "/api/v1/attachments?name=bo.txt", Buffer.from("bo"), {
      "content-type": "text/plain",
    });
    const boBefore = await exportZip(bo);
    const boFiles = readdirSync(bo.filesDir).map((n) => [n, readFileSync(join(bo.filesDir, n))]);

    // Anna restores her own export (which has the same ids as Bo's rows).
    const preview = json<RestorePreview>(await upload(t, await exportZip(t)));
    for (const [method, url, body] of [
      ["GET", `/api/v1/restore/${preview.uploadId}`, undefined],
      ["DELETE", `/api/v1/restore/${preview.uploadId}`, undefined],
      ["POST", `/api/v1/restore/${preview.uploadId}/apply`, { confirm: "replace" }],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one call after the other
      expect((await bo.call(method, url, body)).statusCode).toBe(404);
    }
    const result = json<RestoreResult>(
      await t.call("POST", `/api/v1/restore/${preview.uploadId}/apply`, { confirm: "replace" }),
    );
    expect((await bo.call("GET", `/api/v1/restore/backups/${result.safetyCopy.fileName}`)).statusCode).toBe(
      404,
    );
    expect(json<BackupFile[]>(await bo.call("GET", "/api/v1/restore/backups"))).toEqual([]);

    // Bo's rows and files are exactly as before.
    expect(withoutExportTime(await exportZip(bo))).toEqual(withoutExportTime(boBefore));
    expect(readdirSync(bo.filesDir).map((n) => [n, readFileSync(join(bo.filesDir, n))])).toEqual(boFiles);
    expect(json<{ total: number }>(await bo.call("GET", "/api/v1/todos")).total).toBe(1);
  });

  it("refuses an export whose files pass the account's limit (422)", async () => {
    const source = await makeApp();
    await source.call("POST", "/api/v1/attachments?name=big.bin", Buffer.alloc(1024 * 1024 + 1, 1), {
      "content-type": "application/octet-stream",
    });
    const zip = await exportZip(source);
    const t = await makeApp({ env: { SLOPPANIZER_FILES_LIMIT_MB: "1" } });
    const res = await upload(t, zip);
    expect(res.statusCode).toBe(422);
    expect(problems(res).join()).toMatch(/more than this account's limit of 1 MB/);
  });
});

const restart = async (t: TestApp) => {
  const config = t.config;
  const second = await buildApp({ config, clock: () => new Date("2026-11-11T12:00:00.000Z") });
  await second.app.close();
};

const oldFolder = (t: TestApp, uploadId: string) => join(filesRoot(t), `.old-${t.account.id}-${uploadId}`);

/** A restore that committed its transaction: staging folder with the new files plus the marker. */
function committed(t: TestApp, uploadId: string) {
  const staging = join(filesRoot(t), `.restore-${t.account.id}-${uploadId}`);
  mkdirSync(staging);
  writeFileSync(join(staging, "1"), "new");
  writeFileSync(join(t.filesDir, "1"), "old");
  setSetting(t.ctx(), "restoreInProgress", { uploadId });
  return staging;
}

describe("start-up recovery", () => {
  it("finishes the folder swap when the crash came right after the commit", async () => {
    const t = await makeApp();
    const id = "a".repeat(32);
    const staging = committed(t, id);
    await restart(t);
    expect(readFileSync(join(t.filesDir, "1"), "utf8")).toBe("new");
    expect(existsSync(staging)).toBe(false);
    expect(existsSync(oldFolder(t, id))).toBe(false);
    expect(
      t.deps.db.$client
        .prepare("SELECT count(*) AS n FROM account_settings WHERE key = 'restoreInProgress'")
        .get(),
    ).toEqual({ n: 0 });
  });

  it("finishes the folder swap when the crash came between the two renames", async () => {
    const t = await makeApp();
    const id = "b".repeat(32);
    committed(t, id);
    const { renameSync } = await import("node:fs");
    renameSync(t.filesDir, oldFolder(t, id));
    await restart(t);
    expect(readFileSync(join(t.filesDir, "1"), "utf8")).toBe("new");
    expect(existsSync(oldFolder(t, id))).toBe(false);
  });

  it("removes leftover staging folders and expired uploads when no restore was running", async () => {
    const t = await makeApp();
    mkdirSync(join(filesRoot(t), `.restore-${t.account.id}-${"c".repeat(32)}`));
    const preview = json<RestorePreview>(await upload(t, await exportZip(t)));
    await restart(t); // 2 hours later: the staged upload has expired
    expect(readdirSync(filesRoot(t)).filter((n) => n.startsWith("."))).toEqual([]);
    expect(existsSync(stagedZip(t, preview.uploadId))).toBe(false);
  });
});
