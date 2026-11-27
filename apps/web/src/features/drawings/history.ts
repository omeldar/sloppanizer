import { useCallback, useMemo, useReducer } from "react";
import type { Page, Stroke } from "./model.ts";

/** Undo and redo over whole pages: each finished stroke, a clear or a loaded copy is one step. */
interface History {
  past: Page[];
  present: Page;
  future: Page[];
}

type Action =
  | { type: "stroke"; stroke: Stroke }
  | { type: "clear" }
  | { type: "load"; page: Page }
  | { type: "undo" }
  | { type: "redo" };

const MAX_STEPS = 200;

function step(history: History, present: Page): History {
  return { past: [...history.past, history.present].slice(-MAX_STEPS), present, future: [] };
}

export function historyReducer(history: History, action: Action): History {
  switch (action.type) {
    case "stroke":
      return step(history, { ...history.present, strokes: [...history.present.strokes, action.stroke] });
    case "clear":
      if (history.present.strokes.length === 0 && history.present.background === null) return history;
      return step(history, { ...history.present, strokes: [], background: null });
    case "load":
      return step(history, action.page);
    case "undo": {
      const previous = history.past.at(-1);
      if (!previous) return history;
      return {
        past: history.past.slice(0, -1),
        present: previous,
        future: [history.present, ...history.future],
      };
    }
    case "redo": {
      const next = history.future[0];
      if (!next) return history;
      return { past: [...history.past, history.present], present: next, future: history.future.slice(1) };
    }
  }
}

export interface Drawing {
  page: Page;
  canUndo: boolean;
  canRedo: boolean;
  /** Something was drawn, cleared or loaded since the start. */
  changed: boolean;
  addStroke: (stroke: Stroke) => void;
  clear: () => void;
  undo: () => void;
  redo: () => void;
  /** Replaces the page (a copy of a recent drawing); undo brings the old one back. */
  load: (page: Page) => void;
  /** Starts over with this page and no history (an existing drawing opened for editing). */
  reset: (page: Page) => void;
}

export function useDrawing(initial: Page): Drawing {
  const [history, dispatch] = useReducer(
    (state: History, action: Action | { type: "reset"; page: Page }) =>
      action.type === "reset"
        ? { past: [], present: action.page, future: [] }
        : historyReducer(state, action),
    { past: [], present: initial, future: [] },
  );
  const addStroke = useCallback((stroke: Stroke) => dispatch({ type: "stroke", stroke }), []);
  const clear = useCallback(() => dispatch({ type: "clear" }), []);
  const undo = useCallback(() => dispatch({ type: "undo" }), []);
  const redo = useCallback(() => dispatch({ type: "redo" }), []);
  const load = useCallback((page: Page) => dispatch({ type: "load", page }), []);
  const reset = useCallback((page: Page) => dispatch({ type: "reset", page }), []);
  return useMemo(
    () => ({
      page: history.present,
      canUndo: history.past.length > 0,
      canRedo: history.future.length > 0,
      changed: history.past.length > 0,
      addStroke,
      clear,
      undo,
      redo,
      load,
      reset,
    }),
    [history, addStroke, clear, undo, redo, load, reset],
  );
}
