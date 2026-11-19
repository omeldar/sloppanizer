import { describe, expect, it } from "vitest";
import {
  EXPORT_FORMAT,
  ExportManifest,
  Me,
  PROJECT_COLORS,
  RestorePreview,
  SCHEMA_BASE,
  TOKEN_PATTERN,
  TOKEN_PREFIX_LENGTH,
} from "./index.ts";

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

const account = { id: 2, username: "anna", displayName: "Anna", color: PROJECT_COLORS[0], role: "user" };

describe("step 5 contract", () => {
  it("API tokens are spz_ plus 40 base62 characters; old org_ tokens no longer match", () => {
    const body = "aZ09".repeat(10);
    expect(TOKEN_PATTERN.test(`spz_${body}`)).toBe(true);
    expect(TOKEN_PATTERN.test(`org_${body}`)).toBe(false);
    expect(TOKEN_PATTERN.test(`spz_${body}x`)).toBe(false);
    expect(TOKEN_PATTERN.test(`spz_${body.slice(1)}-`)).toBe(false);
    expect(`spz_${body}`.slice(0, TOKEN_PREFIX_LENGTH)).toBe("spz_aZ09aZ09");
  });

  it("Me always names the caller's account", () => {
    const me = { actor: "you", via: "session", scope: "write", account };
    expect(ok(Me, me)).toBe(true);
    expect(ok(Me, { actor: "you", via: "session", scope: "write" })).toBe(false);
    expect(ok(Me, { ...me, accountId: 2 })).toBe(false);
  });

  it("the restore preview says which app made the file", () => {
    const preview = {
      uploadId: "a".repeat(32),
      fileName: "organizer-export.zip",
      source: "organizer",
      format: 3,
      exportedAt: "2026-11-01T08:00:00.000Z",
      appVersion: "0.1.0",
      schemaVersion: 8,
      inFile: { todos: 1 },
      now: { todos: 0 },
      attachments: { count: 0, bytes: 0, missing: [] },
      warnings: [],
      expiresAt: "2026-11-01T09:00:00.000Z",
    };
    expect(ok(RestorePreview, preview)).toBe(true);
    expect(ok(RestorePreview, { ...preview, source: "sloppanizer" })).toBe(true);
    expect(ok(RestorePreview, { ...preview, source: "other" })).toBe(false);
  });

  it("export manifests are format 8 with the account and its sequences", () => {
    const manifest = {
      app: "sloppanizer",
      format: EXPORT_FORMAT,
      exportedAt: "2026-11-01T08:00:00.000Z",
      appVersion: "0.1.0",
      schemaVersion: SCHEMA_BASE + 1,
      account: { username: "anna", displayName: "Anna" },
      counts: { todos: 2 },
      sequences: { todos: 7 },
      attachments: { count: 0, bytes: 0, missing: [] },
    };
    expect(EXPORT_FORMAT).toBe(8);
    expect(ok(ExportManifest, manifest)).toBe(true);
    expect(ok(ExportManifest, { ...manifest, app: "organizer" })).toBe(false);
    expect(ok(ExportManifest, { ...manifest, format: 3 })).toBe(false);
    // No account ids in exports: any export imports into any account.
    expect(ok(ExportManifest, { ...manifest, account: { ...manifest.account, id: 2 } })).toBe(false);
  });
});
