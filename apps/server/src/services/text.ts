/** Text helpers shared by the services: Markdown to plain text, name order and folding. */

/** Markdown turned into plain text, roughly: enough for excerpts, snippets and the search index. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n?/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/[*_~`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Case-insensitive name order, stable for equal names. */
export function compareNames(a: string, b: string): number {
  const lower = a.toLowerCase().localeCompare(b.toLowerCase(), "en");
  return lower !== 0 ? lower : a.localeCompare(b, "en");
}

/** Trimmed and lowercase, for exact name matches ("anna" equals " Anna "). */
export const foldCase = (text: string): string => text.trim().toLocaleLowerCase("en");

/** Lowercase without diacritics, so "muller" finds "Müller". */
export const foldDiacritics = (text: string): string =>
  text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("en");

/** Like foldDiacritics, but one output character per input character, so positions stay valid. */
export function foldChars(text: string): string {
  let out = "";
  for (const c of text) {
    const folded = c.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    const first = folded.length > 0 ? String.fromCodePoint(folded.codePointAt(0) as number) : c;
    out += first.length === c.length ? first : c;
  }
  return out;
}
