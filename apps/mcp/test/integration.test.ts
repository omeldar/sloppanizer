import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { addDays, type Todo, toLocalDate } from "@organizer/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { systemClock } from "../../server/src/clock.ts";
import { openDb } from "../../server/src/db/index.ts";
import { findAccount } from "../../server/src/services/accounts.ts";
import { totpCode } from "../../server/src/services/auth/totp.ts";
import { createToken } from "../../server/src/services/tokens.ts";
import { bundle } from "../scripts/build.ts";

// The real server on a free port with a temp data dir, the bundled MCP server over stdio.
const TZ = "Europe/Zurich";
const TOKEN_NAME = "planner";
const SERVER_DIR = fileURLToPath(new URL("../../server", import.meta.url));

const PASSWORD = "violet tram drifts over 9 hills";
const TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const root = mkdtempSync(join(tmpdir(), "sloppanizer-mcp-it-"));
const dataDir = join(root, "data");
const tokenFile = join(root, "mcp-token");
const boTokenFile = join(root, "mcp-token-bo");
const dbFile = () => join(dataDir, "sloppanizer.db");
let annaAccountId = 0;
let accessToken = "";
const bundlePath = join(root, "mcp", "index.js");
const today = toLocalDate(new Date(), TZ);

let server: ChildProcess | undefined;
let baseUrl = "";
const clients: Client[] = [];

/**
 * A port nothing listens on right now. A fixed port clashed with other runs of this test (another
 * checkout, a second `pnpm test`) or a server already on it, which then answered in our place.
 */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/**
 * Waits until our server answers its health check, or fails as soon as it exits. No own deadline: how
 * long a start takes depends on the machine's load, and the beforeAll time limit catches a hang.
 */
async function waitForHealth(): Promise<void> {
  for (;;) {
    if (server?.exitCode !== null) throw new Error(`server exited with ${server?.exitCode}`);
    try {
      // oxlint-disable-next-line no-await-in-loop -- polling, one request at a time
      const response = await fetch(`${baseUrl}/api/v1/health`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    // oxlint-disable-next-line no-await-in-loop -- polling interval
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function connect(env: Record<string, string>): Promise<Client> {
  const client = new Client({ name: "integration-test", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [bundlePath], env, stderr: "pipe" }),
  );
  clients.push(client);
  return client;
}

let mcp: Client;

interface ToolResult {
  text: string;
  isError: boolean;
}

async function call(name: string, args: Record<string, unknown> = {}, client = mcp): Promise<ToolResult> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  return { text: content.map((c) => c.text).join("\n"), isError: result.isError === true };
}

async function ok(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await call(name, args);
  if (result.isError) throw new Error(`${name} failed: ${result.text}`);
  return result.text;
}

const idOf = (text: string): number => Number(/#(\d+)/.exec(text)?.[1]);

beforeAll(async () => {
  await bundle(bundlePath);
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["src/index.ts"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      SLOPPANIZER_PORT: String(port),
      SLOPPANIZER_DATA_DIR: dataDir,
      LOG_LEVEL: "warn",
      NODE_ENV: "test",
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  await waitForHealth();
  // Two accounts with the dev-account CLI, a write token each through the token service.
  const passwordFile = join(root, "password");
  writeFileSync(passwordFile, PASSWORD);
  for (const username of ["anna", "bobby"]) {
    const made = spawnSync(
      process.execPath,
      [
        "src/cli/dev-account.ts",
        username,
        "--password-file",
        passwordFile,
        "--totp-secret",
        TOTP_SECRET,
        "--time-zone",
        TZ,
      ],
      { cwd: SERVER_DIR, env: { ...process.env, SLOPPANIZER_DATA_DIR: dataDir }, encoding: "utf8" },
    );
    if (made.status !== 0) throw new Error(`dev-account failed: ${made.stderr}`);
  }
  const db = openDb(dbFile());
  try {
    for (const [username, name, file] of [
      ["anna", TOKEN_NAME, tokenFile],
      ["bobby", "bo-planner", boTokenFile],
    ] as const) {
      const account = findAccount(db, username);
      if (!account) throw new Error(`no account ${username}`);
      if (username === "anna") annaAccountId = account.id;
      const { raw } = createToken(db, systemClock, account.id, { name, scope: "write" });
      writeFileSync(file, raw, { mode: 0o600 });
    }
  } finally {
    db.$client.close();
  }
  // A browser session of anna for the calls the web app makes.
  const login = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "anna", password: PASSWORD, code: totpCode(TOTP_SECRET, Date.now()) }),
  });
  if (login.status !== 200) throw new Error(`login failed: ${login.status} ${await login.text()}`);
  accessToken = ((await login.json()) as { accessToken: string }).accessToken;
  mcp = await connect({ SLOPPANIZER_URL: baseUrl, SLOPPANIZER_TOKEN_FILE: tokenFile, SLOPPANIZER_TZ: TZ });
}, 60_000);

afterAll(async () => {
  await Promise.all(clients.map((client) => client.close()));
  if (server && server.exitCode === null) {
    const exited = new Promise((resolve) => server?.once("exit", resolve));
    server.kill("SIGTERM");
    await exited;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("MCP server against the real API", () => {
  it("uses a token file only the owner can read", () => {
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
  });

  it("offers every tool with a description", async () => {
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).toSorted()).toEqual(
      [
        "add_comment",
        "add_subtasks",
        "add_web_link",
        "remove_web_link",
        "list_plan",
        "plan_time",
        "move_block",
        "delete_block",
        "bulk_update",
        "check_item",
        "link_todos",
        "people_stats",
        "unlink_todos",
        "create_label",
        "create_note",
        "create_person",
        "create_project",
        "create_todo",
        "get_activity",
        "get_note",
        "get_person",
        "get_todo",
        "list_labels",
        "list_notes",
        "list_people",
        "list_person_tags",
        "list_projects",
        "list_todos",
        "list_topics",
        "mark_done",
        "next_up",
        "overview",
        "search",
        "update_note",
        "update_person",
        "update_todo",
      ].toSorted(),
    );
    for (const tool of tools) expect(tool.description?.length).toBeGreaterThan(40);
    // Restore, settings and tokens stay in the web app (the API answers 403 to tokens anyway).
    expect(tools.map((t) => t.name).filter((name) => /restore|setting|token/.test(name))).toEqual([]);
    // The token is never a tool argument.
    expect(JSON.stringify(tools)).not.toMatch(/token/i);
  });

  it("plans and works through todos end to end", async () => {
    expect(await ok("create_label", { name: "homelab", color: "#3E8E7E" })).toBe("Created homelab | #3E8E7E");
    expect(await ok("create_project", { name: "Home lab", slug: "homelab" })).toMatch(
      /^Created id \d+ \| homelab \| Home lab \| 0 open$/,
    );

    const first = await ok("create_todo", {
      title: "Renew SSL certs",
      description: "Use **certbot**.",
      project: "homelab",
      dueOn: addDays(today, -2),
      labels: ["priority::high", "homelab"],
      requestedBy: ["Anna Meier"],
    });
    expect(first).toMatch(
      new RegExp(
        `^Created #\\d+ open \\| Renew SSL certs \\| priority::high, homelab \\| project homelab \\| due ${addDays(today, -2)} \\(overdue 2d\\) \\| open 0d \\| req: Anna Meier$`,
      ),
    );
    const a = idOf(first);

    // Same name again finds the same person instead of creating a second one.
    const second = await ok("create_todo", {
      title: "Call the plumber",
      requestedBy: [{ firstName: "anna", lastName: "meier" }],
    });
    expect(second).toContain("| inbox |");
    expect(second).toContain("req: Anna Meier");
    const b = idOf(second);
    const people = await ok("list_people");
    expect(people.split("\n")).toHaveLength(1);
    const annaId = Number(/person (\d+)/.exec(people)?.[1]);

    // Scoped label replaces its sibling; json gives the full object.
    const updated = JSON.parse(
      await ok("update_todo", { id: a, addLabels: ["priority::critical"], plannedOn: today, format: "json" }),
    ) as Todo;
    expect(updated.labels.map((l) => l.name)).toEqual(["priority::critical", "homelab"]);
    expect(updated.plannedOn).toBe(today);

    const detail = await ok("get_todo", { id: a });
    expect(detail).toContain(`requested by: Anna Meier (person ${annaId})`);
    expect(detail.endsWith("Use **certbot**.")).toBe(true);

    const listed = await ok("list_todos", { project: "homelab", labels: ["homelab"] });
    expect(listed.split("\n")[0]).toBe("1 of 1 todos:");
    expect(await ok("list_todos", { q: "plumber" })).toContain(`#${b} open | Call the plumber`);
    expect(await ok("list_todos", { project: "inbox" })).not.toContain(`#${a} `);

    const tomorrow = addDays(today, 1);
    const bulk = await ok("bulk_update", { ids: [a, b], plannedOn: tomorrow });
    expect(bulk.split("\n")[0]).toBe("Updated 2:");
    expect(bulk.match(new RegExp(`planned ${tomorrow}`, "g"))).toHaveLength(2);

    const next = await ok("next_up");
    const lines = next.split("\n");
    expect(lines[0]).toBe(`Next up (smart), today ${today}:`);
    expect(lines[1]).toMatch(new RegExp(`^1\\. #${a} open .*\\| why: .*overdue 2d`));
    expect(lines[1]).toContain("priority::critical");

    const overview = await ok("overview");
    expect(overview).toContain(`Today ${today} (${TZ})`);
    expect(overview).toContain("- inbox: 1");
    expect(overview).toContain("- homelab (Home lab): 1");
    expect(overview).toMatch(new RegExp(`Without priority \\(1\\):\\n#${b} open \\| Call the plumber`));

    expect(await ok("list_projects")).toMatch(/\| homelab \| Home lab \| 1 open$/);
    expect(await ok("list_labels")).toContain("priority::critical | #F2555A | rank 0");

    const done = await ok("mark_done", { ids: [a] });
    expect(done).toMatch(new RegExp(`^Done:\\n#${a} done \\| .* \\| done ${today}, took 0m`));
    expect(await ok("list_todos")).not.toContain(`#${a} `);
    expect(await ok("list_todos", { status: "all" })).toContain(`#${a} done`);

    // Every change is recorded with the token name as actor.
    const db = new DatabaseSync(dbFile(), { readOnly: true });
    try {
      const actors = db
        .prepare("SELECT DISTINCT actor FROM events WHERE account_id = ?")
        .all(annaAccountId) as {
        actor: string;
      }[];
      expect(actors).toEqual([{ actor: TOKEN_NAME }]);
      const kinds = db
        .prepare("SELECT kind FROM events WHERE account_id = ? AND todo_id = ? ORDER BY id")
        .all(annaAccountId, a)
        .map((row) => (row as { kind: string }).kind);
      // One PATCH may record several events in any order; compare as a multiset.
      expect(kinds[0]).toBe("created");
      expect(kinds.toSorted()).toEqual(
        ["created", "dates_changed", "dates_changed", "labels_changed", "status_changed"].toSorted(),
      );
    } finally {
      db.close();
    }
  });

  it("returns readable errors the assistant can act on", async () => {
    const unknownLabel = await call("create_todo", { title: "x", labels: ["nope"] });
    expect(unknownLabel.isError).toBe(true);
    expect(unknownLabel.text).toContain("nope");
    expect(unknownLabel.text).toContain("create_label adds one");

    const unknownProject = await call("create_todo", { title: "x", project: "garden" });
    expect(unknownProject).toEqual({
      isError: true,
      text: 'No project "garden". list_projects shows them; create_project adds one.',
    });

    const oneWord = await call("create_todo", { title: "x", requestedBy: ["Anna"] });
    expect(oneWord.isError).toBe(true);
    expect(oneWord.text).toContain("needs a first and a last name");

    const duplicate = await call("create_person", { firstName: "Anna", lastName: "Meier" });
    expect(duplicate.isError).toBe(true);
    expect(duplicate.text).toMatch(/Existing: person \d+ \| Anna Meier/);

    expect(
      await ok("create_person", { firstName: "Anna", lastName: "Meier", note: "IT", allowDuplicate: true }),
    ).toMatch(/^Created person \d+ \| Anna Meier \| note: IT$/);
    const ambiguous = await call("create_todo", { title: "x", requestedBy: ["Anna Meier"] });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.text).toContain("Candidates (pass one as a person id):");
    expect(ambiguous.text).toContain("Anna Meier | note: IT");

    const missing = await call("get_todo", { id: 99_999 });
    expect(missing.isError).toBe(true);
  });

  it("says when Sloppanizer is not reachable", async () => {
    const down = await connect({
      SLOPPANIZER_URL: "http://127.0.0.1:4899",
      SLOPPANIZER_TOKEN_FILE: tokenFile,
    });
    expect(await call("next_up", {}, down)).toEqual({
      isError: true,
      text: "Sloppanizer is not reachable at http://127.0.0.1:4899. Check the URL and your network.",
    });
  });

  it("sees only the token's own account", async () => {
    const bo = await connect({
      SLOPPANIZER_URL: baseUrl,
      SLOPPANIZER_TOKEN_FILE: boTokenFile,
      SLOPPANIZER_TZ: TZ,
    });
    const created = await call("create_todo", { title: "Bo's secret plan" }, bo);
    expect(created.isError).toBe(false);
    const boTodo = idOf(created.text);
    expect((await call("overview", {}, bo)).text).toMatch(/^Account bobby\n/);
    expect(await ok("overview")).toMatch(/^Account anna\n/);
    expect(await ok("list_todos", { status: "all" })).not.toContain("Bo's secret plan");
    expect(await ok("search", { q: "secret" })).not.toContain("Bo's secret plan");
    expect((await call("list_todos", { status: "all" }, bo)).text).not.toContain("Renew SSL certs");
    // Ids count per account: anna's own #<same id> is hers, never bo's.
    const sameId = await call("get_todo", { id: boTodo });
    expect(sameId.text).not.toContain("Bo's secret plan");
  });

  it("says where the token file should be when it is missing", async () => {
    const noToken = await connect({
      SLOPPANIZER_URL: baseUrl,
      SLOPPANIZER_TOKEN_FILE: join(root, "missing"),
    });
    const result = await call("overview", {}, noToken);
    expect(result.isError).toBe(true);
    expect(result.text).toContain(`No API token at ${join(root, "missing")}`);
  });
});

/** A REST call as the browser session or with the MCP token. */
async function rest(as: "session" | "token", method: string, path: string, body?: unknown) {
  const auth =
    as === "session"
      ? { authorization: `Bearer ${accessToken}` }
      : { authorization: `Bearer ${readFileSync(tokenFile, "utf8").trim()}` };
  const response = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers: { ...auth, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    json: text ? (JSON.parse(text) as Record<string, unknown>) : undefined,
  };
}

// Step 2: contacts, the thread, notes and search. Builds on the data of the tests above (Anna Meier twice,
// project homelab), so it avoids those names.
describe("step 2 tools against the real API", () => {
  let maxId = 0;
  let todoId = 0;

  it("finds whom to ask and links them as contacts end to end", async () => {
    // Person tags are made by the user first (Labels page); the MCP server can only use them.
    expect(
      (await rest("session", "POST", "/person-tags", { name: "fast reply", color: "#3E8E7E" })).status,
    ).toBe(201);
    const unknownTag = await call("create_person", { firstName: "Tim", lastName: "Roth", tags: ["slow"] });
    expect(unknownTag.isError).toBe(true);
    expect(unknownTag.text).toContain("list_person_tags shows the person tags");

    const max = await ok("create_person", {
      firstName: "Max",
      lastName: "Muster",
      note: "Basel",
      team: "Network team",
      email: "max.muster@example.com",
      topics: ["firewall rules", "  VPN "],
      tags: ["fast reply"],
    });
    expect(max).toMatch(
      /^Created person \d+ \| Max Muster \| Network team \| topics: firewall rules, VPN \| tags: fast reply \| note: Basel$/,
    );
    maxId = Number(/person (\d+)/.exec(max)?.[1]);
    await ok("create_person", {
      firstName: "Eva",
      lastName: "Keller",
      team: "network team",
      topics: ["SAP access"],
    });

    const byTopic = await ok("list_people", { topic: ["FIREWALL RULES"] });
    expect(byTopic.split("\n")).toEqual([
      expect.stringMatching(new RegExp(`^person ${maxId} \\| Max Muster `)),
    ]);
    expect((await ok("list_people", { team: "NETWORK TEAM" })).split("\n")).toHaveLength(2);
    expect(await ok("list_people", { q: "vpn" })).toContain("Max Muster");
    expect(await ok("list_people", { tag: ["fast reply"], topic: ["SAP access"] })).toBe(
      "No people match. Fewer filters, or list_topics, show what is there.",
    );
    expect(await ok("list_topics")).toMatch(
      /^topic \d+ \| firewall rules \| 1 person\ntopic \d+ \| SAP access/,
    );
    expect(await ok("list_person_tags")).toBe("fast reply | #3E8E7E | 1 person");

    const created = await ok("create_todo", {
      title: "Open port 443 for the build server",
      requestedBy: ["Lea Frei"],
      contacts: [maxId],
    });
    expect(created).toMatch(/\| req: Lea Frei \| contact: Max Muster$/);
    todoId = idOf(created);
    expect(await ok("update_todo", { id: todoId, addContacts: ["eva keller"] })).toMatch(
      /\| contact: Max Muster, Eva Keller$/,
    );

    expect(await ok("list_todos", { personId: maxId, personRole: "contact" })).toContain(`#${todoId} open`);
    expect(await ok("list_todos", { personId: maxId })).toBe("No todos match.");
    expect(await ok("list_people", { kind: "contact", sort: "contact" })).toContain("contact for 1 (1 open)");

    const detail = await ok("get_person", { person: "max muster" });
    expect(detail).toContain("email: max.muster@example.com");
    expect(detail).toContain("requested 0 (0 open, 0 done), contact for 1 (1 open)");
    expect(detail).toMatch(
      new RegExp(`Open todos they are a contact for \\(1\\):\\n#${todoId} open \\| Open port 443`),
    );

    const updated = await ok("update_person", {
      person: maxId,
      addTopics: ["DNS"],
      removeTopics: ["vpn"],
      notes: "Prefers **chat** over mail.",
    });
    expect(updated).toContain("topics: DNS, firewall rules");
    // A topic nobody has any more is gone.
    expect(await ok("list_topics")).not.toContain("VPN");
    expect((await ok("get_person", { person: maxId })).endsWith("Prefers **chat** over mail.")).toBe(true);

    expect(await ok("update_todo", { id: todoId, removeContacts: ["Eva Keller"] })).toMatch(
      /\| contact: Max Muster$/,
    );
    const thread = await ok("get_activity", { todo: todoId });
    expect(thread).toMatch(new RegExp(`^#${todoId} activity \\(3 items\\):`));
    expect(thread).toMatch(/\d{4}-\d\d-\d\d \d\d:\d\d planner: .*Eva Keller/);
  });

  it("comments as the token and keeps browser comments out of its reach", async () => {
    const added = await ok("add_comment", {
      todo: todoId,
      text: "Asked Max about the **firewall**.\nWaiting.",
    });
    expect(added).toMatch(new RegExp(`^Added comment \\d+ to #${todoId} as ${TOKEN_NAME}\\.$`));
    const own = Number(/comment (\d+)/.exec(added)?.[1]);
    const browser = await rest("session", "POST", `/todos/${todoId}/comments`, {
      bodyMd: "Written in the browser",
    });
    expect(browser.status).toBe(201);
    const browserId = Number(browser.json?.id);

    const lines = (await ok("get_activity", { todo: todoId })).split("\n");
    expect(lines.slice(-3)).toEqual([
      expect.stringMatching(
        new RegExp(
          `^\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d ${TOKEN_NAME} commented \\(comment ${own}\\): Asked Max about the \\*\\*firewall\\*\\*\\.$`,
        ),
      ),
      "  Waiting.",
      expect.stringMatching(new RegExp(`you commented \\(comment ${browserId}\\): Written in the browser$`)),
    ]);
    expect(await ok("get_activity", { todo: todoId, limit: 1 })).toMatch(
      /items, the newest 1\):\n.*you commented/,
    );
    expect(await ok("get_todo", { id: todoId })).toContain("comments: 2 (get_activity shows the thread)");

    // The token may change its own comment, never one written in the browser session.
    expect((await rest("token", "PATCH", `/comments/${own}`, { bodyMd: "Asked Max." })).status).toBe(200);
    const foreign = await rest("token", "PATCH", `/comments/${browserId}`, { bodyMd: "changed" });
    expect(foreign.status).toBe(403);
    expect(JSON.stringify(foreign.json)).toContain("written by you");
    expect((await rest("token", "DELETE", `/comments/${browserId}`)).status).toBe(403);
    expect(await ok("get_activity", { todo: todoId })).toContain(`(comment ${own}, edited): Asked Max.`);

    const db = new DatabaseSync(dbFile(), { readOnly: true });
    try {
      expect(
        db.prepare("SELECT actor FROM comments WHERE account_id = ? ORDER BY id").all(annaAccountId),
      ).toEqual([{ actor: TOKEN_NAME }, { actor: "you" }]);
    } finally {
      db.close();
    }
  });

  it("writes, appends to and lists notes", async () => {
    const log = await ok("create_note", {
      title: "Firewall change log",
      body: "- 443 requested\n",
      project: "homelab",
      pinned: true,
    });
    expect(log).toMatch(/^Created note \d+ \| Firewall change log \| project homelab \| pinned \| updated /);
    const logId = Number(/note (\d+)/.exec(log)?.[1]);
    await ok("update_note", { id: logId, appendText: "- 443 opened" });
    expect((await ok("get_note", { id: logId })).endsWith("- 443 requested\n\n- 443 opened")).toBe(true);
    const loose = Number(/note (\d+)/.exec(await ok("create_note", { title: "Loose idea" }))?.[1]);

    const all = (await ok("list_notes")).split("\n");
    expect(all[0]).toBe("2 of 2 notes:");
    expect(all[1]).toMatch(
      new RegExp(
        `^note ${logId} \\| Firewall change log \\| project homelab \\| pinned \\| updated .* \\| 443 requested 443 opened$`,
      ),
    );
    expect(await ok("list_notes", { project: "none" })).toMatch(
      new RegExp(`^1 of 1 notes:\\nnote ${loose} \\|`),
    );
    expect(await ok("list_notes", { pinned: false })).not.toContain(`note ${logId} `);
    expect(await ok("update_note", { id: logId, project: null, pinned: false })).toMatch(
      /\| Firewall change log \| no project \| updated /,
    );
    const both = await call("update_note", { id: logId, body: "x", appendText: "y" });
    expect(both.isError).toBe(true);
  });

  it("searches todos, notes, comments and people", async () => {
    // The earlier comment was edited down to "Asked Max.", so add one that mentions the word.
    const logs = idOf(await ok("create_todo", { title: "Check the firewall logs" }));
    await ok("add_comment", { todo: todoId, text: "The firewall team confirmed." });
    const text = await ok("search", { q: "firewall" });
    expect(text).toMatch(/^Found for "firewall": 1 todo, 1 note, 1 comment, 1 person\./);
    expect(text).toContain(`Todos:\n#${logs} open | Check the firewall logs`);
    expect(text).toContain("Notes:\nnote ");
    expect(text).toMatch(new RegExp(`Comments:\\ncomment \\d+ on #${todoId} \\|`));
    expect(text).toMatch(new RegExp(`People:\\nperson ${maxId} \\| Max Muster`));
    expect(text).toContain("**");
    const people = await ok("search", { q: "müster", kinds: ["person"] });
    expect(people).toMatch(
      /^Found for "müster": 0 todos, 0 notes, 0 comments, 1 person\.\n\nPeople:\nperson /,
    );
    // FTS syntax in the query is just text.
    expect((await call("search", { q: '"firewall" OR NOT *' })).isError).toBe(false);
  });
});

describe("step 3 tools against the real API", () => {
  it("adds subtasks, ticks checklist items and marks a parent done with its subtasks", async () => {
    const parent = idOf(
      await ok("create_todo", {
        title: "Set up the rack",
        project: "homelab",
        description: "Shopping:\n- [ ] Order cables\n- [ ] Order rails\n",
      }),
    );
    const added = await ok("add_subtasks", { todo: parent, titles: ["Mount rails", "Patch cables"] });
    expect(added.split("\n")[0]).toBe(`Added 2 subtasks to #${parent}:`);
    expect(added).toContain("| project homelab |");
    const [first] = added.split("\n").slice(1).map(idOf);
    const grandchild = idOf(await ok("create_todo", { title: "Find screws", parent: first }));

    const children = await ok("list_todos", { parent });
    expect(children.split("\n")[0]).toBe("2 of 2 todos:");
    expect(await ok("list_todos", { parent: "none", q: "Mount rails" })).toBe("No todos match.");

    const detail = await ok("get_todo", { id: parent });
    expect(detail.split("\n")[0]).toContain("| 0/2 subtasks | checklist 0/2");
    expect(detail).toContain("[ ] 1 Order rails");
    expect(await ok("get_todo", { id: grandchild })).toContain(`Subtask of #${first} Mount rails`);

    expect(await ok("check_item", { todo: parent, item: "order rails" })).toMatch(
      new RegExp(`^Checked "Order rails" on #${parent} .*\\| checklist 1/2`),
    );
    expect(await ok("check_item", { todo: parent, item: 1, checked: false })).toContain("checklist 0/2");

    const done = await ok("mark_done", { ids: [parent], withSubtasks: true });
    expect(done.split("\n").filter((line) => line.startsWith("#"))).toHaveLength(4);
    expect(await ok("get_todo", { id: parent })).toContain("| 2/2 subtasks");
  });

  it("moves a todo waiting on a blocker out of Next up until the blocker is done", async () => {
    const waiting = idOf(
      await ok("create_todo", { title: "Install the server", labels: ["priority::high"] }),
    );
    const blocker = idOf(await ok("create_todo", { title: "Buy the rack" }));
    expect(await ok("link_todos", { todo: blocker, kind: "blocks", other: waiting })).toMatch(
      new RegExp(`^Linked: #${blocker} blocks #${waiting}\\.`),
    );
    const loop = await call("link_todos", { todo: waiting, kind: "blocks", other: blocker });
    expect(loop.isError).toBe(true);
    expect(loop.text).toContain(`Chain: #`);

    let next = await ok("next_up", { limit: 200 });
    const [ranked, blocked = ""] = next.split("\nBlocked");
    expect(ranked).toMatch(new RegExp(`#${blocker} open \\| Buy the rack .*why: .*blocks 1`));
    expect(ranked).not.toContain(`#${waiting} `);
    expect(blocked).toContain(`#${waiting} open | Install the server`);
    expect(blocked).toContain(`waiting on #${blocker}`);
    expect(await ok("get_todo", { id: waiting })).toContain(`blocked by: #${blocker} Buy the rack (open)`);

    await ok("mark_done", { ids: [blocker] });
    next = await ok("next_up", { limit: 200 });
    expect(next.split("\nBlocked")[0]).toContain(`#${waiting} open | Install the server`);

    expect(await ok("unlink_todos", { todo: waiting, kind: "blocked_by", other: blocker })).toBe(
      `Removed the link: #${waiting} is blocked by #${blocker}.`,
    );
    expect(await ok("get_todo", { id: waiting })).not.toContain("blocked by:");
    const relates = await ok("link_todos", {
      todo: waiting,
      kind: "relates",
      other: blocker,
      format: "json",
    });
    expect((JSON.parse(relates) as Todo).links.relatesTo.map((t) => t.id)).toEqual([blocker]);
  });

  it("creates the next occurrence of a repeating todo when it is marked done", async () => {
    const created = await ok("create_todo", {
      title: "Water the plants",
      dueOn: today,
      description: "- [x] Kitchen\n- [x] Balcony\n",
      repeat: { every: "week" },
    });
    expect(created).toContain("| repeats every week");
    const first = idOf(created);
    const noDate = await call("create_todo", { title: "No date", repeat: { every: "day" } });
    expect(noDate.isError).toBe(true);

    const done = await ok("mark_done", { ids: [first] });
    const [, nextPart = ""] = done.split("Next occurrence:\n");
    expect(nextPart).toMatch(
      new RegExp(`^#\\d+ open \\| Water the plants \\| inbox \\| due ${addDays(today, 7)} \\(in 7d\\)`),
    );
    expect(nextPart).toContain("checklist 0/2");
    const second = idOf(nextPart);
    // The server stores the rule normalized: the weekday comes from the due date.
    expect(await ok("get_todo", { id: first })).toMatch(
      new RegExp(`\\nRepeats every week on (Mon|Tue|Wed|Thu|Fri|Sat|Sun) \\(next: #${second}\\)\\n`),
    );
    expect(await ok("get_todo", { id: second })).toContain(`previous occurrence: #${first}`);

    const stopped = await ok("update_todo", { id: second, repeat: null });
    expect(stopped).not.toContain("repeats");
  });

  it("shows people statistics as one line per person", async () => {
    const todo = idOf(
      await ok("create_todo", {
        title: "Open port 8443",
        requestedBy: ["Petra Stat"],
        contacts: ["Max Muster"],
      }),
    );
    await ok("update_person", { person: "Petra Stat", team: "Stats team", addTopics: ["statistics"] });
    await ok("mark_done", { ids: [todo] });
    const stats = await ok("people_stats", { topic: ["statistics"] });
    expect(stats.split("\n")).toEqual([
      expect.stringMatching(/^People as requesters, todos: 1 \(0 open, 1 done, median took .+\):$/),
      expect.stringMatching(
        /^Petra Stat \| Stats team \| requested 1, open 0, done 1, median took .+ \| contact 0$/,
      ),
    ]);
    const contacts = await ok("people_stats", { role: "contact", team: "Network team" });
    expect(contacts).toMatch(/^People as contacts, todos: /);
    expect(contacts).toContain("Max Muster | Network team |");
  });

  it("keeps web links on a todo and plans time for it in local time", async () => {
    const created = await ok("create_todo", {
      title: "Review the rack PR",
      links: [{ url: "https://github.com/example/rack/pull/7", label: "PR 7" }],
    });
    const id = idOf(created);
    await ok("add_web_link", { todo: id, url: "wiki.example.com/rack" });
    const detail = await ok("get_todo", { id });
    expect(detail).toContain("PR 7 <https://github.com/example/rack/pull/7>");
    expect(detail).toContain("<https://wiki.example.com/rack>");
    const removed = await ok("remove_web_link", { todo: id, link: "https://wiki.example.com/rack" });
    // The first line names the removed URL; the list after it must not have it any more.
    expect(removed.split("\n").slice(1).join("\n")).not.toContain("wiki.example.com");

    const planned = await ok("plan_time", { todo: id, date: "2026-11-20", start: "09:00", minutes: 90 });
    expect(planned).toMatch(/block (\d+) \| 2026-11-20 09:00-10:30 \| #\d+ Review the rack PR/);
    const block = Number(/block (\d+)/.exec(planned)?.[1]);
    const plan = await ok("list_plan", { from: "2026-11-20", to: "2026-11-20" });
    expect(plan).toContain(`block ${block} | 2026-11-20 09:00-10:30`);
    const moved = await ok("move_block", { block, date: "2026-11-21", start: "14:00" });
    expect(moved).toContain("2026-11-21 14:00-15:30");
    await ok("plan_time", { title: "Gym", date: "2026-11-21", start: "18:00", end: "19:00" });
    expect(await ok("list_plan", { from: "2026-11-21", to: "2026-11-21" })).toMatch(/Gym/);
    expect(await ok("delete_block", { block })).toBe(`Deleted block ${block}.`);
    expect(await ok("list_plan", { from: "2026-11-20", to: "2026-11-20" })).toContain("Nothing planned.");
  });
});
