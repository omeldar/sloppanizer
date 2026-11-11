import { applyLabelChange } from "@organizer/shared";

export interface ParsedQuickTitle {
  title: string;
  /** Existing label names found as `~name` tokens, in their stored spelling. */
  labels: string[];
  /** `~tokens` that match no label; they stay in the title. */
  unknown: string[];
}

const TOKEN = /(^|\s)~(\S+)/g;

/** Pulls `~label` tokens out of a quick add title, e.g. "Renew certs ~homelab ~priority::high". */
export function parseQuickTitle(text: string, known: readonly { name: string }[]): ParsedQuickTitle {
  const byLower = new Map(known.map((label) => [label.name.toLowerCase(), label.name]));
  let labels: string[] = [];
  const unknown: string[] = [];
  const title = text
    .replace(TOKEN, (match, space: string, token: string) => {
      const name = byLower.get(token.toLowerCase());
      if (!name) {
        unknown.push(token);
        return match;
      }
      // A later token of the same scope wins, like on the server.
      labels = applyLabelChange(labels, { add: [name] });
      return space;
    })
    .replace(/\s+/g, " ")
    .trim();
  return { title, labels, unknown };
}
