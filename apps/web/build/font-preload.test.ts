import { describe, expect, it } from "vitest";
import { addFontPreloads } from "./font-preload.ts";

const files = [
  "assets/app-1.js",
  "assets/b612-mono-latin-400-normal-AAA.woff",
  "assets/b612-mono-latin-400-normal-BBB.woff2",
  "assets/b612-mono-latin-700-normal-CCC.woff2",
  "assets/atkinson-hyperlegible-next-latin-400-normal-DDD.woff2",
  "assets/atkinson-hyperlegible-next-latin-ext-400-normal-EEE.woff2",
];

describe("addFontPreloads", () => {
  it("preloads exactly the woff2 file of each font, in the head", () => {
    const html = addFontPreloads("<html><head><title>x</title></head><body></body></html>", files);
    const hrefs = [...html.matchAll(/rel="preload"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual([
      "/assets/atkinson-hyperlegible-next-latin-400-normal-DDD.woff2",
      "/assets/b612-mono-latin-400-normal-BBB.woff2",
    ]);
    expect(html.indexOf("preload")).toBeLessThan(html.indexOf("</head>"));
    // Fonts load in CORS mode; a preload without crossorigin would be fetched twice.
    expect(html).toContain('as="font" type="font/woff2" crossorigin');
  });

  it("fails the build when a font is missing", () => {
    expect(() => addFontPreloads("<head></head>", ["assets/app.js"])).toThrow(/not in the build/);
  });
});
