/**
 * The landing page preloads its two font files, so the first paint already uses them. Their built names
 * carry a content hash, so the links are added after the bundle exists.
 */

/** The fonts the landing page uses (regular text and the mono face for ids and numbers). */
export const LANDING_FONTS = ["atkinson-hyperlegible-next-latin-400-normal", "b612-mono-latin-400-normal"];

/** Adds a preload link per font to the head; a font missing from the bundle is an error. */
export function addFontPreloads(html: string, fileNames: readonly string[], fonts = LANDING_FONTS): string {
  const links = fonts.map((font) => {
    const file = fileNames.find((name) => name.startsWith(`assets/${font}-`) && name.endsWith(".woff2"));
    if (!file) throw new Error(`The font ${font} is not in the build.`);
    return `<link rel="preload" as="font" type="font/woff2" crossorigin href="/${file}" />`;
  });
  if (!html.includes("</head>")) throw new Error("The page has no </head>.");
  return html.replace("</head>", `${links.join("\n    ")}\n  </head>`);
}
