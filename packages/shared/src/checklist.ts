/**
 * Checklists are GitHub/GitLab task list lines in a todo's Markdown description:
 * `- [ ] Order cables`, `* [x] Done`, `1. [X] Numbered`, at any indent. Lines inside fenced code
 * blocks (``` or ~~~) and indented code blocks are not items. Items inside block quotes are not
 * counted. Edits change only the one bracket character and keep every other byte.
 */

import type { ChecklistItem } from "./entities.ts";

interface FoundItem extends ChecklistItem {
  /** Character offset of the x or space between the brackets. */
  mark: number;
}

const FENCE = /^(`{3,}|~{3,})/;
const LIST_ITEM = /^([-*+]|\d{1,9}[.)])([ \t]|$)/;
const TASK = /^(?:[-*+]|\d{1,9}[.)])[ \t]+\[([ xX])\](?=[ \t]|$)(.*)$/;

/** Indent width in columns (a tab moves to the next multiple of 4) and the rest of the line. */
function splitIndent(line: string): { width: number; rest: string } {
  let width = 0;
  let i = 0;
  for (; i < line.length; i += 1) {
    const c = line[i];
    if (c === " ") width += 1;
    else if (c === "\t") width += 4 - (width % 4);
    else break;
  }
  return { width, rest: line.slice(i) };
}

function findItems(md: string): FoundItem[] {
  const items: FoundItem[] = [];
  let offset = 0;
  let fence: { char: string; length: number } | null = null;
  let previousBlank = true;
  let inList = false;
  let inIndentedCode = false;
  const lines = md.split("\n");
  lines.forEach((raw, lineNo) => {
    const lineStart = offset;
    offset += raw.length + 1;
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const { width, rest } = splitIndent(line);

    if (fence) {
      const close = FENCE.exec(rest);
      if (
        close?.[1] &&
        close[1][0] === fence.char &&
        close[1].length >= fence.length &&
        rest.slice(close[1].length).trim() === ""
      ) {
        fence = null;
      }
      return;
    }
    if (rest.trim() === "") {
      previousBlank = true;
      return;
    }
    if (inIndentedCode) {
      if (width >= 4) return;
      inIndentedCode = false;
    }
    const open = FENCE.exec(rest);
    if (open?.[1] && (width < 4 || inList)) {
      fence = { char: open[1][0] as string, length: open[1].length };
      // A fence at the left edge is not inside a list item.
      if (width === 0) inList = false;
      previousBlank = false;
      return;
    }
    if (width >= 4 && !inList && previousBlank) {
      inIndentedCode = true;
      return;
    }
    if (LIST_ITEM.test(rest)) {
      inList = true;
      const task = TASK.exec(rest);
      if (task) {
        const bracket = rest.indexOf("[");
        items.push({
          index: items.length,
          text: (task[2] ?? "").trim(),
          checked: task[1] !== " ",
          line: lineNo,
          mark: lineStart + (line.length - rest.length) + bracket + 1,
        });
      }
    } else if (width === 0 && previousBlank) {
      inList = false;
    }
    previousBlank = false;
  });
  return items;
}

/** The task list items of a Markdown text, in order. */
export function parseChecklist(md: string): ChecklistItem[] {
  return findItems(md).map(({ mark: _mark, ...item }) => item);
}

export function countChecklist(md: string): { total: number; done: number } {
  const items = findItems(md);
  return { total: items.length, done: items.filter((item) => item.checked).length };
}

/**
 * Checks or unchecks item `index`. Only that bracket changes ("x" or " "); an item that already
 * has the wanted state (also "X") stays byte for byte. Throws RangeError for an unknown index.
 */
export function setChecklistItem(md: string, index: number, checked: boolean): string {
  const item = findItems(md)[index];
  if (!item) throw new RangeError(`No checklist item ${index}.`);
  if (item.checked === checked) return md;
  return `${md.slice(0, item.mark)}${checked ? "x" : " "}${md.slice(item.mark + 1)}`;
}

/** Unchecks every item (for the next occurrence of a repeating todo). */
export function resetChecklist(md: string): string {
  let out = md;
  for (const item of findItems(md)) {
    if (item.checked) out = `${out.slice(0, item.mark)} ${out.slice(item.mark + 1)}`;
  }
  return out;
}
