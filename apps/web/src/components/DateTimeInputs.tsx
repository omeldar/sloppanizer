import { addDays, type DateFormat, parseDateAs, parseTime } from "@organizer/shared";
import { type KeyboardEvent, useState } from "react";
import { formatDate, formatPrefs, formatTime, today } from "../lib/format.ts";
import { Popover } from "./Popover.tsx";
import styles from "./DateTimeInputs.module.css";

/**
 * Date and time fields in the account's formats, the same in every browser: the browser's own pickers
 * follow its language (12/31/2026, 3:00 PM, Sunday first), which is not what people here expect.
 * Values stay "YYYY-MM-DD" and "HH:mm"; "" is empty. onChange fires as soon as the text is a complete
 * value, and once more on leaving the field.
 */

interface Common {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  className?: string;
  disabled?: boolean;
  required?: boolean;
  "aria-label"?: string;
  id?: string;
}

const PLACEHOLDERS: Record<DateFormat, string> = {
  "dmy.": "DD.MM.YYYY",
  "dmy/": "DD/MM/YYYY",
  "mdy/": "MM/DD/YYYY",
  "ymd-": "YYYY-MM-DD",
};

const thisYear = () => Number(today().slice(0, 4));

export function DateInput({
  value,
  onChange,
  onBlur,
  className,
  min,
  max,
  ...rest
}: Common & { min?: string; max?: string }) {
  const [text, setText] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const shown = text ?? (value ? formatDate(value) : "");
  const format = formatPrefs().dateFormat;
  const inRange = (date: string) => (!min || date >= min) && (!max || date <= max);

  const type = (next: string) => {
    setText(next);
    if (next.trim() === "") return value !== "" && onChange("");
    const parsed = parseDateAs(next, format, thisYear());
    if (parsed && parsed !== value && inRange(parsed)) onChange(parsed);
  };
  const leave = () => {
    setText(null);
    onBlur?.();
  };
  const keys = (event: KeyboardEvent<HTMLInputElement>) => {
    const step = event.key === "ArrowUp" ? 1 : event.key === "ArrowDown" ? -1 : 0;
    if (step === 0 || rest.disabled) return;
    event.preventDefault();
    const next = addDays(value || today(), step);
    if (inRange(next)) {
      setText(null);
      onChange(next);
    }
  };

  return (
    <span className={[styles.wrap, className].filter(Boolean).join(" ")}>
      <input
        {...rest}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        className={styles.input}
        value={shown}
        placeholder={PLACEHOLDERS[format]}
        data-invalid={
          (text !== null && text.trim() !== "" && parseDateAs(text, format, thisYear()) === null) || undefined
        }
        onChange={(event) => type(event.target.value)}
        onBlur={leave}
        onKeyDown={keys}
      />
      <Popover
        open={open}
        onOpenChange={setOpen}
        align="end"
        trigger={
          <button
            type="button"
            className={styles.button}
            aria-label={`Pick ${rest["aria-label"] ?? "a date"} in a calendar`}
            disabled={rest.disabled}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 20 20"
              aria-hidden="true"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
            >
              <path d="M3 5h14v12H3zM3 9h14M7 3v4M13 3v4" />
            </svg>
          </button>
        }
      >
        <Calendar
          value={value}
          min={min}
          max={max}
          onPick={(date) => {
            setText(null);
            onChange(date);
            setOpen(false);
          }}
        />
      </Popover>
    </span>
  );
}

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const pad = (n: number) => String(n).padStart(2, "0");

/** A month grid, weeks from Monday to Sunday. */
export function Calendar({
  value,
  min,
  max,
  onPick,
}: {
  value: string;
  min?: string | undefined;
  max?: string | undefined;
  onPick: (date: string) => void;
}) {
  const start = value || today();
  const [month, setMonth] = useState(start.slice(0, 7));
  const [y, m] = month.split("-").map(Number) as [number, number];
  const first = `${month}-01`;
  const offset = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
  const gridStart = addDays(first, -offset);
  const days = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  const shift = (by: number) => {
    const d = new Date(Date.UTC(y, m - 1 + by, 1));
    setMonth(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`);
  };
  const now = today();
  return (
    <div className={styles.calendar}>
      <div className={styles.calHead}>
        <button type="button" className={styles.nav} onClick={() => shift(-1)} aria-label="Previous month">
          ‹
        </button>
        <span className={styles.month}>
          {MONTHS[m - 1]} {y}
        </span>
        <button type="button" className={styles.nav} onClick={() => shift(1)} aria-label="Next month">
          ›
        </button>
      </div>
      <div className={styles.grid} role="grid" aria-label={`${MONTHS[m - 1]} ${y}`}>
        {WEEKDAYS.map((d) => (
          <span key={d} className={styles.weekday} role="columnheader">
            {d}
          </span>
        ))}
        {days.map((day) => (
          <button
            key={day}
            type="button"
            role="gridcell"
            className={styles.day}
            data-other={day.slice(0, 7) !== month || undefined}
            data-today={day === now || undefined}
            data-on={day === value || undefined}
            disabled={(min !== undefined && day < min) || (max !== undefined && day > max)}
            aria-label={formatDate(day)}
            aria-selected={day === value}
            onClick={() => onPick(day)}
          >
            {Number(day.slice(8))}
          </button>
        ))}
      </div>
      <div className={styles.calFoot}>
        <button type="button" className={styles.link} onClick={() => onPick(now)}>
          Today
        </button>
      </div>
    </div>
  );
}

/**
 * A time of day: type "15:00", "1500", "3pm" or "3:30 PM"; shown as the account shows times. Arrow keys
 * move by `step` seconds (like the browser's field; default 15 minutes).
 */
export function TimeInput({
  value,
  onChange,
  onBlur,
  className,
  step = 900,
  ...rest
}: Common & { step?: number }) {
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? (value ? formatTime(value) : "");
  const twelve = formatPrefs().timeFormat === "12h";

  const type = (next: string) => {
    setText(next);
    if (next.trim() === "") return value !== "" && onChange("");
    const parsed = parseTime(next);
    // "1" or "15" alone may still grow into "15:30": those wait for the colon, four digits or leaving.
    const complete = /[:.\sapm]|^\d{3,4}$/i.test(next.trim());
    if (parsed && complete && parsed !== value) onChange(parsed);
  };
  const leave = () => {
    if (text !== null && text.trim() !== "") {
      const parsed = parseTime(text);
      if (parsed && parsed !== value) onChange(parsed);
    }
    setText(null);
    onBlur?.();
  };
  const keys = (event: KeyboardEvent<HTMLInputElement>) => {
    const dir = event.key === "ArrowUp" ? 1 : event.key === "ArrowDown" ? -1 : 0;
    if (dir === 0 || rest.disabled) return;
    event.preventDefault();
    const stepMin = Math.max(1, Math.round(step / 60));
    const [h = 9, m = 0] = (value || "09:00").split(":").map(Number);
    const total = ((((Math.round((h * 60 + m) / stepMin) + dir) * stepMin) % 1440) + 1440) % 1440;
    setText(null);
    onChange(`${pad(Math.floor(total / 60))}:${pad(total % 60)}`);
  };

  return (
    <input
      {...rest}
      type="text"
      autoComplete="off"
      className={[styles.time, className].filter(Boolean).join(" ")}
      value={shown}
      placeholder={twelve ? "9:00 AM" : "09:00"}
      data-invalid={(text !== null && text.trim() !== "" && parseTime(text) === null) || undefined}
      onChange={(event) => type(event.target.value)}
      onBlur={leave}
      onKeyDown={keys}
    />
  );
}
