import { applyLabelChange, parseLabelName, type Person, scopeKey } from "@organizer/shared";
import { type CSSProperties, useState } from "react";
import { usePeople, useLabels, useProjects } from "../../lib/queries.ts";
import { LabelPill } from "../LabelPill.tsx";
import { Picker } from "./Picker.tsx";
import styles from "./Picker.module.css";

const INBOX = "inbox";

export function ProjectPicker({
  value,
  onChange,
  noneLabel = "Inbox (no project)",
}: {
  value: number | null;
  onChange: (projectId: number | null) => void;
  /** Name of the "no project" choice: todos without one are in the Inbox, notes just have none. */
  noneLabel?: string;
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
  ];
  return (
    <Picker
      label="Project"
      placeholder="Move to project"
      items={items}
      selected={new Set([value === null ? INBOX : String(value)])}
      onPick={(picked) => onChange(picked === INBOX ? null : Number(picked))}
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
  | { firstName: string; lastName: string; displayName: string };

export function PeoplePicker({
  value,
  onToggle,
}: {
  value: readonly PersonChoice[];
  onToggle: (choice: PersonChoice) => void;
}) {
  const [search, setSearch] = useState("");
  const people = usePeople({ q: search.trim() });
  const chosenIds = new Set(value.flatMap((c) => ("personId" in c ? [String(c.personId)] : [])));
  const items = (people.data ?? []).map((person: Person) => ({
    value: String(person.id),
    label: (
      <>
        {person.displayName}
        {person.note && <span className={styles.sub}>{person.note}</span>}
      </>
    ),
  }));
  return (
    <Picker
      label="Requested by"
      placeholder="Search people or type First Last"
      items={items}
      selected={chosenIds}
      search={search}
      onSearchChange={setSearch}
      onPick={(id) => {
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
