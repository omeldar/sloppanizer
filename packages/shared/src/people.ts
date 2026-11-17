import { LANGUAGE_LABELS, PERSON_LANGUAGES, type PersonLanguage } from "./primitives.ts";

/** Topic names are compared and stored trimmed, with inner whitespace collapsed to one space. */
export function normalizeTopic(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

/** mailto: link; the "@" stays readable, every other special character is encoded. */
export function mailtoUrl(email: string, subject?: string): string {
  const address = email
    .trim()
    .split("@")
    .map((part) => encodeURIComponent(part))
    .join("@");
  return subject ? `mailto:${address}?subject=${encodeURIComponent(subject)}` : `mailto:${address}`;
}

/** The languages without repeats, in the fixed order of PERSON_LANGUAGES (German before English). */
export function sortLanguages(languages: readonly PersonLanguage[]): PersonLanguage[] {
  return PERSON_LANGUAGES.filter((code) => languages.includes(code));
}

/** The names of the languages ("German"), in the given order. */
export const languageNames = (languages: readonly PersonLanguage[]): string[] =>
  languages.map((code) => LANGUAGE_LABELS[code]);
