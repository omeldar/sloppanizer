import type { QuickAddDefaults } from "../../app/commands.tsx";

/** What the selected text becomes in a new todo. */
export type SelectionUse = "title" | "description";

/**
 * The new todo dialog's start values for selected note text: as the title on one line (line breaks and
 * runs of spaces become one space), or as the description with its line breaks kept (blank lines and
 * spaces around it dropped).
 */
export function selectionToTodo(text: string, use: SelectionUse): QuickAddDefaults {
  if (use === "title") return { title: text.replace(/\s+/g, " ").trim() };
  return { descriptionMd: text.replace(/^\s*\n/, "").trimEnd() };
}
