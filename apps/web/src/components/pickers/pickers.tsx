import { applyLabelChange, parseLabelName, type Person, scopeKey } from "@organizer/shared";
import { type CSSProperties, useState } from "react";
import { useLabels, usePeople, useProjects, useUsers } from "../../lib/queries.ts";
import { LabelPill } from "../LabelPill.tsx";
import { Picker, type PickerItem } from "./Picker.tsx";
import styles from "./Picker.module.css";

const INBOX = "inbox";
const NOWHERE: readonly PickerItem[] = [];

export function ProjectPicker({
  value,
  onChange,
  noneLabel = "Inbox (no project)",
  elsewhere = NOWHERE,
  onElsewhere,
}: {
  value: number | null;
  onChange: (projectId: number | null) => void;
  /** Name of the "no project" choice: todos without one are in the Inbox, notes just have none. */
  noneLabel?: string;
  /** Places in other accounts (shared projects, your own todos), after the projects here. */
  elsewhere?: readonly PickerItem[];
  onElsewhere?: (value: string) => void;
}) {
  const projects = useProjects();
  const items = [
    { value: INBOX, label: <span className={styles.sub}>{noneLabel}</span>, search: noneLabel },
    ...(projects.data ?? [])
      .filter((p) => p.archivedAt === null)
      .map((p) => ({
        value: String(p.id),
        search: `${p.name} ${p.slug}`,
        label: (
          <>
            <span className={styles.swatch} style={{ "--swatch": p.color } as CSSProperties} />
            {p.name}
          </>
        ),
      })),
    ...elsewhere,
  ];
  const other = new Set(elsewhere.map((item) => item.value));
  return (
    <Picker
      label="Project"
      placeholder="Move to project"
      items={items}
      selected={new Set([value === null ? INBOX : String(value)])}
      onPick={(picked) => {
        if (other.has(picked)) onElsewhere?.(picked);
        else onChange(picked === INBOX ? null : Number(picked));
      }}
      empty="No project matches. Create projects in the sidebar."
    />
  );
}

/** Toggling a label in a local list, with the scope rule applied. */
export function toggleLabel(current: readonly string[], name: string): string[] {
  const has = current.some((n) => n.toLowerCase() === name.toLowerCase());
  return has ? applyLabelChange(current, { remove: [name] }) : applyLabelChange(current, { add: [name] });
}

/** Shows which label a scoped pick replaces, e.g. "replaces priority::high". */
export function LabelPicker({
  value,
  onToggle,
}: {
  value: readonly string[];
  onToggle: (name: string) => void;
}) {
  const labels = useLabels();
  const selected = new Set(value.map((n) => n.toLowerCase()));
  const items = (labels.data ?? []).map((label) => {
    const lower = label.name.toLowerCase();
    const sibling =
      label.scope === null || selected.has(lower)
        ? undefined
        : value.find((n) => {
            const scope = parseLabelName(n).scope;
            return scope !== null && scopeKey(scope) === scopeKey(label.scope ?? "");
          });
    return {
      value: lower,
      search: label.name,
      label: <LabelPill name={label.name} color={label.color} />,
      note: sibling ? `replaces ${sibling}` : undefined,
    };
  });
  return (
    <Picker
      label="Labels"
      placeholder="Add or remove labels"
      items={items}
      selected={selected}
      onPick={(lower) => {
        const label = labels.data?.find((l) => l.name.toLowerCase() === lower);
        if (label) onToggle(label.name);
      }}
      empty="No label matches. Create labels on the Labels page."
    />
  );
}

/** Splits "Anna Maria Meier" into first "Anna Maria" and last "Meier". */
export function splitName(text: string): { firstName: string; lastName: string } | null {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  const lastName = parts.pop() as string;
  return { firstName: parts.join(" "), lastName };
}

export type PersonChoice =
  | { personId: number; displayName: string }
  | { firstName: string; lastName: string; displayName: string }
  /** A Sloppanizer user: becomes (or finds) the person linked to them. */
  | { username: string; displayName: string };

export function PeoplePicker({
  value,
  onToggle,
  label = "Requested by",
}: {
  value: readonly PersonChoice[];
  onToggle: (choice: PersonChoice) => void;
  /** Requested by or Contacts. */
  label?: string;
}) {
  const [search, setSearch] = useState("");
  const people = usePeople({ q: search.trim() });
  const users = useUsers(search.trim());
  const chosenIds = new Set(
    value.flatMap((c) =>
      "personId" in c ? [String(c.personId)] : "username" in c ? [`user:${c.username}`] : [],
    ),
  );
  // A user who already is one of your people shows as that person.
  const linked = new Set((people.data ?? []).map((p) => p.username).filter(Boolean));
  const userItems = (users.data ?? [])
    .filter((user) => !linked.has(user.username))
    .map((user) => ({
      value: `user:${user.username}`,
      label: (
        <>
          {user.name}
          <span className={styles.sub}>@{user.username}, Sloppanizer user</span>
        </>
      ),
    }));
  const items = [
    ...(people.data ?? []).map((person: Person) => ({
      value: String(person.id),
      label: (
        <>
          {person.displayName}
          {person.username ? (
            <span className={styles.sub}>@{person.username}</span>
          ) : (
            (person.note || person.team) && <span className={styles.sub}>{person.note || person.team}</span>
          )}
        </>
      ),
    })),
    ...userItems,
  ];
  return (
    <Picker
      label={label}
      placeholder="Search people and users, or type First Last"
      items={items}
      selected={chosenIds}
      search={search}
      onSearchChange={setSearch}
      onPick={(id) => {
        if (id.startsWith("user:")) {
          const user = users.data?.find((u) => `user:${u.username}` === id);
          if (user) onToggle({ username: user.username, displayName: user.name });
          return;
        }
        const person = people.data?.find((p) => String(p.id) === id);
        if (person) onToggle({ personId: person.id, displayName: person.displayName });
      }}
      createItem={(text) => {
        const name = splitName(text);
        if (!name) return null;
        const exists = (people.data ?? []).some(
          (p) =>
            p.firstName.toLowerCase() === name.firstName.toLowerCase() &&
            p.lastName.toLowerCase() === name.lastName.toLowerCase(),
        );
        if (exists) return null;
        const displayName = `${name.firstName} ${name.lastName}`;
        return {
          label: `Add ${displayName} as a new person`,
          run: () => {
            onToggle({ ...name, displayName });
            setSearch("");
          },
        };
      }}
      empty={
        search.trim()
          ? "Nobody matches. Type first and last name to add someone."
          : "No people yet. Type first and last name to add someone."
      }
    />
  );
}
