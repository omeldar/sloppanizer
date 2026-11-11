import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { addDays, type Todo, toLocalDate } from "@organizer/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundle } from "../scripts/build.ts";

// The real server on port 4803 with a temp data dir, the bundled MCP server over stdio.
const PORT = 4803;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TZ = "Europe/Zurich";
const TOKEN_NAME = "planner";
const SERVER_DIR = fileURLToPath(new URL("../../server", import.meta.url));

const root = mkdtempSync(join(tmpdir(), "organizer-mcp-it-"));
const dataDir = join(root, "data");
const tokenFile = join(root, "mcp-token");
const bundlePath = join(root, "mcp", "index.js");
const today = toLocalDate(new Date(), TZ);

let server: ChildProcess | undefined;
const clients: Client[] = [];

async function waitForHealth(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server?.exitCode !== null) throw new Error(`server exited with ${server?.exitCode}`);
    try {
      // oxlint-disable-next-line no-await-in-loop -- polling, one request at a time
      const response = await fetch(`${BASE_URL}/api/v1/health`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    // oxlint-disable-next-line no-await-in-loop -- polling interval
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("server did not become healthy");
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
  server = spawn(process.execPath, ["src/index.ts"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      ORGANIZER_PORT: String(PORT),
      ORGANIZER_DATA_DIR: dataDir,
      ORGANIZER_TZ: TZ,
      ORGANIZER_WEB_DIR: join(root, "no-web"),
      LOG_LEVEL: "warn",
      NODE_ENV: "test",
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  await waitForHealth(30_000);
  const created = spawnSync(
    process.execPath,
    ["src/cli/token-create.ts", "--name", TOKEN_NAME, "--scope", "write", "--out", tokenFile],
    { cwd: SERVER_DIR, env: { ...process.env, ORGANIZER_DATA_DIR: dataDir }, encoding: "utf8" },
  );
  if (created.status !== 0) throw new Error(`token:create failed: ${created.stderr}`);
  mcp = await connect({ ORGANIZER_URL: BASE_URL, ORGANIZER_TOKEN_FILE: tokenFile, ORGANIZER_TZ: TZ });
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
        "bulk_update",
        "create_label",
        "create_person",
        "create_project",
        "create_todo",
        "get_todo",
        "list_labels",
        "list_people",
        "list_projects",
        "list_todos",
        "mark_done",
        "next_up",
        "overview",
        "update_todo",
      ].toSorted(),
    );
    for (const tool of tools) expect(tool.description?.length).toBeGreaterThan(40);
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
    const db = new DatabaseSync(join(dataDir, "organizer.db"), { readOnly: true });
    try {
      const actors = db.prepare("SELECT DISTINCT actor FROM events").all() as { actor: string }[];
      expect(actors).toEqual([{ actor: TOKEN_NAME }]);
      const kinds = db
        .prepare("SELECT kind FROM events WHERE todo_id = ? ORDER BY id")
        .all(a)
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
    ).toMatch(/^Created person \d+ \| Anna Meier \| IT$/);
    const ambiguous = await call("create_todo", { title: "x", requestedBy: ["Anna Meier"] });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.text).toContain("Candidates (pass one as a person id):");
    expect(ambiguous.text).toContain("Anna Meier | IT");

    const missing = await call("get_todo", { id: 99_999 });
    expect(missing.isError).toBe(true);
  });

  it("says how to start organizer when it is not running", async () => {
    const down = await connect({ ORGANIZER_URL: "http://127.0.0.1:4899", ORGANIZER_TOKEN_FILE: tokenFile });
    expect(await call("next_up", {}, down)).toEqual({
      isError: true,
      text: "organizer is not reachable at http://127.0.0.1:4899. Start it: systemctl --user start organizer",
    });
  });

  it("says where the token file should be when it is missing", async () => {
    const noToken = await connect({ ORGANIZER_URL: BASE_URL, ORGANIZER_TOKEN_FILE: join(root, "missing") });
    const result = await call("overview", {}, noToken);
    expect(result.isError).toBe(true);
    expect(result.text).toContain(`No API token at ${join(root, "missing")}`);
  });
});
