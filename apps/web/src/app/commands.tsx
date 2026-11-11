import { createContext, type ReactNode, useContext, useMemo, useState } from "react";

export interface QuickAddDefaults {
  /** Start in this project (the page the todo was added from). */
  projectSlug?: string;
}

interface Commands {
  openQuickAdd: (defaults?: QuickAddDefaults) => void;
  openPalette: () => void;
  openHelp: () => void;
}

interface CommandState {
  quickAdd: QuickAddDefaults | null;
  palette: boolean;
  help: boolean;
  close: (which: "quickAdd" | "palette" | "help") => void;
}

const CommandsContext = createContext<(Commands & CommandState) | null>(null);

/** App wide overlays (quick add, palette, help) that buttons, keys and the palette can open. */
export function CommandsProvider({ children }: { children: ReactNode }) {
  const [quickAdd, setQuickAdd] = useState<QuickAddDefaults | null>(null);
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);

  const value = useMemo(
    () => ({
      quickAdd,
      palette,
      help,
      openQuickAdd: (defaults: QuickAddDefaults = {}) => {
        setPalette(false);
        setQuickAdd(defaults);
      },
      openPalette: () => setPalette(true),
      openHelp: () => setHelp(true),
      close: (which: "quickAdd" | "palette" | "help") => {
        if (which === "quickAdd") setQuickAdd(null);
        if (which === "palette") setPalette(false);
        if (which === "help") setHelp(false);
      },
    }),
    [quickAdd, palette, help],
  );
  return <CommandsContext.Provider value={value}>{children}</CommandsContext.Provider>;
}

export function useCommands() {
  const value = useContext(CommandsContext);
  if (!value) throw new Error("useCommands needs a CommandsProvider above it.");
  return value;
}
