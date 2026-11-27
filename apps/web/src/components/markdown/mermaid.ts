import type { MermaidConfig } from "mermaid";
import type { Theme } from "../../lib/theme.ts";

type Mermaid = (typeof import("mermaid"))["default"];

/** A diagram drawn as an image: an SVG in a data URL, so nothing in it can run or reach the page. */
export interface DrawnDiagram {
  src: string;
  alt: string;
  width: number;
  height: number;
}

export type DiagramResult = { ok: true; diagram: DrawnDiagram } | { ok: false; error: string };

/** The renderer chunk could not be loaded (offline, a new release replaced the old files). */
export const LOAD_FAILED = "The diagram renderer did not load. Reload the page to try again.";

/**
 * Settings for every diagram. "strict": text in labels is encoded and click handlers are off. No HTML
 * labels: labels are plain SVG text, which draws the same inside an <img>. The `secure` keys cannot be
 * changed by a `%%{init}%%` line in the diagram.
 */
export function mermaidConfig(theme: Theme): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    suppressErrorRendering: true,
    theme: theme === "dark" ? "dark" : "default",
    secure: [
      "secure",
      "securityLevel",
      "startOnLoad",
      "maxTextSize",
      "suppressErrorRendering",
      "maxEdges",
      "htmlLabels",
    ],
  };
}

let loading: Promise<Mermaid> | null = null;

/** Mermaid is large: it loads with the first diagram on a page, once. */
function loadMermaid(): Promise<Mermaid> {
  loading ??= import("mermaid").then(
    (module) => module.default,
    (error: unknown) => {
      loading = null;
      throw error;
    },
  );
  return loading;
}

/** Finished diagrams by theme and text: switching Write / Preview or the theme back shows them at once. */
const cache = new Map<string, DiagramResult>();
const CACHE_SIZE = 64;

export function cachedDiagram(source: string, theme: Theme): DiagramResult | undefined {
  return cache.get(`${theme}\n${source}`);
}

function remember(source: string, theme: Theme, result: DiagramResult): void {
  const key = `${theme}\n${source}`;
  cache.delete(key);
  cache.set(key, result);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
}

export function clearDiagramCache(): void {
  cache.clear();
}

/** One diagram at a time: mermaid keeps its settings globally, and each one sets the theme first. */
let queue: Promise<unknown> = Promise.resolve();

/** Draws `source`; resolves with the image or the reason it could not be drawn (never rejects). */
export function drawDiagram(id: string, source: string, theme: Theme): Promise<DiagramResult> {
  const cached = cachedDiagram(source, theme);
  if (cached) return Promise.resolve(cached);
  const job = queue.then(() => drawNow(id, source, theme));
  queue = job;
  return job;
}

async function drawNow(id: string, source: string, theme: Theme): Promise<DiagramResult> {
  // The same diagram may have been drawn while this one waited (two previews, a remount).
  const cached = cachedDiagram(source, theme);
  if (cached) return cached;
  let mermaid: Mermaid;
  try {
    mermaid = await loadMermaid();
  } catch {
    return { ok: false, error: LOAD_FAILED };
  }
  let result: DiagramResult;
  try {
    mermaid.initialize(mermaidConfig(theme));
    const { svg } = await mermaid.render(id, source);
    result = { ok: true, diagram: svgToImage(svg) };
  } catch (error) {
    result = { ok: false, error: errorLine(error) };
  } finally {
    // Mermaid draws in a hidden element in the body; it removes it, this makes sure.
    document.getElementById(`d${id}`)?.remove();
  }
  remember(source, theme, result);
  return result;
}

/** Mermaid's message in one short line ("Parse error on line 2: Expecting 'SEMI', got 'EOF'"). */
export function errorLine(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const lines = message
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^[-^\s.]*$/.test(line));
  if (lines.length === 0) return "The diagram has an error.";
  const first = lines[0] as string;
  const last = lines.at(-1) as string;
  let text = first;
  if (lines.length > 1 && /^Parse error/i.test(first)) {
    // A long "Expecting 'A', 'B', ... got 'X'" list helps nobody; the unexpected token does.
    const expecting = /^Expecting (.+), got (.+)$/.exec(last);
    const choices = expecting?.[1]?.split(", ").length ?? 0;
    // The parser names the end of the text '1' or 'EOF'.
    const got =
      expecting?.[2] === "'1'" || expecting?.[2] === "'EOF'" ? "end of the diagram" : expecting?.[2];
    text = expecting && choices > 3 ? `${first} unexpected ${got}` : `${first} ${last}`;
  }
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

/**
 * The SVG as an <img>: an SVG image runs no scripts, loads nothing and keeps its styles to itself. Its
 * size comes from the viewBox (mermaid sets width 100%, which an image cannot use).
 */
export function svgToImage(svg: string): DrawnDiagram {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement;
  if (root.nodeName !== "svg" || doc.getElementsByTagName("parsererror").length > 0) {
    throw new Error("The diagram came out empty.");
  }
  const box = (root.getAttribute("viewBox") ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const width = Math.max(1, Math.ceil(box[2] || 300));
  const height = Math.max(1, Math.ceil(box[3] || 150));
  root.setAttribute("width", String(width));
  root.setAttribute("height", String(height));
  root.removeAttribute("style");
  const title = Array.from(root.children)
    .find((child) => child.nodeName === "title")
    ?.textContent?.trim();
  const text = new XMLSerializer().serializeToString(root);
  return {
    src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`,
    alt: title ? `Diagram: ${title}` : "Diagram",
    width,
    height,
  };
}
