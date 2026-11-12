import { useEffect, useRef, useState } from "react";
import { useDebounced } from "./useDebounced.ts";
import { useOnChange } from "./useOnChange.ts";

/**
 * A text field bound to a URL search value. Typing shows at once; the trimmed text goes to the URL (and
 * so to the query) once typing pauses for `ms`, not on every key. A URL change from elsewhere (Back, a
 * link, the palette's "Show all results") shows in the field instead of being written over.
 * Returns the field text and the settled text the page should query with.
 */
export function useUrlText(urlValue: string, writeUrl: (value: string) => void, ms = 150) {
  const [text, setText] = useState(urlValue);
  const settled = useDebounced(text.trim(), ms);
  // Our own writes arrive as the settled text; anything else came from outside.
  useOnChange(urlValue, (next) => {
    if (next !== settled) setText(next);
  });
  const latestWrite = useRef(writeUrl);
  useEffect(() => {
    latestWrite.current = writeUrl;
  });
  useEffect(() => {
    // Only once the text settled: while it still changes, the URL keeps its value.
    if (settled === text.trim() && settled !== urlValue) latestWrite.current(settled);
  }, [settled, text, urlValue]);
  return { text, setText, settled };
}
