import { createContext, type ReactNode, useContext, useMemo, useState } from "react";

export interface QuickAddDefaults {
  /** Start in this project (the page the todo was added from). */
  projectSlug?: string;
}

interface Commands {
  openQuickAdd: (defaults?: QuickAddDefaults) => void;
  /** Opens the new note dialog; the note starts in this project (null = none). */
  openNewNote: (projectId?: number | null) => void;
  openNewPerson: () => void;
  openPalette: () => void;
  openHelp: () => void;
}

interface CommandState {
  quickAdd: QuickAddDefaults | null;
  /** Open when not undefined; the value is the start project. */
  newNote: { projectId: number | null } | null;
  newPerson: boolean;
  palette: boolean;
  help: boolean;
  close: (which: Overlay) => void;
}

type Overlay = "quickAdd" | "newNote" | "newPerson" | "palette" | "help";

const CommandsContext = createContext<(Commands & CommandState) | null>(null);

/** App wide overlays (quick add, new note, new person, palette, help) that buttons, keys and the palette can open. */
export function CommandsProvider({ children }: { children: ReactNode }) {
  const [quickAdd, setQuickAdd] = useState<QuickAddDefaults | null>(null);
  const [newNote, setNewNote] = useState<{ projectId: number | null } | null>(null);
  const [newPerson, setNewPerson] = useState(false);
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);

  const value = useMemo(
    () => ({
      quickAdd,
      newNote,
      newPerson,
      palette,
      help,
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
        if (which === "palette") setPalette(false);
        if (which === "help") setHelp(false);
      },
    }),
    [quickAdd, newNote, newPerson, palette, help],
  );
  return <CommandsContext.Provider value={value}>{children}</CommandsContext.Provider>;
}

export function useCommands() {
  const value = useContext(CommandsContext);
  if (!value) throw new Error("useCommands needs a CommandsProvider above it.");
  return value;
}
