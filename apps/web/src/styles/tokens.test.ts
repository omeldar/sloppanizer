// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrast } from "../lib/color.ts";

const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
const base = readFileSync(new URL("./base.css", import.meta.url), "utf8");

function themeTokens(selector: RegExp): Record<string, string> {
  const block = selector.exec(css)?.[1] ?? "";
  return Object.fromEntries(
    [...block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6});/g)].map((m) => [m[1], m[2]]),
  );
}

const themes = {
  dark: themeTokens(/:root,\s*:root\[data-theme="dark"\]\s*\{([^}]*)\}/),
  light: themeTokens(/:root\[data-theme="light"\]\s*\{([^}]*)\}/),
};

describe.each(Object.entries(themes))("%s theme text contrast", (_name, t) => {
  const surfaces = ["bg", "raised", "sunken", "strip", "strip-selected"];
  const inks = ["text", "text-2", "text-3", "amber-text", "red"];
  it.each(inks.flatMap((ink) => surfaces.map((surface) => [ink, surface])))(
    "%s on %s reaches 4.5:1",
    (ink, surface) => {
      expect(t[ink], `--${ink}`).toBeDefined();
      expect(t[surface], `--${surface}`).toBeDefined();
      expect(contrast(t[ink] as string, t[surface] as string)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it.each(["bg", "raised", "raised-2", "sunken", "strip", "strip-selected"])(
    "the amber line (focus and cursor rings) reaches 3:1 on %s",
    (surface) => {
      expect(t["amber-line"], "--amber-line").toBeDefined();
      expect(contrast(t["amber-line"] as string, t[surface] as string)).toBeGreaterThanOrEqual(3);
    },
  );

  it("the global keyboard focus ring uses the amber line", () => {
    expect(base).toMatch(/:focus-visible\s*\{[^}]*outline:[^;]*var\(--amber-line\)/);
  });

  it("dark text on the amber fill (primary buttons) reaches 4.5:1", () => {
    expect(contrast(t["on-amber"] as string, t["amber-fill"] as string)).toBeGreaterThanOrEqual(4.5);
  });
});
