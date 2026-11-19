import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { releaseChangelog, withVersion } from "../../../scripts/release.ts";
import { compareVersions, parseVersion, versionGap } from "./version.ts";

const v = (text: string) => parseVersion(text) ?? { major: 0, minor: 0, patch: 0 };

describe("parseVersion", () => {
  it("reads plain, v-prefixed and pre-release versions", () => {
    expect(parseVersion("1.4.0")).toEqual({ major: 1, minor: 4, patch: 0 });
    expect(parseVersion("v12.0.3")).toEqual({ major: 12, minor: 0, patch: 3 });
    expect(parseVersion("1.5.0-rc.1")).toEqual({ major: 1, minor: 5, patch: 0 });
  });

  it("is null for anything else", () => {
    for (const text of ["", "1.4", "1.4.x", "latest", "1.4.0.1", "dev"])
      expect(parseVersion(text)).toBeNull();
  });

  it("compares numbers, not text", () => {
    expect(compareVersions(v("1.10.0"), v("1.9.9"))).toBeGreaterThan(0);
    expect(compareVersions(v("1.4.0"), v("1.4.0"))).toBe(0);
    expect(compareVersions(v("0.9.0"), v("1.0.0"))).toBeLessThan(0);
  });
});

describe("versionGap", () => {
  it("is server-older while the server is on an older minor release", () => {
    expect(versionGap("1.5.0", "1.4.3")).toBe("server-older");
    expect(versionGap("2.0.0", "1.9.0")).toBe("server-older");
    expect(versionGap("1.0.0", "0.1.0")).toBe("server-older");
  });

  it("is same for a fix release of only one side", () => {
    // Web 1.4.1 is live, the server still runs 1.4.0: the web app needs nothing new from it.
    expect(versionGap("1.4.1", "1.4.0")).toBe("same");
    expect(versionGap("1.4.0", "1.4.0")).toBe("same");
  });

  it("follows a lowest server version the web app declares", () => {
    expect(versionGap("1.4.2", "1.4.1", "1.4.2")).toBe("server-older");
    expect(versionGap("1.4.2", "1.4.2", "1.4.2")).toBe("same");
    // A declared version below the own minor release does not loosen the rule.
    expect(versionGap("1.5.0", "1.4.9", "1.3.0")).toBe("server-older");
  });

  it("is web-older when the server runs anything newer (an old open tab)", () => {
    expect(versionGap("1.4.0", "1.4.1")).toBe("web-older");
    expect(versionGap("1.4.0", "1.5.0")).toBe("web-older");
  });

  it("is unknown when a version cannot be read", () => {
    expect(versionGap("dev", "1.4.0")).toBe("unknown");
    expect(versionGap("1.4.0", "")).toBe("unknown");
  });
});

describe("package versions", () => {
  it("every package carries the root version, so web and server builds report the same release", () => {
    const root = resolve(import.meta.dirname, "../../..");
    const read = (dir: string): { name: string; version: string } =>
      JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"));
    const rootVersion = read(".").version;
    expect(parseVersion(rootVersion)).not.toBeNull();
    const dirs = ["apps", "packages"].flatMap((group) =>
      readdirSync(join(root, group), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(group, entry.name)),
    );
    expect(dirs.length).toBeGreaterThanOrEqual(4);
    for (const dir of dirs)
      expect({ dir, version: read(dir).version }).toEqual({ dir, version: rootVersion });
  });
});

describe("pnpm release", () => {
  const changelog = [
    "# Changelog",
    "",
    "Intro.",
    "",
    "## Unreleased",
    "",
    "- Edit a project's color (#17).",
    "- Updating banner (#16).",
    "",
    "## 1.0.0 (2026-11-01)",
    "",
    "- First.",
    "",
  ].join("\n");

  it("moves the Unreleased entries under the new version and leaves an empty Unreleased", () => {
    expect(releaseChangelog(changelog, "1.1.0", "2026-11-18")).toBe(
      [
        "# Changelog",
        "",
        "Intro.",
        "",
        "## Unreleased",
        "",
        "## 1.1.0 (2026-11-18)",
        "",
        "- Edit a project's color (#17).",
        "- Updating banner (#16).",
        "",
        "## 1.0.0 (2026-11-01)",
        "",
        "- First.",
        "",
      ].join("\n"),
    );
  });

  it("refuses an empty or missing Unreleased section", () => {
    const released = releaseChangelog(changelog, "1.1.0", "2026-11-18");
    expect(() => releaseChangelog(released, "1.2.0", "2026-11-19")).toThrow(/empty/);
    expect(() => releaseChangelog("# Changelog\n", "1.2.0", "2026-11-19")).toThrow(/no "## Unreleased"/);
  });

  it("sets only the version of a package.json", () => {
    const text = '{\n  "name": "x",\n  "version": "0.1.0",\n  "dependencies": { "y": "1.0.0" }\n}\n';
    expect(withVersion(text, "1.4.0")).toBe(text.replace('"version": "0.1.0"', '"version": "1.4.0"'));
  });
});
