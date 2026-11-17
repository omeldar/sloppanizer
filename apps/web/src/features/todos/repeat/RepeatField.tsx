import { describeRecurrence, ordinal, type RecurrenceRule, WEEKDAYS, type Weekday } from "@organizer/shared";
import { type FormEvent, useId, useState } from "react";
import { Popover } from "../../../components/Popover.tsx";
import { Button, FieldButton } from "../../../components/ui.tsx";
import { formatDate, today as localToday } from "../../../lib/format.ts";
import { checkRule, type Draft, draftFrom, presets, ruleFrom, sameRule, WEEKDAY_SHORT } from "./repeat.ts";
import styles from "./Repeat.module.css";

const UNITS = [
  { value: "day", one: "day", many: "days" },
  { value: "week", one: "week", many: "weeks" },
  { value: "month", one: "month", many: "months" },
  { value: "year", one: "year", many: "years" },
] as const;

const NTHS = [1, 2, 3, 4, -1] as const;

interface Props {
  value: RecurrenceRule | null;
  /** The todo's due date, else its planned day; null = repeating is not possible yet. */
  anchor: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Saves the rule (null stops repeating). */
  onChange: (rule: RecurrenceRule | null) => void;
}

/** The Repeat field: plain words for the rule, a popover with presets and a custom form. */
export function RepeatField({ value, anchor, open, onOpenChange, onChange }: Props) {
  const hintId = useId();
  if (!anchor) {
    return (
      <span className={styles.disabled}>
        <FieldButton empty disabled aria-label="Repeat" aria-describedby={hintId}>
          Does not repeat
        </FieldButton>
        <span id={hintId} className={styles.hint}>
          Set a due date or planned day first.
        </span>
      </span>
    );
  }
  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      trigger={
        <FieldButton empty={value === null} aria-label="Repeat">
          {value ? describeRecurrence(value) : "Does not repeat"}
        </FieldButton>
      }
    >
      {open && (
        <RepeatPanel
          value={value}
          anchor={anchor}
          onPick={(rule) => {
            onOpenChange(false);
            onChange(rule);
          }}
        />
      )}
    </Popover>
  );
}

export function RepeatPanel({
  value,
  anchor,
  onPick,
}: {
  value: RecurrenceRule | null;
  anchor: string;
  onPick: (rule: RecurrenceRule | null) => void;
}) {
  const today = localToday();
  const choices = presets(anchor);
  const isPreset = value !== null && choices.some((p) => sameRule(p.rule, value, anchor));
  const [custom, setCustom] = useState(value !== null && !isPreset);

  if (custom) {
    return (
      <CustomForm
        value={value}
        anchor={anchor}
        today={today}
        onSave={onPick}
        onBack={() => setCustom(false)}
      />
    );
  }
  return (
    <div className={styles.panel} role="group" aria-label="Repeat">
      <ul className={styles.choices}>
        <li>
          <button
            type="button"
            className={styles.choice}
            aria-pressed={value === null}
            onClick={() => onPick(null)}
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- the panel opens to pick
            autoFocus={value === null}
          >
            Does not repeat
          </button>
        </li>
        {choices.map((preset) => {
          const on = value !== null && sameRule(preset.rule, value, anchor);
          const check = checkRule(preset.rule, anchor, today);
          return (
            <li key={preset.label}>
              <button
                type="button"
                className={styles.choice}
                aria-pressed={on}
                onClick={() => onPick(preset.rule)}
                // oxlint-disable-next-line jsx-a11y/no-autofocus -- focus starts on the current choice
                autoFocus={on}
              >
                {preset.label}
                {check.ok && check.next && <span className={styles.next}>next {check.next}</span>}
              </button>
            </li>
          );
        })}
        <li>
          <button
            type="button"
            className={styles.choice}
            aria-pressed={value !== null && !isPreset}
            onClick={() => setCustom(true)}
          >
            Custom
          </button>
        </li>
      </ul>
    </div>
  );
}

function CustomForm({
  value,
  anchor,
  today,
  onSave,
  onBack,
}: {
  value: RecurrenceRule | null;
  anchor: string;
  today: string;
  onSave: (rule: RecurrenceRule) => void;
  onBack: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(value, anchor));
  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  const check = checkRule(ruleFrom(draft), anchor, today);
  const pattern = draft.basis === "schedule";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (check.ok) onSave(check.rule);
  };

  const toggleDay = (day: Weekday) =>
    set({
      weekdays: draft.weekdays.includes(day)
        ? draft.weekdays.filter((d) => d !== day)
        : [...draft.weekdays, day],
    });

  return (
    <form className={styles.form} onSubmit={submit} aria-label="Custom repeat">
      <div className={styles.row}>
        <span>Every</span>
        <input
          type="number"
          min={1}
          max={99}
          className={styles.number}
          aria-label="Interval"
          value={draft.interval}
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- the form opens to type
          autoFocus
          onChange={(e) => set({ interval: Number(e.target.value) })}
        />
        <select
          className={styles.select}
          aria-label="Unit"
          value={draft.every}
          onChange={(e) => set({ every: e.target.value as Draft["every"] })}
        >
          {UNITS.map((u) => (
            <option key={u.value} value={u.value}>
              {draft.interval === 1 ? u.one : u.many}
            </option>
          ))}
        </select>
      </div>

      {pattern && draft.every === "week" && (
        <div className={styles.weekdays} role="group" aria-label="Weekdays">
          {WEEKDAYS.map((day) => (
            <button
              key={day}
              type="button"
              className={styles.day}
              aria-pressed={draft.weekdays.includes(day)}
              onClick={() => toggleDay(day)}
            >
              {WEEKDAY_SHORT[day]}
            </button>
          ))}
        </div>
      )}

      {pattern && draft.every === "month" && (
        <fieldset className={styles.fieldset}>
          <legend className="visually-hidden">Day of the month</legend>
          <label className={styles.row}>
            <input
              type="radio"
              name="monthMode"
              checked={draft.monthMode === "day"}
              onChange={() => set({ monthMode: "day" })}
            />
            <span>On day</span>
            <select
              className={styles.select}
              aria-label="Day of the month"
              value={draft.monthDay}
              onChange={(e) => set({ monthMode: "day", monthDay: Number(e.target.value) })}
            >
              {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d}>
                  {ordinal(d)}
                </option>
              ))}
              <option value={-1}>last</option>
            </select>
          </label>
          <label className={styles.row}>
            <input
              type="radio"
              name="monthMode"
              checked={draft.monthMode === "weekday"}
              onChange={() => set({ monthMode: "weekday" })}
            />
            <span>On the</span>
            <select
              className={styles.select}
              aria-label="Which weekday of the month"
              value={draft.nth}
              onChange={(e) => set({ monthMode: "weekday", nth: Number(e.target.value) as Draft["nth"] })}
            >
              {NTHS.map((n) => (
                <option key={n} value={n}>
                  {n === -1 ? "last" : ordinal(n)}
                </option>
              ))}
            </select>
            <select
              className={styles.select}
              aria-label="Weekday"
              value={draft.nthWeekday}
              onChange={(e) => set({ monthMode: "weekday", nthWeekday: e.target.value as Weekday })}
            >
              {WEEKDAYS.map((day) => (
                <option key={day} value={day}>
                  {WEEKDAY_SHORT[day]}
                </option>
              ))}
            </select>
          </label>
        </fieldset>
      )}

      {pattern && draft.every === "year" && (
        <label className={styles.row}>
          <span>On</span>
          <input
            className={styles.text}
            aria-label="Day and month (dd.MM.)"
            value={draft.yearDate}
            maxLength={6}
            placeholder="14.03."
            onChange={(e) => set({ yearDate: e.target.value })}
          />
        </label>
      )}

      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>Count the next one</legend>
        <label className={styles.row}>
          <input
            type="radio"
            name="basis"
            checked={draft.basis === "schedule"}
            onChange={() => set({ basis: "schedule" })}
          />
          <span>from the schedule</span>
        </label>
        <label className={styles.row}>
          <input
            type="radio"
            name="basis"
            checked={draft.basis === "done"}
            onChange={() => set({ basis: "done" })}
          />
          <span>from when it is done</span>
        </label>
      </fieldset>

      <label className={styles.row}>
        <span>Ends</span>
        <input
          type="date"
          className={styles.text}
          aria-label="Ends on"
          value={draft.until}
          onChange={(e) => set({ until: e.target.value })}
        />
        {draft.until && (
          <button type="button" className={styles.clear} onClick={() => set({ until: "" })}>
            Never
          </button>
        )}
      </label>

      <p className={styles.preview} data-problem={!check.ok || undefined} aria-live="polite">
        {check.ok
          ? check.next
            ? `${check.text}. Next: ${formatDate(check.next)}`
            : `${check.text}. No next one: the end date has passed.`
          : check.problem}
      </p>
      <div className={styles.actions}>
        <Button size="sm" variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button size="sm" type="submit" variant="primary" disabled={!check.ok}>
          Save repeat
        </Button>
      </div>
    </form>
  );
}
