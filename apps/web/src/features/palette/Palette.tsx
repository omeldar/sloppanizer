import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Command } from "cmdk";
import { type ReactNode, useDeferredValue, useEffect, useState } from "react";
import { useCommands } from "../../app/commands.tsx";
import { Dialog } from "../../components/Dialog.tsx";
import { Kbd } from "../../components/ui.tsx";
import { downloadExport } from "../../lib/export.ts";
import { useProjects, useTodos } from "../../lib/queries.ts";
import { toggleTheme } from "../../lib/theme.ts";
import styles from "./Palette.module.css";

export function Palette() {
  const { palette, close } = useCommands();
  return (
    <Dialog
      open={palette}
      onOpenChange={(open) => !open && close("palette")}
      title="Search and commands"
      hideTitle
      width={620}
      placement="top"
    >
      {palette && <PaletteBody onClose={() => close("palette")} />}
    </Dialog>
  );
}

const ID_QUERY = /^#?(\d+)$/;

function PaletteBody({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const { openQuickAdd } = useCommands();
  const projects = useProjects();
  const [search, setSearch] = useState("");
  const deferred = useDeferredValue(search.trim());
  // From the live text, so Enter right after typing "#12" already opens it.
  const idMatch = ID_QUERY.exec(search.trim());
  const todos = useTodos(
    { q: deferred, status: "all", sort: "updated", limit: 8 },
    deferred.length >= 2 && !idMatch,
  );
  const [selected, setSelected] = useState("");
  const firstTodo = todos.data?.items[0];
  // Search results arrive after the list was built; start the selection on the best todo match.
  useEffect(() => {
    if (firstTodo) setSelected(todoValue(firstTodo));
  }, [firstTodo]);

  const run = (action: () => void) => () => {
    onClose();
    action();
  };
  const go = (to: string, params?: Record<string, string>) => run(() => void navigate({ to, params }));

  const pages: { name: string; to: string; keys?: string; params?: Record<string, string> }[] = [
    { name: "Next up", to: "/", keys: "g n" },
    { name: "Inbox", to: "/inbox", keys: "g i" },
    ...(projects.data ?? [])
      .filter((p) => p.archivedAt === null)
      .map((p) => ({ name: `Project ${p.name}`, to: "/projects/$slug", params: { slug: p.slug } })),
    { name: "Labels", to: "/labels", keys: "g l" },
    { name: "People", to: "/people", keys: "g p" },
    { name: "Settings", to: "/settings", keys: "g s" },
  ];

  return (
    <Command
      label="Search and commands"
      className={styles.palette}
      loop
      shouldFilter={!idMatch}
      value={selected}
      onValueChange={setSelected}
    >
      <Command.Input
        className={styles.input}
        value={search}
        onValueChange={setSearch}
        placeholder="Search todos by title or #id, pages and commands"
        // The palette opens to type.
        // oxlint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
      />
      <Command.List className={styles.list}>
        <Command.Empty className={styles.empty}>
          Nothing matches. Try a todo title, #id or a page name.
        </Command.Empty>
        {idMatch && (
          <Command.Group heading="Todos" className={styles.group}>
            <Item
              value={`open #${idMatch[1]}`}
              onSelect={go("/todos/$id", { id: String(Number(idMatch[1])) })}
            >
              <span className={styles.mono}>#{Number(idMatch[1])}</span> Open todo
            </Item>
          </Command.Group>
        )}
        {!idMatch && (todos.data?.items.length ?? 0) > 0 && (
          <Command.Group heading="Todos" className={styles.group}>
            {todos.data?.items.map((todo) => (
              <Item
                key={todo.id}
                value={todoValue(todo)}
                keywords={[search]}
                onSelect={go("/todos/$id", { id: String(todo.id) })}
              >
                <span className={styles.mono}>#{todo.id}</span>
                <span className={styles.text} data-done={todo.status === "done" || undefined}>
                  {todo.title}
                </span>
                <span className={styles.meta}>{todo.project?.name ?? "Inbox"}</span>
              </Item>
            ))}
          </Command.Group>
        )}
        {!idMatch && (
          <>
            <Command.Group heading="Actions" className={styles.group}>
              <Item value="new todo" onSelect={run(() => openQuickAdd())} keys="c">
                New todo
              </Item>
              <Item value="switch theme dark light" onSelect={run(toggleTheme)}>
                Switch theme
              </Item>
              <Item value="download export zip backup" onSelect={run(() => downloadExport(client))}>
                Download export
              </Item>
            </Command.Group>
            <Command.Group heading="Pages" className={styles.group}>
              {pages.map((page) => (
                <Item
                  key={`${page.to}-${page.name}`}
                  value={`go ${page.name}`}
                  onSelect={go(page.to, page.params)}
                  keys={page.keys}
                >
                  {page.name}
                </Item>
              ))}
            </Command.Group>
          </>
        )}
      </Command.List>
      <footer className={styles.footer}>
        <Kbd keys="Up" />
        <Kbd keys="Down" /> move <Kbd keys="Enter" /> open <Kbd keys="Escape" /> close
      </footer>
    </Command>
  );
}

function todoValue(todo: { id: number; title: string }): string {
  return `todo ${todo.id} ${todo.title}`;
}

function Item({
  value,
  keywords,
  onSelect,
  keys,
  children,
}: {
  value: string;
  keywords?: string[];
  onSelect: () => void;
  keys?: string;
  children: ReactNode;
}) {
  return (
    <Command.Item value={value} keywords={keywords} onSelect={onSelect} className={styles.item}>
      {children}
      {keys && (
        <span className={styles.keys}>
          <Kbd keys={keys} />
        </span>
      )}
    </Command.Item>
  );
}
