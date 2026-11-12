import { STATUS_LABELS, type TodoStatus } from "@organizer/shared";
import { useState } from "react";
import { Picker, type PickerItem } from "../../../components/pickers/Picker.tsx";
import { useSearch, useTodo } from "../../../lib/queries.ts";
import { useDebounced } from "../../../lib/useDebounced.ts";

export interface PickedTodo {
  id: number;
  title: string;
}

const ID_QUERY = /^#?(\d+)$/;
const NO_IDS: readonly number[] = [];

/** Finds a todo by "#id" or by words in its title or text; `exclude` hides ids that cannot be picked. */
export function TodoSearchPicker({
  label,
  exclude = NO_IDS,
  onPick,
}: {
  label: string;
  exclude?: readonly number[];
  onPick: (todo: PickedTodo) => void;
}) {
  const [search, setSearch] = useState("");
  const query = useDebounced(search.trim(), 150);
  const idMatch = ID_QUERY.exec(search.trim());
  const typedId = idMatch ? Number(idMatch[1]) : 0;
  const byId = useTodo(typedId);
  const results = useSearch({ q: query, kinds: ["todo"], limit: 8 }, !idMatch && query.length >= 2);

  const found: { id: number; title: string; status: TodoStatus | null }[] = idMatch
    ? byId.data?.id === typedId
      ? [{ id: byId.data.id, title: byId.data.title, status: byId.data.status }]
      : []
    : (results.data?.items ?? []).map((hit) => ({ id: hit.id, title: hit.title, status: hit.status }));
  const items: PickerItem[] = found
    .filter((todo) => !exclude.includes(todo.id))
    .map((todo) => ({
      value: String(todo.id),
      label: (
        <>
          <span style={{ fontFamily: "var(--font-mono)", marginRight: 8 }}>#{todo.id}</span>
          {todo.title}
        </>
      ),
      note: todo.status ? STATUS_LABELS[todo.status] : undefined,
    }));

  return (
    <Picker
      label={label}
      placeholder="#id or words from the title"
      items={items}
      selected={new Set()}
      search={search}
      onSearchChange={setSearch}
      onPick={(value) => {
        const todo = found.find((t) => String(t.id) === value);
        if (todo) onPick({ id: todo.id, title: todo.title });
      }}
      empty={
        search.trim().length === 0
          ? "Type a #id or a few words."
          : idMatch && byId.isError
            ? `No todo #${typedId}.`
            : exclude.includes(typedId)
              ? "That todo cannot be picked here."
              : "No todo matches."
      }
    />
  );
}
