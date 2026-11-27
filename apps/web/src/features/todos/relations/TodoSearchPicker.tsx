import { type BlockSpace, STATUS_LABELS, type TodoStatus } from "@organizer/shared";
import { useState } from "react";
import { Picker, type PickerItem } from "../../../components/pickers/Picker.tsx";
import { useSearch, useTodo } from "../../../lib/queries.ts";
import { sharedKey, useSharedSearch } from "../../../lib/spaces.ts";
import { useDebounced } from "../../../lib/useDebounced.ts";

export interface PickedTodo {
  id: number;
  title: string;
  /** A todo of a shared project (its id is counted there); none for your own. */
  space?: BlockSpace | null;
}

const ID_QUERY = /^#?(\d+)$/;
const NO_IDS: readonly number[] = [];

/**
 * Finds a todo by "#id" or by words in its title or text; `exclude` hides ids that cannot be picked.
 * With `shared` (your own tab) words also find the todos of your shared projects, marked with theirs.
 */
export function TodoSearchPicker({
  label,
  exclude = NO_IDS,
  shared = false,
  onPick,
}: {
  label: string;
  exclude?: readonly number[];
  shared?: boolean;
  onPick: (todo: PickedTodo) => void;
}) {
  const [search, setSearch] = useState("");
  const query = useDebounced(search.trim(), 150);
  const idMatch = ID_QUERY.exec(search.trim());
  const typedId = idMatch ? Number(idMatch[1]) : 0;
  const byId = useTodo(typedId);
  const searching = !idMatch && query.length >= 2;
  const results = useSearch({ q: query, kinds: ["todo"], limit: 8 }, searching);
  const sharedResults = useSharedSearch(query, shared && searching, 5);

  type Found = {
    key: string;
    id: number;
    title: string;
    status: TodoStatus | null;
    space: BlockSpace | null;
  };
  const found: Found[] = idMatch
    ? byId.data?.id === typedId
      ? [{ key: String(typedId), id: typedId, title: byId.data.title, status: byId.data.status, space: null }]
      : []
    : [
        ...(results.data?.items ?? []).map((hit) => ({
          key: String(hit.id),
          id: hit.id,
          title: hit.title,
          status: hit.status,
          space: null,
        })),
        ...sharedResults.items.map(({ space, hit }) => ({
          key: sharedKey(space.id, hit.id),
          id: hit.id,
          title: hit.title,
          status: hit.status,
          space: { id: space.id, name: space.name, color: space.color },
        })),
      ];
  const items: PickerItem[] = found
    .filter((todo) => todo.space !== null || !exclude.includes(todo.id))
    .map((todo) => ({
      value: todo.key,
      label: (
        <>
          {/* A shared project numbers its todos on its own: #3 there is not your #3. */}
          {todo.space === null && (
            <span style={{ fontFamily: "var(--font-mono)", marginRight: 8 }}>#{todo.id}</span>
          )}
          {todo.title}
        </>
      ),
      note:
        [todo.space ? `in ${todo.space.name}` : "", todo.status ? STATUS_LABELS[todo.status] : ""]
          .filter(Boolean)
          .join(" · ") || undefined,
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
        const todo = found.find((t) => t.key === value);
        if (todo) onPick({ id: todo.id, title: todo.title, space: todo.space });
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
