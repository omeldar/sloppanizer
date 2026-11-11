import { Command } from "cmdk";
import { type ReactNode, useState } from "react";
import styles from "./Picker.module.css";

export interface PickerItem {
  value: string;
  label: ReactNode;
  /** Text cmdk filters on (defaults to value). */
  search?: string;
  /** Small text on the right, e.g. "replaces priority::high". */
  note?: ReactNode;
}

interface Props {
  label: string;
  placeholder: string;
  items: readonly PickerItem[];
  selected: ReadonlySet<string>;
  onPick: (value: string) => void;
  /** Filter on the server (people search) instead of in the list. */
  search?: string;
  onSearchChange?: (search: string) => void;
  /** An extra row at the end, e.g. "Create Anna Meier". Return null to hide it. */
  createItem?: (search: string) => { label: ReactNode; run: () => void } | null;
  empty?: ReactNode;
}

/** A searchable list for projects, labels and people. Enter or click picks; picking again unpicks (multi). */
export function Picker({
  label,
  placeholder,
  items,
  selected,
  onPick,
  search: controlledSearch,
  onSearchChange,
  createItem,
  empty = "Nothing matches.",
}: Props) {
  const [localSearch, setLocalSearch] = useState("");
  const search = controlledSearch ?? localSearch;
  const setSearch = onSearchChange ?? setLocalSearch;
  const create = createItem?.(search.trim());

  return (
    <Command label={label} className={styles.picker} shouldFilter={onSearchChange === undefined} loop>
      <Command.Input
        className={styles.input}
        placeholder={placeholder}
        value={search}
        onValueChange={setSearch}
        // Pickers open on purpose, so typing goes straight into the search.
        // oxlint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
      />
      <Command.List className={styles.list}>
        <Command.Empty className={styles.empty}>{empty}</Command.Empty>
        {items.map((item) => (
          <Command.Item
            key={item.value}
            value={item.value}
            keywords={item.search ? [item.search] : undefined}
            className={styles.item}
            onSelect={() => onPick(item.value)}
          >
            <span
              className={styles.mark}
              data-on={selected.has(item.value) || undefined}
              aria-hidden="true"
            />
            <span className={styles.label}>{item.label}</span>
            {item.note && <span className={styles.note}>{item.note}</span>}
          </Command.Item>
        ))}
        {create && (
          <Command.Item value={`create:${search}`} className={styles.item} onSelect={create.run} forceMount>
            <span className={styles.plus} aria-hidden="true">
              +
            </span>
            <span className={styles.label}>{create.label}</span>
          </Command.Item>
        )}
      </Command.List>
    </Command>
  );
}
