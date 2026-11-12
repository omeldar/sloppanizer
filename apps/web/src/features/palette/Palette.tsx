import type { SearchHit } from "@organizer/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Command } from "cmdk";
import { type ReactNode, useState } from "react";
import { useCommands } from "../../app/commands.tsx";
import { Dialog } from "../../components/Dialog.tsx";
import { useToast } from "../../components/toast/ToastProvider.tsx";
import { Kbd } from "../../components/ui.tsx";
import { errorMessage } from "../../lib/api.ts";
import { downloadExport } from "../../lib/export.ts";
import { formatBytes } from "../../lib/format.ts";
import { useProjects, useSearch, useTodo, writeFolderExport } from "../../lib/queries.ts";
import { useIsSession } from "../settings/SessionOnly.tsx";
import { toggleTheme } from "../../lib/theme.ts";
import { useDebounced } from "../../lib/useDebounced.ts";
import { useOnChange } from "../../lib/useOnChange.ts";
import { Highlighted, hitTarget, KIND_NAMES, KIND_ORDER } from "../search/hits.tsx";
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
  const { openQuickAdd, openNewNote, openNewPerson, todoCommands } = useCommands();
  const projects = useProjects();
  const session = useIsSession();
  const toast = useToast();
  const [search, setSearch] = useState("");
  // Searches the server 150 ms after the last key, from two characters on.
  const query = useDebounced(search.trim(), 150);
  // From the live text, so Enter right after typing "#12" already opens it.
  const idMatch = ID_QUERY.exec(search.trim());
  const typedId = idMatch ? Number(idMatch[1]) : 0;
  // Shows which todo "#12" is before opening it; Enter does not wait for it.
  const idTodo = useTodo(typedId);
  const byId = idTodo.data?.id === typedId ? idTodo.data : undefined;
  const searching = query.length >= 2 && !idMatch;
  const results = useSearch({ q: query, limit: 5 }, searching);
  const hits = searching ? (results.data?.items ?? []) : [];
  const [selected, setSelected] = useState("");
  const firstHit = hits[0];
  // Results arrive after the list was built; start the selection on the best match.
  useOnChange(firstHit, (hit) => hit && setSelected(hitValue(hit)));

  const run = (action: () => void) => () => {
    onClose();
    action();
  };
  const go = (to: string, params?: Record<string, string>) => run(() => void navigate({ to, params }));

  const pages: { name: string; to: string; keys?: string; params?: Record<string, string> }[] = [
    { name: "Next up", to: "/", keys: "g n" },
    { name: "Inbox", to: "/inbox", keys: "g i" },
    { name: "Board", to: "/board", keys: "g b" },
    { name: "Week", to: "/week", keys: "g w" },
    { name: "Notes", to: "/notes", keys: "g o" },
    { name: "Search", to: "/search", keys: "/" },
    ...(projects.data ?? [])
      .filter((p) => p.archivedAt === null)
      .map((p) => ({ name: `Project ${p.name}`, to: "/projects/$slug", params: { slug: p.slug } })),
    { name: "Labels", to: "/labels", keys: "g l" },
    { name: "People", to: "/people", keys: "g p" },
    { name: "People statistics", to: "/people/stats" },
    { name: "Settings", to: "/settings", keys: "g s" },
    ...(session ? [{ name: "API tokens", to: "/settings/tokens" }] : []),
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
        placeholder="Search todos, notes, comments and people, #id, pages and commands"
        // The palette opens to type.
        // oxlint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
      />
      <Command.List className={styles.list}>
        <Command.Empty className={styles.empty}>
          Nothing matches. Try other words, a #id or a page name.
        </Command.Empty>
        {idMatch && (
          <Command.Group heading="Todos" className={styles.group}>
            <Item value={`open #${typedId}`} onSelect={go("/todos/$id", { id: String(typedId) })}>
              <span className={styles.mono}>#{typedId}</span>
              {byId ? (
                <>
                  <span className={styles.text} data-done={byId.status === "done" || undefined}>
                    {byId.title}
                  </span>
                  <span className={styles.meta}>{byId.project?.name ?? "Inbox"}</span>
                </>
              ) : (
                <span className={styles.text}>
                  {idTodo.isError ? "No todo with this number" : "Open todo"}
                </span>
              )}
            </Item>
          </Command.Group>
        )}
        {KIND_ORDER.map((kind) => {
          const group = hits.filter((hit) => hit.kind === kind);
          if (group.length === 0) return null;
          return (
            <Command.Group key={kind} heading={KIND_NAMES[kind]} className={styles.group}>
              {group.map((hit) => {
                const target = hitTarget(hit);
                return (
                  <Item
                    key={hitValue(hit)}
                    value={hitValue(hit)}
                    keywords={[search]}
                    onSelect={run(
                      () => void navigate({ to: target.to, params: target.params, search: target.search }),
                    )}
                  >
                    <HitLine hit={hit} />
                  </Item>
                );
              })}
            </Command.Group>
          );
        })}
        {searching && results.data && (
          <Command.Group heading="Search" className={styles.group}>
            <Item
              value="show all results"
              keywords={[search]}
              onSelect={run(() => void navigate({ to: "/search", search: { q: query } }))}
              keys="/"
            >
              Show all results
              <span className={styles.meta}>
                {KIND_ORDER.reduce((sum, kind) => sum + (results.data?.counts[kind] ?? 0), 0)} found
              </span>
            </Item>
          </Command.Group>
        )}
        {!idMatch && (
          <>
            {todoCommands && (
              <Command.Group heading={`Todo #${todoCommands.todoId}`} className={styles.group}>
                <Item value="new subtask" onSelect={run(todoCommands.newSubtask)} keys="s">
                  New subtask
                </Item>
                <Item
                  value="add link blocks blocked by relates"
                  onSelect={run(todoCommands.addLink)}
                  keys="b"
                >
                  Add link
                </Item>
                {todoCommands.repeat && (
                  <Item value="repeat recurring" onSelect={run(todoCommands.repeat)} keys="shift+r">
                    Repeat
                  </Item>
                )}
                {todoCommands.goToParent && (
                  <Item value="go to parent todo" onSelect={run(todoCommands.goToParent)} keys="u">
                    Go to parent
                  </Item>
                )}
              </Command.Group>
            )}
            <Command.Group heading="Actions" className={styles.group}>
              <Item value="new todo" onSelect={run(() => openQuickAdd())} keys="c">
                New todo
              </Item>
              <Item value="new note" onSelect={() => openNewNote()} keys="n">
                New note
              </Item>
              <Item value="new person contact" onSelect={() => openNewPerson()}>
                New person
              </Item>
              <Item value="switch theme dark light" onSelect={run(toggleTheme)}>
                Switch theme
              </Item>
              <Item value="download export zip backup" onSelect={run(() => downloadExport(client))}>
                Download export
              </Item>
              {session && (
                <Item
                  value="write export to folder zip backup"
                  onSelect={run(
                    () =>
                      void writeFolderExport(client).then(
                        (written) =>
                          toast.show({
                            message: `Wrote ${written.fileName} (${formatBytes(written.bytes)})`,
                          }),
                        (error: unknown) =>
                          toast.show({
                            tone: "error",
                            message: `Could not write the export. ${errorMessage(error)}`,
                          }),
                      ),
                  )}
                >
                  Write export to folder
                </Item>
              )}
              {session && (
                <Item
                  value="restore from export zip"
                  onSelect={run(() => void navigate({ to: "/settings", hash: "restore" }))}
                >
                  Restore from export
                </Item>
              )}
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

function hitValue(hit: SearchHit): string {
  return `hit ${hit.kind} ${hit.id}`;
}

/** One result: #id for todos, the title, and the matched snippet or the subtitle. */
function HitLine({ hit }: { hit: SearchHit }) {
  return (
    <>
      {hit.kind === "todo" && <span className={styles.mono}>#{hit.id}</span>}
      <span className={styles.text} data-done={hit.status === "done" || undefined}>
        {hit.title}
        {hit.snippet && hit.snippet !== hit.title && hit.kind !== "person" && (
          <span className={styles.snippet}>
            <Highlighted text={hit.snippet} ranges={hit.highlights} />
          </span>
        )}
      </span>
      {hit.subtitle && <span className={styles.meta}>{hit.subtitle}</span>}
    </>
  );
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
