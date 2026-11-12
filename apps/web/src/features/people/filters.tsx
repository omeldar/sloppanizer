import { useState } from "react";
import { LabelPill } from "../../components/LabelPill.tsx";
import { Popover } from "../../components/Popover.tsx";
import { Picker } from "../../components/pickers/Picker.tsx";
import { FieldButton } from "../../components/ui.tsx";
import { usePersonTags, useTeams } from "../../lib/queries.ts";
import styles from "./People.module.css";

/** Comma text in the URL -> list. */
export function splitList(value: string | undefined): string[] {
  return value ? value.split(",").filter(Boolean) : [];
}

/** List -> comma text for the URL (undefined when empty). */
export function joinList(values: readonly string[]): string | undefined {
  return values.length > 0 ? values.join(",") : undefined;
}

export function TeamFilter({
  value,
  onChange,
}: {
  value?: string;
  onChange: (team: string | undefined) => void;
}) {
  const teams = useTeams();
  return (
    <label className={styles.sort}>
      <span>Team</span>
      <select
        className={styles.select}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || undefined)}
      >
        <option value="">Any team</option>
        {(teams.data ?? []).map((team) => (
          <option key={team.name} value={team.name}>
            {team.name}
          </option>
        ))}
        {value && !teams.data?.some((t) => t.name.toLowerCase() === value.toLowerCase()) && (
          <option value={value}>{value}</option>
        )}
      </select>
    </label>
  );
}

export function TagFilter({ value, onChange }: { value: string[]; onChange: (tags: string[]) => void }) {
  const tags = usePersonTags();
  const [open, setOpen] = useState(false);
  const selected = new Set(value.map((v) => v.toLowerCase()));
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger={
        <FieldButton empty={value.length === 0} className={styles.tagButton}>
          {value.length === 0 ? "Any tag" : value.join(", ")}
        </FieldButton>
      }
    >
      <Picker
        label="Person tags"
        placeholder="Filter by tags (all must match)"
        items={(tags.data ?? []).map((tag) => ({
          value: tag.name.toLowerCase(),
          search: tag.name,
          label: <LabelPill name={tag.name} color={tag.color} />,
          note: String(tag.peopleCount),
        }))}
        selected={selected}
        onPick={(lower) => {
          const tag = tags.data?.find((t) => t.name.toLowerCase() === lower);
          if (!tag) return;
          onChange(
            selected.has(lower) ? value.filter((v) => v.toLowerCase() !== lower) : [...value, tag.name],
          );
        }}
        empty="No person tags yet. Create them on the Labels page or a person's page."
      />
    </Popover>
  );
}
