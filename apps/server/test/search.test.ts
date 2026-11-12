import type { Person, SearchHit, SearchResult, Todo } from "@organizer/shared";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { rebuildSearchIndex } from "../src/services/search-index.ts";
import { findRanges, makeSnippet } from "../src/services/search.ts";
import { json, makeApp, type TestApp } from "./helpers.ts";

const find = async (t: TestApp, query: string) =>
  json<SearchResult>(await t.call("GET", `/api/v1/search?${query}`));
const q = (text: string) => `q=${encodeURIComponent(text)}`;
const hitsOf = (r: SearchResult, kind: SearchHit["kind"]) => r.items.filter((i) => i.kind === kind);
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const indexRows = (t: TestApp) =>
  t.deps.db.all(sql`SELECT rowid, kind, ref_id, todo_id, title, body FROM search_fts ORDER BY rowid`);

/** Every highlight lies inside the snippet and covers one of the terms. */
function expectGoodHighlights(result: SearchResult, terms: string[]) {
  for (const hit of result.items) {
    for (const [a, b] of hit.highlights) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(hit.snippet.length);
      expect(a).toBeLessThan(b);
      const covered = fold(hit.snippet.slice(a, b));
      expect(terms.some((term) => covered.includes(fold(term)))).toBe(true);
    }
  }
}

async function sample() {
  const t = await makeApp();
  const home = await t.create<{ id: number }>("/api/v1/projects", { name: "Homelab" });
  const todo = await t.create<Todo>("/api/v1/todos", {
    title: "Renew VPN certificate",
    descriptionMd: "Ask **Hans** about the gateway.",
  });
  await t.create("/api/v1/todos", { title: "Order cables", descriptionMd: "The VPN box needs two." });
  const comment = await t.create<{ id: number }>(`/api/v1/todos/${todo.id}/comments`, {
    bodyMd: "Hans Müller says the gateway runs firmware 7.",
  });
  const note = await t.create<{ id: number }>("/api/v1/notes", {
    title: "Router setup",
    bodyMd: "Gateway admin page is on port 8443.",
    projectId: home.id,
  });
  const hans = await t.create<Person>("/api/v1/people", {
    firstName: "Hans",
    lastName: "Müller",
    team: "Network team",
    email: "hans.mueller@example.com",
    topics: ["firewall rules", "VPN"],
  });
  return { t, todo, comment, note, hans };
}

describe("GET /search", () => {
  it("finds each kind with the details the lists show", async () => {
    const { t, todo, comment, note, hans } = await sample();
    const r = await find(t, q("gateway"));
    expect(r.q).toBe("gateway");
    expect(r.counts).toEqual({ todo: 1, note: 1, comment: 1, person: 0 });
    expect(hitsOf(r, "todo")[0]).toMatchObject({
      id: todo.id,
      title: "Renew VPN certificate",
      todoId: todo.id,
      status: "open",
      subtitle: null,
      snippet: "Ask Hans about the gateway.",
      highlights: [[19, 26]],
    });
    expect(hitsOf(r, "comment")[0]).toMatchObject({
      id: comment.id,
      title: "Renew VPN certificate",
      todoId: todo.id,
      status: null,
      subtitle: "you, 2026-11-11 11:00",
    });
    expect(hitsOf(r, "note")[0]).toMatchObject({
      id: note.id,
      title: "Router setup",
      subtitle: "Homelab",
      todoId: null,
    });
    // Kinds come grouped in a fixed order.
    expect(r.items.map((i) => i.kind)).toEqual(["todo", "note", "comment"]);

    const people = await find(t, q("firewall"));
    expect(hitsOf(people, "person")[0]).toMatchObject({
      id: hans.id,
      title: "Hans Müller",
      subtitle: "Network team | firewall rules, VPN",
      todoId: null,
    });
  });

  it("folds umlauts and case, and ANDs the terms", async () => {
    const { t, hans } = await sample();
    const r = await find(t, q("MULLER"));
    expect(hitsOf(r, "person").map((h) => h.id)).toEqual([hans.id]);
    expect(r.counts.comment).toBe(1);
    expectGoodHighlights(r, ["muller"]);
    expect((await find(t, q("hans gateway"))).counts).toEqual({ todo: 1, note: 0, comment: 1, person: 0 });
    expect((await find(t, q("hans nothing-like-this"))).items).toEqual([]);
  });

  it("falls back to LIKE for terms shorter than three characters", async () => {
    const { t } = await sample();
    const r = await find(t, q("VP"));
    expect(r.counts).toEqual({ todo: 2, note: 0, comment: 0, person: 1 });
    expectGoodHighlights(r, ["VP"]);
    expect((await find(t, q("7"))).counts.comment).toBe(1);
    // Mixed: one FTS term and one short term.
    expect((await find(t, q("gateway 84"))).counts).toEqual({ todo: 0, note: 1, comment: 0, person: 0 });
    // LIKE wildcards in a short term are literal.
    expect((await find(t, q("%"))).items).toEqual([]);
    expect((await find(t, q("_"))).items).toEqual([]);
  });

  it("treats quotes and FTS syntax in q as plain text", async () => {
    const { t } = await sample();
    const texts = [
      '"',
      '"gateway',
      'gateway"',
      "gateway OR cables",
      "NEAR(gateway cables)",
      "*",
      "-gateway",
      "title:secret",
      "a AND",
      "(((",
      "^gate",
    ];
    const statuses = await Promise.all(
      texts.map(async (text) => [text, (await t.call("GET", `/api/v1/search?${q(text)}`)).statusCode]),
    );
    expect(statuses).toEqual(texts.map((text) => [text, 200]));
    expect((await find(t, q("gateway OR cables"))).items).toEqual([]);
    const quoted = await t.create<Todo>("/api/v1/todos", { title: 'Fix the "gateway" quote' });
    expect(hitsOf(await find(t, q('"gateway"')), "todo").map((h) => h.id)).toEqual([quoted.id]);
  });

  it("returns todo #id first, also when its text does not match", async () => {
    const { t, todo } = await sample();
    const other = await t.create<Todo>("/api/v1/todos", { title: `Mentions ${todo.id} in the title` });
    const r = await find(t, q(`#${todo.id}`));
    expect(hitsOf(r, "todo").map((h) => h.id)).toEqual([todo.id]);
    expect(r.counts.todo).toBe(1);
    const plain = await find(t, q(String(todo.id)));
    expect(hitsOf(plain, "todo").map((h) => h.id)).toEqual([todo.id, other.id]);
    expect(plain.counts.todo).toBe(2);
    expect((await find(t, q("#999"))).items).toEqual([]);
    expect(hitsOf(await find(t, `${q(`#${todo.id}`)}&kinds=note`), "todo")).toEqual([]);
  });

  it("ranks title matches first, limits per kind and counts all", async () => {
    const t = await makeApp();
    const bodyOnly = await t.create<Todo>("/api/v1/todos", {
      title: "Other",
      descriptionMd: "switch config",
    });
    const inTitle = await t.create<Todo>("/api/v1/todos", { title: "Switch config backup" });
    const shortTitle = await t.create<Todo>("/api/v1/todos", { title: "Old switch" });
    const r = await find(t, q("switch"));
    // Title matches (shorter titles rank higher in bm25) before the body-only match.
    expect(hitsOf(r, "todo").map((h) => h.id)).toEqual([shortTitle.id, inTitle.id, bodyOnly.id]);
    const limited = await find(t, `${q("switch")}&limit=1`);
    expect(hitsOf(limited, "todo")).toHaveLength(1);
    expect(limited.counts.todo).toBe(3);
    const notesOnly = await find(t, `${q("switch")}&kinds=note,person`);
    expect(notesOnly.items).toEqual([]);
    expect(notesOnly.counts).toEqual({ todo: 0, note: 0, comment: 0, person: 0 });
    expect((await t.call("GET", "/api/v1/search")).statusCode).toBe(422);
    expect((await t.call("GET", "/api/v1/search?q=%20")).statusCode).toBe(422);
  });

  it("keeps the index in step with edits and deletes", async () => {
    const { t, todo, note, hans } = await sample();
    await t.call("PATCH", `/api/v1/todos/${todo.id}`, { title: "Replace router" });
    expect((await find(t, q("certificate"))).counts.todo).toBe(0);
    expect((await find(t, q("router"))).counts.todo).toBe(1);
    await t.call("PATCH", `/api/v1/people/${hans.id}`, { removeTopics: ["firewall rules"] });
    expect((await find(t, q("firewall"))).counts.person).toBe(0);
    await t.call("DELETE", `/api/v1/notes/${note.id}`);
    expect((await find(t, q("8443"))).counts.note).toBe(0);
    await t.call("DELETE", `/api/v1/todos/${todo.id}`);
    // The todo's comment goes with it.
    expect((await find(t, q("firmware"))).counts.comment).toBe(0);
    await t.call("PATCH", `/api/v1/todos/2`, { requestedBy: [] });
    expect((await t.call("DELETE", `/api/v1/people/${hans.id}`)).statusCode).toBe(204);
    expect((await find(t, q("hans"))).counts.person).toBe(0);
  });

  it("gives the same index after a rebuild as after incremental updates", async () => {
    const { t, todo, hans } = await sample();
    const c = await t.create<{ id: number }>(`/api/v1/todos/${todo.id}/comments`, { bodyMd: "first" });
    await t.call("PATCH", `/api/v1/comments/${c.id}`, { bodyMd: "edited comment" });
    await t.call("PATCH", `/api/v1/todos/${todo.id}`, { descriptionMd: "new description" });
    await t.call("PATCH", `/api/v1/people/${hans.id}`, { email: "", note: "Basel", addTopics: ["SAP"] });
    const topics = json<{ id: number; name: string }[]>(await t.call("GET", "/api/v1/topics"));
    await t.call("PATCH", `/api/v1/topics/${topics.find((x) => x.name === "VPN")?.id}`, {
      name: "VPN access",
    });
    await t.create("/api/v1/todos", { title: "x", requestedBy: [{ firstName: "Eva", lastName: "Keller" }] });
    const before = indexRows(t);
    const results = await Promise.all(["vpn", "basel", "edited", "keller", "ga"].map((x) => find(t, q(x))));
    rebuildSearchIndex(t.deps.db);
    expect(indexRows(t)).toEqual(before);
    expect(await Promise.all(["vpn", "basel", "edited", "keller", "ga"].map((x) => find(t, q(x))))).toEqual(
      results,
    );
  });

  it("rebuilds the index at server start", async () => {
    const { t } = await sample();
    t.deps.db.run(sql`DELETE FROM search_fts`);
    expect((await find(t, q("gateway"))).items).toEqual([]);
    const second = await buildApp({
      config: {
        ...loadConfig({ ORGANIZER_DATA_DIR: t.dataDir, ORGANIZER_TZ: "Europe/Zurich" }),
        webDir: t.webDir,
      },
    });
    await second.app.close();
    expect((await find(t, q("gateway"))).counts).toEqual({ todo: 1, note: 1, comment: 1, person: 0 });
  });

  it("is open to read tokens", async () => {
    const { t } = await sample();
    const reader = t.token("reader", "read");
    expect((await t.withToken(reader, "GET", `/api/v1/search?${q("gateway")}`)).statusCode).toBe(200);
  });
});

describe("snippets and highlights", () => {
  it("cuts about 120 characters around the first match", () => {
    const text = `${"lorem ipsum ".repeat(20)}the GATEWAY is here ${"dolor sit ".repeat(20)}`;
    const { snippet, highlights } = makeSnippet(text, ["gateway"]);
    expect(snippet.startsWith("...")).toBe(true);
    expect(snippet.endsWith("...")).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(126);
    expect(highlights).toHaveLength(1);
    const [a, b] = highlights[0] as [number, number];
    expect(snippet.slice(a, b)).toBe("GATEWAY");
  });

  it("finds folded matches at the right positions and merges overlaps", () => {
    expect(findRanges("Hans Müller, MÜLLER", ["muller"])).toEqual([
      [5, 11],
      [13, 19],
    ]);
    expect(findRanges("abcdef", ["abc", "bcd"])).toEqual([[0, 4]]);
    // The emoji is two UTF-16 units; ranges are string indices the web can slice with.
    expect(findRanges("emoji 😀 then vpn", ["vpn"])).toEqual([[14, 17]]);
    expect("emoji 😀 then vpn".slice(14, 17)).toBe("vpn");
    expect(makeSnippet("short text", ["nothing"])).toEqual({ snippet: "short text", highlights: [] });
  });
});
