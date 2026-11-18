/**
 * Cuts a release: `pnpm release 1.4.0`.
 *
 * 1. Checks the version (newer than the current one) and that the working tree is clean.
 * 2. Moves the changelog's "Unreleased" entries under a heading for the version.
 * 3. Writes the version into the root package.json and every package (web and server read their own).
 * 4. Commits "chore(release): v1.4.0" and tags it `v1.4.0`.
 *
 * Pushing stays a step of its own: `git push --follow-tags`. The release reaches users when `dev` is
 * merged into `main` (the server image and the Vercel build then carry the new version).
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { compareVersions, formatVersion, parseVersion } from "../packages/shared/src/version.ts";

const UNRELEASED = "## Unreleased";

/**
 * The changelog with the Unreleased entries under `## <version> (<date>)` and a new, empty Unreleased
 * section above. Throws when there is no Unreleased section or it is empty.
 */
export function releaseChangelog(text: string, version: string, date: string): string {
  const start = text.indexOf(`${UNRELEASED}\n`);
  if (start < 0) throw new Error(`CHANGELOG.md has no "${UNRELEASED}" section.`);
  const bodyStart = start + UNRELEASED.length + 1;
  const next = text.indexOf("\n## ", bodyStart);
  const bodyEnd = next < 0 ? text.length : next + 1;
  const body = text.slice(bodyStart, bodyEnd).trim();
  if (!body) throw new Error(`The "${UNRELEASED}" section of CHANGELOG.md is empty: list the changes first.`);
  return `${text.slice(0, start)}${UNRELEASED}\n\n## ${version} (${date})\n\n${body}\n\n${text.slice(bodyEnd)}`
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n*$/, "\n");
}

/** The package.json text with its version set; the rest stays byte for byte. */
export function withVersion(packageJson: string, version: string): string {
  const pattern = /("version":\s*")[^"]*(")/;
  if (!pattern.test(packageJson)) throw new Error('A package.json has no "version" field.');
  return packageJson.replace(pattern, `$1${version}$2`);
}

function packageDirs(root: string): string[] {
  return [
    ".",
    ...["apps", "packages"].flatMap((group) =>
      readdirSync(join(root, group), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(group, entry.name)),
    ),
  ];
}

function main(argv: string[]): number {
  const root = resolve(import.meta.dirname, "..");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const wanted = parseVersion(argv[0] ?? "");
  if (argv.length !== 1 || !wanted) {
    console.error("Usage: pnpm release <major.minor.patch>, e.g. pnpm release 1.4.0");
    return 2;
  }
  const version = formatVersion(wanted);
  const rootJson = join(root, "package.json");
  const current = String(JSON.parse(readFileSync(rootJson, "utf8")).version);
  const currentVersion = parseVersion(current);
  if (currentVersion && compareVersions(wanted, currentVersion) <= 0) {
    console.error(`${version} is not newer than the current version ${current}.`);
    return 2;
  }
  if (git("status", "--porcelain")) {
    console.error("The working tree has changes. Commit or stash them first.");
    return 2;
  }
  if (git("tag", "--list", `v${version}`)) {
    console.error(`The tag v${version} exists already.`);
    return 2;
  }

  const changelogFile = join(root, "CHANGELOG.md");
  const date = new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD in the local zone
  try {
    writeFileSync(changelogFile, releaseChangelog(readFileSync(changelogFile, "utf8"), version, date));
  } catch (error) {
    console.error((error as Error).message);
    return 2;
  }
  const files = ["CHANGELOG.md"];
  for (const dir of packageDirs(root)) {
    const file = join(root, dir, "package.json");
    writeFileSync(file, withVersion(readFileSync(file, "utf8"), version));
    files.push(join(dir, "package.json"));
  }

  git("add", "--", ...files);
  git("commit", "-m", `chore(release): v${version}`);
  git("tag", "-a", `v${version}`, "-m", `Sloppanizer ${version}`);
  console.log(`Released ${version} (was ${current}): commit and tag v${version} made.`);
  console.log("Next: git push --follow-tags, then merge dev into main to ship it.");
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
