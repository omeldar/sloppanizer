import { createContext, type ReactNode, useContext, useMemo, useState } from "react";

export interface QuickAddDefaults {
  /** Start in this project (the page the todo was added from). */
  projectSlug?: string;
  /** Start with this title (cut to the title limit, with a note in the dialog when it was longer). */
  title?: string;
  /** Start with this description (Markdown). */
  descriptionMd?: string;
}

/** Actions of the todo page that is open, for the palette (null on other pages). */
export interface TodoCommands {
  todoId: number;
  newSubtask: () => void;
  addLink: () => void;
  repeat?: () => void;
  goToParent?: () => void;
}

interface Commands {
  openQuickAdd: (defaults?: QuickAddDefaults) => void;
  /** Opens the new note dialog; the note starts in this project (null = none). */
  openNewNote: (projectId?: number | null) => void;
  openNewPerson: () => void;
  /** Opens the bug report / feature request dialog. */
  openFeedback: (kind?: "bug" | "feature") => void;
  openPalette: () => void;
  openHelp: () => void;
  setTodoCommands: (commands: TodoCommands | null) => void;
}

interface CommandState {
  quickAdd: QuickAddDefaults | null;
  /** Open when not undefined; the value is the start project. */
  newNote: { projectId: number | null } | null;
  newPerson: boolean;
  feedback: "bug" | "feature" | null;
  palette: boolean;
  help: boolean;
  todoCommands: TodoCommands | null;
  close: (which: Overlay) => void;
}

type Overlay = "quickAdd" | "newNote" | "newPerson" | "feedback" | "palette" | "help";

const CommandsContext = createContext<(Commands & CommandState) | null>(null);

/** App wide overlays (quick add, new note, new person, palette, help) that buttons, keys and the palette can open. */
export function CommandsProvider({ children }: { children: ReactNode }) {
  const [quickAdd, setQuickAdd] = useState<QuickAddDefaults | null>(null);
  const [newNote, setNewNote] = useState<{ projectId: number | null } | null>(null);
  const [newPerson, setNewPerson] = useState(false);
  const [feedback, setFeedback] = useState<"bug" | "feature" | null>(null);
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [todoCommands, setTodoCommands] = useState<TodoCommands | null>(null);

  const value = useMemo(
    () => ({
      quickAdd,
      newNote,
      newPerson,
      feedback,
      palette,
      help,
      todoCommands,
      setTodoCommands,
      openFeedback: (kind: "bug" | "feature" = "bug") => {
        setPalette(false);
        setFeedback(kind);
      },
      openQuickAdd: (defaults: QuickAddDefaults = {}) => {
        setPalette(false);
        setQuickAdd(defaults);
      },
      openNewNote: (projectId: number | null = null) => {
        setPalette(false);
        setNewNote({ projectId });
      },
      openNewPerson: () => {
        setPalette(false);
        setNewPerson(true);
      },
      openPalette: () => setPalette(true),
      openHelp: () => setHelp(true),
      close: (which: Overlay) => {
        if (which === "quickAdd") setQuickAdd(null);
        if (which === "newNote") setNewNote(null);
        if (which === "newPerson") setNewPerson(false);
        if (which === "feedback") setFeedback(null);
        if (which === "palette") setPalette(false);
        if (which === "help") setHelp(false);
      },
    }),
    [quickAdd, newNote, newPerson, feedback, palette, help, todoCommands],
  );
  return <CommandsContext.Provider value={value}>{children}</CommandsContext.Provider>;
}

export function useCommands() {
  const value = useContext(CommandsContext);
  if (!value) throw new Error("useCommands needs a CommandsProvider above it.");
  return value;
}
