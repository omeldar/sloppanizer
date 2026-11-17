import type { Comment, Note, Person, PersonTag, Topic } from "@organizer/shared";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { fillEveryTable } from "./fixtures.ts";
import { json, makeApp, type TestActor, type TestApp } from "./helpers.ts";

/** Anna's data in every table; Bobby is a fresh account on the same server. */
async function twoAccounts() {
  const t = await makeApp();
  const filled = await fillEveryTable(t);
  await t.call("POST", `/api/v1/todos/${filled.todo.id}/comments`, { bodyMd: "Rack secret comment" });
  const [note] = json<{ items: Note[] }>(await t.call("GET", "/api/v1/notes")).items;
  const [comment] = json<{ items: { type: string; comment?: Comment }[] }>(
    await t.call("GET", `/api/v1/todos/${filled.todo.id}/activity`),
  )
    .items.filter((i) => i.type === "comment")
    .map((i) => i.comment as Comment);
  const [tag] = json<PersonTag[]>(await t.call("GET", "/api/v1/person-tags"));
  const [topic] = json<Topic[]>(await t.call("GET", "/api/v1/topics"));
  const label = json<{ id: number; name: string }[]>(await t.call("GET", "/api/v1/labels")).find(
    (l) => l.name === "homelab",
  );
  const bobby = await t.asAccount({ username: "bobby" });
  return {
    t,
    bobby,
    ids: {
      todo: filled.todo.id,
      project: filled.project.id,
      person: filled.anna.id,
      file: filled.file.id,
      note: note?.id ?? 0,
      comment: comment?.id ?? 0,
      tag: tag?.id ?? 0,
      topic: topic?.id ?? 0,
      label: label?.id ?? 0,
    },
  };
}

const annaExport = async (t: TestApp) => {
  const data = JSON.parse(
    strFromU8(unzipSync((await t.call("GET", "/api/v1/export.zip")).rawPayload)["data.json"] as Uint8Array),
  );
  return { ...data, settings: data.settings.filter((s: { key: string }) => s.key !== "lastExportAt") };
};

const status = async (
  actor: TestActor,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  body?: unknown,
) => (await actor.call(method, url, body)).statusCode;

describe("accounts never see each other's data", () => {
  it("answers 404 for every route with another account's id and changes nothing", async () => {
    const { t, bobby, ids } = await twoAccounts();
    const before = await annaExport(t);
    const calls: [method: "GET" | "POST" | "PATCH" | "DELETE", url: string, body?: unknown][] = [
      ["GET", `/api/v1/todos/${ids.todo}`],
      ["PATCH", `/api/v1/todos/${ids.todo}`, { title: "taken" }],
      ["GET", `/api/v1/todos/${ids.todo}/activity`],
      ["POST", `/api/v1/todos/${ids.todo}/comments`, { bodyMd: "hi" }],
      ["POST", `/api/v1/todos/${ids.todo}/subtasks`, { titles: ["x"] }],
      ["POST", `/api/v1/todos/${ids.todo}/checklist`, { index: 0, checked: true }],
      ["DELETE", `/api/v1/todos/${ids.todo}`],
      ["PATCH", `/api/v1/comments/${ids.comment}`, { bodyMd: "changed" }],
      ["DELETE", `/api/v1/comments/${ids.comment}`],
      ["PATCH", `/api/v1/projects/${ids.project}`, { name: "taken" }],
      ["DELETE", `/api/v1/projects/${ids.project}`],
      ["GET", `/api/v1/notes/${ids.note}`],
      ["PATCH", `/api/v1/notes/${ids.note}`, { title: "taken" }],
      ["DELETE", `/api/v1/notes/${ids.note}`],
      ["GET", `/api/v1/people/${ids.person}`],
      ["PATCH", `/api/v1/people/${ids.person}`, { note: "taken" }],
      ["PATCH", `/api/v1/people/${ids.person}`, { languages: ["en"] }],
      ["DELETE", `/api/v1/people/${ids.person}`],
      ["GET", `/api/v1/stats/people/${ids.person}`],
      ["PATCH", `/api/v1/person-tags/${ids.tag}`, { name: "taken" }],
      ["DELETE", `/api/v1/person-tags/${ids.tag}`],
      ["PATCH", `/api/v1/topics/${ids.topic}`, { name: "taken" }],
      ["DELETE", `/api/v1/topics/${ids.topic}`],
      ["PATCH", `/api/v1/labels/${ids.label}`, { description: "taken" }],
      ["DELETE", `/api/v1/labels/${ids.label}`],
      ["GET", `/api/v1/attachments/${ids.file}`],
      ["GET", `/api/v1/attachments/${ids.file}/meta`],
    ];
    const results: [string, number][] = [];
    for (const [method, url, body] of calls) {
      // oxlint-disable-next-line no-await-in-loop -- one call after the other, the order matters for deletes
      results.push([`${method} ${url}`, await status(bobby, method, url, body)]);
    }
    expect(results.filter(([, code]) => code !== 404)).toEqual([]);
    expect(await annaExport(t)).toEqual(before);
  });

  it("refuses another account's ids inside bodies", async () => {
    const { t, bobby, ids } = await twoAccounts();
    const before = await annaExport(t);
    // Bobby's own todo is #1 like Anna's first one; #2 exists only for Anna.
    const own = json<{ id: number }>(await bobby.call("POST", "/api/v1/todos", { title: "Mine" }));
    const refused = [
      await status(bobby, "POST", "/api/v1/todos", { title: "x", projectId: ids.project }),
      await status(bobby, "POST", "/api/v1/todos", { title: "x", requestedBy: [{ personId: ids.person }] }),
      await status(bobby, "POST", "/api/v1/todos", { title: "x", parentId: ids.todo + 1 }),
      await status(bobby, "POST", `/api/v1/todos/${own.id}/links`, {
        links: [{ kind: "blocks", todoId: ids.todo + 1 }],
      }),
      await status(bobby, "POST", "/api/v1/notes", { title: "x", projectId: ids.project }),
    ];
    expect(refused.filter((code) => code !== 404 && code !== 422)).toEqual([]);
    expect(await annaExport(t)).toEqual(before);
  });

  it("lists, searches, counts and exports only the account's own rows", async () => {
    const { bobby } = await twoAccounts();
    expect(json<{ total: number }>(await bobby.call("GET", "/api/v1/todos?status=all")).total).toBe(0);
    expect(json<unknown[]>(await bobby.call("GET", "/api/v1/projects"))).toEqual([]);
    expect(json<{ items: unknown[] }>(await bobby.call("GET", "/api/v1/notes")).items).toEqual([]);
    expect(json<unknown[]>(await bobby.call("GET", "/api/v1/topics"))).toEqual([]);
    expect(json<unknown[]>(await bobby.call("GET", "/api/v1/person-tags"))).toEqual([]);
    const search = (await bobby.call("GET", "/api/v1/search?q=Rack")).json() as {
      counts: Record<string, number>;
    };
    expect(Object.values(search.counts).every((n) => n === 0)).toBe(true);
    const stats = (await bobby.call("GET", "/api/v1/stats")).json() as { open: number; inbox: number };
    expect([stats.open, stats.inbox]).toEqual([0, 0]);
    const zip = unzipSync((await bobby.call("GET", "/api/v1/export.zip")).rawPayload);
    const everything = Object.values(zip)
      .map((bytes) => strFromU8(bytes))
      .join("\n");
    for (const secret of ["Rack", "Müller", "Prefers chat", "shot.png", "Lab"]) {
      expect(everything).not.toContain(secret);
    }
  });

  it("keeps a person's languages to their account, even with the same person id", async () => {
    const { t, bobby, ids } = await twoAccounts();
    expect(json<Person>(await t.call("GET", `/api/v1/people/${ids.person}`)).languages).toEqual(["de"]);
    expect(json<unknown[]>(await bobby.call("GET", "/api/v1/people"))).toEqual([]);
    // Bobby's first person gets the same id as Anna's; each account sees and changes only its own.
    const own = await bobby.create<Person>("/api/v1/people", { firstName: "Bo", lastName: "Lind" });
    expect(own.id).toBe(ids.person);
    expect(own.languages).toEqual([]);
    expect(
      json<Person>(await bobby.call("PATCH", `/api/v1/people/${own.id}`, { languages: ["en"] })).languages,
    ).toEqual(["en"]);
    expect(
      json<Person[]>(await bobby.call("GET", "/api/v1/people")).map((p) => [p.lastName, p.languages]),
    ).toEqual([["Lind", ["en"]]]);
    expect(json<Person>(await t.call("GET", `/api/v1/people/${ids.person}`))).toMatchObject({
      lastName: "Müller",
      languages: ["de"],
    });
  });

  it("counts ids per account from 1", async () => {
    const { bobby } = await twoAccounts();
    expect(json<{ id: number }>(await bobby.call("POST", "/api/v1/todos", { title: "First" })).id).toBe(1);
  });

  it("leaves no row and no search entry behind when an account is deleted", async () => {
    const { t, bobby } = await twoAccounts();
    await fillEveryTable(bobby);
    const sqlite = t.deps.db.$client;
    const tables = (
      sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    )
      .map((r) => r.name)
      .filter((name) =>
        (sqlite.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]).some(
          (c) => c.name === "account_id",
        ),
      );
    const rowsOf = (accountId: number) =>
      Object.fromEntries(
        tables.map((name) => [
          name,
          (
            sqlite.prepare(`SELECT count(*) AS n FROM "${name}" WHERE account_id = ?`).get(accountId) as {
              n: number;
            }
          ).n,
        ]),
      );
    const annaBefore = rowsOf(t.account.id);
    const ftsRange = (accountId: number) =>
      (
        sqlite
          .prepare("SELECT count(*) AS n FROM search_fts WHERE rowid >= ? AND rowid < ?")
          .get(accountId * 2 ** 34, (accountId + 1) * 2 ** 34) as { n: number }
      ).n;
    expect(ftsRange(bobby.account.id)).toBeGreaterThan(0);

    const res = await bobby.call("DELETE", "/api/v1/account", { confirmUsername: "bobby" });
    expect(res.statusCode).toBe(204);
    expect(Object.values(rowsOf(bobby.account.id)).every((n) => n === 0)).toBe(true);
    expect(ftsRange(bobby.account.id)).toBe(0);
    expect(rowsOf(t.account.id)).toEqual(annaBefore);
  });
});
