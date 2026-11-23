import {
  addMinutesToTime,
  lastStartBefore,
  type Meeting,
  type MeetingType,
  normalizeRecurrence,
  type RecurrenceRule,
  type ScheduleChange,
  type Series,
  type SeriesScope,
  type StandupFilter,
  suggestMeetingType,
  type UpdateMeeting,
  weekdayOf,
} from "@organizer/shared";
import { useNavigate } from "@tanstack/react-router";
import { type CSSProperties, type FormEvent, useState } from "react";
import { Dialog } from "../../components/Dialog.tsx";
import { Popover } from "../../components/Popover.tsx";
import { Picker } from "../../components/pickers/Picker.tsx";
import pickerStyles from "../../components/pickers/Picker.module.css";
import { LabelPill } from "../../components/LabelPill.tsx";
import { SeriesScopeDialog } from "../../components/SeriesScopeDialog.tsx";
import { Button, Field, FieldButton, TextInput } from "../../components/ui.tsx";
import { errorMessage } from "../../lib/api.ts";
import { dayLabel, formatDayMonth, timeZone, toDate, today as localToday } from "../../lib/format.ts";
import { useChangeSchedule, useCreateMeeting, useUpdateMeeting } from "../../lib/meetings.ts";
import { useLabels, useProjects } from "../../lib/queries.ts";
import { lengthMinutes } from "../planner/planner.ts";
import { RepeatField } from "../todos/repeat/RepeatField.tsx";
import styles from "./Meetings.module.css";
import { DateInput, TimeInput } from "../../components/DateTimeInputs.tsx";

/** A new meeting, or an existing one to edit; `from` is the date a repeat change starts at. */
export type MeetingDraft = { meeting?: undefined } | { meeting: Meeting; from: string };

export function MeetingDialog({ draft, onClose }: { draft: MeetingDraft | null; onClose: () => void }) {
  return (
    <Dialog
      open={draft !== null}
      onOpenChange={(open) => !open && onClose()}
      title={draft?.meeting ? "Edit meeting" : "New meeting"}
      width={500}
    >
      {draft && <MeetingForm key={draft.meeting?.id ?? "new"} draft={draft} onClose={onClose} />}
    </Dialog>
  );
}

const weeklyOn = (date: string): RecurrenceRule =>
  normalizeRecurrence({ every: "week", weekdays: [weekdayOf(date)] }, date);

/** The rule without its end (the end is the segment's own date), for comparing. */
const ruleKey = (rule: RecurrenceRule) => JSON.stringify({ ...rule, until: undefined });

const toggle = (ids: readonly number[], id: number): number[] =>
  ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];

const EMPTY_FILTER: StandupFilter = { projectIds: [], inbox: false, labelIds: [] };

/** Where a new standup's list counts from: the day of the last meeting before now. */
export function firstCountFrom(
  schedule: { rule: RecurrenceRule; startsOn: string; startTime: string; durationMinutes: number },
  now: Date,
): string {
  return toDate(lastStartBefore({ ...schedule, endsOn: null }, now, timeZone));
}

function MeetingForm({ draft, onClose }: { draft: MeetingDraft; onClose: () => void }) {
  const navigate = useNavigate();
  const create = useCreateMeeting();
  const update = useUpdateMeeting();
  const changeSchedule = useChangeSchedule();
  const editing = draft.meeting;
  const segment: Series | undefined = editing
    ? (editing.segments.find((s) => s.startsOn <= draft.from && (s.endsOn ?? "9999") >= draft.from) ??
      editing.schedule)
    : undefined;

  const [name, setName] = useState(editing?.name ?? "");
  const [type, setType] = useState<MeetingType>(editing?.type ?? "other");
  const [typeTouched, setTypeTouched] = useState(editing !== undefined);
  const [startsOn, setStartsOn] = useState(editing ? draft.from : localToday());
  const [rule, setRule] = useState<RecurrenceRule>(() =>
    segment ? { ...segment.rule, until: segment.endsOn } : weeklyOn(localToday()),
  );
  const [ruleTouched, setRuleTouched] = useState(editing !== undefined);
  const [start, setStart] = useState(segment?.startTime ?? "09:00");
  const [end, setEnd] = useState(
    segment ? addMinutesToTime(segment.startTime, segment.durationMinutes) : "09:15",
  );
  const [filter, setFilter] = useState<StandupFilter>(editing?.filter ?? EMPTY_FILTER);
  const initialCount = editing ? toDate(editing.since) : null;
  const [countFrom, setCountFrom] = useState<string | null>(initialCount);
  const [repeatOpen, setRepeatOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [askScope, setAskScope] = useState<ScheduleChange | null>(null);

  const duration = lengthMinutes(start, end);
  const schedule = { rule, startsOn, startTime: start, durationMinutes: duration };
  const [now] = useState(() => new Date());
  const suggestedCount = firstCountFrom(schedule, now);
  const shownCount = countFrom ?? suggestedCount;
  const standup = type === "standup";
  const busy = create.isPending || update.isPending || changeSchedule.isPending;

  const changeName = (value: string) => {
    setName(value);
    // The name picks the type until the user picks one.
    if (!typeTouched) setType(suggestMeetingType(value));
  };
  const changeStart = (value: string) => {
    setStartsOn(value);
    if (!ruleTouched && value) setRule(weeklyOn(value));
  };

  /** The repeat change of an edit, or null when the repeat stays. */
  const scheduleChange = (): Omit<ScheduleChange, "scope"> | null => {
    if (!segment) return null;
    const change: Omit<ScheduleChange, "scope"> = { from: draft.meeting ? draft.from : startsOn };
    if (ruleKey(rule) !== ruleKey(segment.rule)) change.rule = { ...rule, until: undefined };
    if ((rule.until ?? null) !== segment.endsOn) change.endsOn = rule.until ?? null;
    if (start !== segment.startTime) change.startTime = start;
    if (duration !== segment.durationMinutes) change.durationMinutes = duration;
    return Object.keys(change).length > 1 ? change : null;
  };

  const meetingPatch = (): UpdateMeeting | null => {
    if (!editing) return null;
    const patch: Partial<UpdateMeeting> = {};
    if (name.trim() !== editing.name) patch.name = name.trim();
    if (type !== editing.type) patch.type = type;
    if (JSON.stringify(filter) !== JSON.stringify(editing.filter)) patch.filter = filter;
    if (countFrom !== null && countFrom !== initialCount) patch.countFrom = countFrom;
    return Object.keys(patch).length > 0 ? (patch as UpdateMeeting) : null;
  };

  const saveEdit = async (scope: SeriesScope | null) => {
    if (!editing) return;
    try {
      const patch = meetingPatch();
      if (patch) await update.mutateAsync({ id: editing.id, patch });
      const change = scheduleChange();
      if (change && (scope === "following" || scope === "all")) {
        await changeSchedule.mutateAsync({ id: editing.id, change: { ...change, scope } });
      }
      setAskScope(null);
      onClose();
    } catch (failure) {
      setAskScope(null);
      setError(errorMessage(failure));
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (name.trim() === "") return setError("Give the meeting a name.");
    if (duration < 5) return setError("A meeting lasts at least 5 minutes.");
    if (editing) {
      const change = scheduleChange();
      if (change) setAskScope({ ...change, scope: "following" });
      else void saveEdit(null);
      return;
    }
    const { until, ...plain } = rule;
    create.mutate(
      {
        name: name.trim(),
        type,
        schedule: {
          rule: plain,
          startsOn,
          endsOn: until ?? null,
          startTime: start,
          durationMinutes: duration,
        },
        ...(standup && { filter }),
        ...(standup && countFrom !== null && { countFrom }),
      },
      {
        onSuccess: (meeting) => {
          onClose();
          void navigate({ to: "/meetings/$id", params: { id: String(meeting.id) } });
        },
        onError: (failure) => setError(errorMessage(failure)),
      },
    );
  };

  const laterPart = editing && segment && editing.segments.length > 1;
  return (
    <>
      <form className={styles.form} onSubmit={submit}>
        <Field label="Name">
          <TextInput
            value={name}
            onChange={(event) => changeName(event.target.value)}
            placeholder="Team standup, 1:1 with Bo"
            maxLength={200}
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- the dialog opens to type the name
            autoFocus={!editing}
            required
          />
        </Field>
        <div className={styles.typeRow} role="radiogroup" aria-label="Type">
          {(["standup", "other"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={type === value}
              className={styles.typeChoice}
              onClick={() => {
                setType(value);
                setTypeTouched(true);
              }}
            >
              {value === "standup" ? "Standup" : "Other"}
            </button>
          ))}
          <span className={styles.typeHint}>
            {standup ? "Has a list of what you did not say yet." : "A plain meeting with a note per date."}
          </span>
        </div>

        <div className={styles.timeRow}>
          <Field label={editing ? "From the date" : "First date"}>
            <DateInput
              value={startsOn}
              onChange={(value) => changeStart(value)}
              disabled={editing !== undefined}
              required
            />
          </Field>
          <Field label="From">
            <TimeInput step={300} value={start} onChange={(value) => setStart(value)} required />
          </Field>
          <Field label="To">
            <TimeInput step={300} value={end} onChange={(value) => setEnd(value)} required />
          </Field>
        </div>
        <div className={styles.repeatRow}>
          <span className={styles.label}>Repeats</span>
          <RepeatField
            value={rule}
            anchor={startsOn || null}
            open={repeatOpen}
            onOpenChange={setRepeatOpen}
            scheduleOnly
            onChange={(picked) => {
              if (!picked) return;
              setRule(picked);
              setRuleTouched(true);
            }}
          />
        </div>

        {standup && (
          <>
            <Field
              label="Count from"
              hint={
                countFrom === null
                  ? `The list starts with what happened since the last meeting on ${dayLabel(suggestedCount)}`
                  : "The list counts what happened since the start of this day."
              }
            >
              <DateInput value={shownCount} onChange={(value) => setCountFrom(value || null)} />
            </Field>
            <FilterFields filter={filter} onChange={setFilter} />
          </>
        )}

        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        <div className={styles.actions}>
          <span className={styles.spacer} />
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {editing ? "Save" : "Create meeting"}
          </Button>
        </div>
      </form>
      <SeriesScopeDialog
        open={askScope !== null}
        title="Change the repeat for"
        options={[
          { scope: "following", hint: `From ${formatDayMonth(draft.meeting ? draft.from : startsOn)} on` },
          {
            scope: "all",
            hint: laterPart
              ? `Every date of this part of the repeat, from ${formatDayMonth(segment.startsOn)} on`
              : "Every date, also the past ones",
          },
        ]}
        busy={busy}
        onPick={(scope) => void saveEdit(scope)}
        onCancel={() => setAskScope(null)}
      />
    </>
  );
}

/** Which todos a standup looks at: projects (and the Inbox) and labels; empty = everything. */
function FilterFields({
  filter,
  onChange,
}: {
  filter: StandupFilter;
  onChange: (filter: StandupFilter) => void;
}) {
  const projects = useProjects();
  const labels = useLabels();
  const [open, setOpen] = useState<"projects" | "labels" | null>(null);
  const active = (projects.data ?? []).filter((p) => p.archivedAt === null);
  const chosenProjects = [
    ...(filter.inbox ? ["Inbox"] : []),
    ...active.filter((p) => filter.projectIds.includes(p.id)).map((p) => p.name),
  ];
  const chosenLabels = (labels.data ?? []).filter((l) => filter.labelIds.includes(l.id));

  return (
    <div className={styles.filter}>
      <span className={styles.label}>Looks at</span>
      <Popover
        open={open === "projects"}
        onOpenChange={(next) => setOpen(next ? "projects" : null)}
        trigger={
          <FieldButton empty={chosenProjects.length === 0} aria-label="Projects">
            {chosenProjects.length === 0 ? "All projects and the Inbox" : chosenProjects.join(", ")}
          </FieldButton>
        }
      >
        <Picker
          label="Projects"
          placeholder="Pick projects"
          items={[
            { value: "inbox", label: <span className={pickerStyles.sub}>Inbox (no project)</span> },
            ...active.map((p) => ({
              value: String(p.id),
              search: p.name,
              label: (
                <>
                  <span className={pickerStyles.swatch} style={{ "--swatch": p.color } as CSSProperties} />
                  {p.name}
                </>
              ),
            })),
          ]}
          selected={
            new Set([...(filter.inbox ? ["inbox"] : []), ...filter.projectIds.map((id) => String(id))])
          }
          onPick={(value) =>
            onChange(
              value === "inbox"
                ? { ...filter, inbox: !filter.inbox }
                : { ...filter, projectIds: toggle(filter.projectIds, Number(value)) },
            )
          }
          empty="No project matches."
        />
      </Popover>
      <Popover
        open={open === "labels"}
        onOpenChange={(next) => setOpen(next ? "labels" : null)}
        trigger={
          <FieldButton empty={chosenLabels.length === 0} aria-label="Labels">
            {chosenLabels.length === 0
              ? "Any labels"
              : chosenLabels.map((l) => <LabelPill key={l.id} name={l.name} color={l.color} />)}
          </FieldButton>
        }
      >
        <Picker
          label="Labels"
          placeholder="Pick labels"
          items={(labels.data ?? []).map((l) => ({
            value: String(l.id),
            search: l.name,
            label: <LabelPill name={l.name} color={l.color} />,
          }))}
          selected={new Set(filter.labelIds.map((id) => String(id)))}
          onPick={(value) => onChange({ ...filter, labelIds: toggle(filter.labelIds, Number(value)) })}
          empty="No label matches."
        />
      </Popover>
      <span className={styles.fieldHint}>
        Todos in one of the projects and with any one of the labels. Empty means everything.
      </span>
    </div>
  );
}
