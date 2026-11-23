import { DateFormat, DEFAULT_FORMATS, type FormatPrefs, TimeFormat } from "@organizer/shared";
import { Fragment, type ReactNode, useEffect, useState } from "react";
import { useAccountProfile } from "./accountQueries.ts";
import { setFormatPrefs } from "./format.ts";

/**
 * The account's date and time formats. The last known ones are kept in the browser so the first paint
 * already uses them; the profile from the server then wins. A change re-renders everything below
 * (format.ts is plain functions, not hooks).
 */
const key = (accountId: number) => `sloppanizer.formats.${accountId}`;

function cached(accountId: number): FormatPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(key(accountId)) ?? "null") as Partial<FormatPrefs> | null;
    return {
      dateFormat: DateFormat.catch(DEFAULT_FORMATS.dateFormat).parse(raw?.dateFormat),
      timeFormat: TimeFormat.catch(DEFAULT_FORMATS.timeFormat).parse(raw?.timeFormat),
    };
  } catch {
    return DEFAULT_FORMATS;
  }
}

export function FormatPrefsProvider({ accountId, children }: { accountId: number; children: ReactNode }) {
  const [start] = useState(() => cached(accountId));
  const profile = useAccountProfile();
  const prefs: FormatPrefs = profile.data
    ? { dateFormat: profile.data.dateFormat, timeFormat: profile.data.timeFormat }
    : start;
  // Before the children render: format.ts is read while they render.
  setFormatPrefs(prefs);
  const { dateFormat, timeFormat } = prefs;
  useEffect(() => {
    try {
      localStorage.setItem(key(accountId), JSON.stringify({ dateFormat, timeFormat }));
    } catch {
      // Private mode: the server's answer is used on every start instead.
    }
  }, [accountId, dateFormat, timeFormat]);
  return <Fragment key={`${dateFormat}|${timeFormat}`}>{children}</Fragment>;
}
