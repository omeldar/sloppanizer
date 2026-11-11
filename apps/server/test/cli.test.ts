import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli/token-create.ts";
import { DB_FILE } from "../src/data-dir.ts";
import { openDb } from "../src/db/index.ts";
import { apiTokens } from "../src/db/schema.ts";
import { hashToken } from "../src/services/tokens.ts";

describe("token:create", () => {
  const root = mkdtempSync(join(tmpdir(), "organizer-cli-"));
  const dataDir = join(root, "data");
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("writes the raw token to a 0600 file and prints nothing secret", () => {
    vi.stubEnv("ORGANIZER_DATA_DIR", dataDir);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const out = join(root, "mcp-token");
    expect(main(["--name", "assistant", "--scope", "write", "--out", out])).toBe(0);
    const raw = readFileSync(out, "utf8").trim();
    expect(raw).toMatch(/^org_[0-9A-Za-z]{40}$/);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(log.mock.calls.flat().join(" ")).not.toContain(raw);
    const db = openDb(join(dataDir, DB_FILE));
    const rows = db.select().from(apiTokens).all();
    db.$client.close();
    expect(rows.map((r) => [r.name, r.scope, r.tokenHash])).toEqual([["assistant", "write", hashToken(raw)]]);
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses a bad scope or a missing name", () => {
    vi.stubEnv("ORGANIZER_DATA_DIR", dataDir);
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(main(["--name", "x", "--scope", "admin"])).toBe(2);
    expect(main(["--scope", "read"])).toBe(2);
    expect(main(["--nope"])).toBe(2);
  });
});
