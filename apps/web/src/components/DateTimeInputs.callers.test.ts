// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * DateInput puts `className` on its wrapper, around a field that already has its own border, padding and
 * background. A caller's class that draws a field too shows as a second box with a gap left and right
 * (S5#1). This reads every caller and its CSS module and checks that those classes only size the field.
 */

const src = join(dirname(fileURLToPath(import.meta.url)), "..");

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(path);
    return entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx") ? [path] : [];
  });
}

/** Every `<DateInput ... className={styles.x}` (also imported under another name) with its CSS module. */
function callers(): { file: string; css: string; cls: string }[] {
  const found: { file: string; css: string; cls: string }[] = [];
  for (const file of tsxFiles(src)) {
    const code = readFileSync(file, "utf8");
    const imported = /import\s*\{([^}]*)\}\s*from\s*"[./]*\/?(?:components\/)?DateTimeInputs\.tsx"/.exec(
      code,
    );
    if (!imported) continue;
    const names = (imported[1] ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.startsWith("DateInput"))
      .map((part) => part.split(/\s+as\s+/).pop() as string);
    const cssPath = /import\s+styles\s+from\s+"([^"]+\.module\.css)"/.exec(code)?.[1];
    for (const name of names) {
      for (const tag of code.matchAll(new RegExp(`<${name}\\b([\\s\\S]*?)/>`, "g"))) {
        const cls = /className=\{styles\.(\w+)\}/.exec(tag[1] ?? "")?.[1];
        if (cls && cssPath && !found.some((f) => f.file === file && f.cls === cls))
          found.push({ file, css: join(dirname(file), cssPath), cls });
      }
    }
  }
  return found;
}

/** The declarations of every rule whose selector list names `.cls` on its own (no pseudo-classes). */
function declarations(css: string, cls: string): string {
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  return rules
    .filter((rule) =>
      (rule[1] ?? "")
        .split(",")
        .map((selector) => selector.trim())
        .includes(`.${cls}`),
    )
    .map((rule) => rule[2])
    .join(";");
}

describe("DateInput callers", () => {
  const all = callers();

  it("finds the callers that pass a class", () => {
    expect(all.length).toBeGreaterThanOrEqual(3);
  });

  it.each(all.map((c) => [`${c.file.slice(src.length + 1)} .${c.cls}`, c]))(
    "%s does not draw a second field around it",
    (_name, c) => {
      const body = declarations(readFileSync(c.css, "utf8"), c.cls);
      expect(body, `.${c.cls} in ${c.css}`).not.toMatch(
        /(^|[;\s])(border|padding|background|height)(-[\w-]+)?\s*:/,
      );
    },
  );
});
