import type { NoteSummary } from "@organizer/shared";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { type CSSProperties, useRef, useState } from "react";
import { useCommands } from "../../app/commands.tsx";
import { Button, EmptyState, ErrorState, Kbd, Loading, TextInput } from "../../components/ui.tsx";
import { type KeyBinding, useKeys } from "../../keyboard/KeyboardProvider.tsx";
import { absoluteTime, relativeTime } from "../../lib/format.ts";
import { type NoteListParams, useNotes, useProjects } from "../../lib/queries.ts";
import { useOnChange } from "../../lib/useOnChange.ts";
import { useUrlText } from "../../lib/useUrlText.ts";
import { stepCursor, useScrollIntoView } from "../../lib/listCursor.ts";
import { NoteEditor } from "./NoteEditor.tsx";
import styles from "./Notes.module.css";
import { hint } from "../../lib/device.ts";

const listRoute = getRouteApi("/notes");
const noteRoute = getRouteApi("/notes/$id");

export interface NotesSearch {
  /** Project slug or "none". */
  project?: string;
  q?: string;
}

/** /notes: the list with an empty editor side. */
export function NotesPage() {
  const search = listRoute.useSearch();
  return <NotesLayout search={search} noteId={null} />;
}

/** /notes/$id: the list with the note open on the right. */
export function NotePage() {
  const { id } = noteRoute.useParams();
  const search = noteRoute.useSearch();
  return <NotesLayout search={search} noteId={Number(id)} write={search.write} />;
}

function NotesLayout({
  search,
  noteId,
  write = false,
}: {
  search: NotesSearch;
  noteId: number | null;
  write?: boolean;
}) {
  const navigate = useNavigate();
  const { openNewNote } = useCommands();
  const projects = useProjects();
  const project = projects.data?.find((p) => p.slug === search.project);
  const params: NoteListParams = {
    projectId: search.project === "none" ? "none" : project?.id,
    q: search.q,
    limit: 500,
  };
  const notes = useNotes(params);
  const items = notes.data?.items ?? [];
  const pinned = items.filter((n) => n.pinnedAt !== null);
  const rest = items.filter((n) => n.pinnedAt === null);
  const ordered = [...pinned, ...rest];

  const setSearch = (next: NotesSearch) =>
    noteId === null
      ? void navigate({ to: "/notes", search: next, replace: true })
      : void navigate({ to: "/notes/$id", params: { id: String(noteId) }, search: next, replace: true });

  // The list asks the server once typing pauses, not on every key.
  const filter = useUrlText(search.q ?? "", (q) => setSearch({ ...search, q: q || undefined }));

  const [selectedId, setSelectedId] = useState<number | null>(noteId);
  useOnChange(noteId, setSelectedId);
  const filterRef = useRef<HTMLInputElement>(null);
  const move = (delta: number) =>
    setSelectedId(
      stepCursor(
        ordered.map((n) => n.id),
        selectedId,
        delta,
      ),
    );
  const open = (id: number) => void navigate({ to: "/notes/$id", params: { id: String(id) }, search });

  const bindings: KeyBinding[] = [
    { keys: "j", run: () => move(1), label: "Next note", group: "Notes" },
    { keys: "k", run: () => move(-1), label: "Previous note", group: "Notes" },
    { keys: "ArrowDown", run: () => move(1) },
    { keys: "ArrowUp", run: () => move(-1) },
    {
      keys: "Enter",
      run: () => selectedId !== null && open(selectedId),
      label: "Open note",
      group: "Notes",
    },
    { keys: "f", run: () => filterRef.current?.focus(), label: "Filter notes", group: "Notes" },
  ];
  useKeys(bindings);

  const filtered = Boolean(search.q || search.project);

  return (
    <div className={styles.layout} data-open={noteId !== null || undefined}>
      <section className={styles.listPane} aria-label="Notes">
        <div className={styles.listHead}>
          <h1 className={styles.heading}>Notes</h1>
          <span className={styles.count}>{notes.data ? notes.data.total : ""}</span>
          <Button size="sm" hint="n" onClick={() => openNewNote(project?.id ?? null)}>
            New note
          </Button>
        </div>
        <div className={styles.filters}>
          <TextInput
            ref={filterRef}
            value={filter.text}
            onChange={(e) => filter.setText(e.target.value)}
            placeholder="Filter by title"
            aria-label="Filter notes by title"
          />
          <select
            className={styles.select}
            aria-label="Project"
            value={search.project ?? ""}
            onChange={(e) => setSearch({ ...search, project: e.target.value || undefined })}
          >
            <option value="">All projects</option>
            <option value="none">No project</option>
            {(projects.data ?? [])
              .filter((p) => p.archivedAt === null)
              .map((p) => (
                <option key={p.id} value={p.slug}>
                  {p.name}
                </option>
              ))}
          </select>
        </div>
        {notes.isPending && <Loading />}
        {notes.isError && <ErrorState error={notes.error} onRetry={() => void notes.refetch()} />}
        {notes.data && items.length === 0 && (
          <EmptyState>
            {filtered
              ? "No note matches. Clear the filter or pick another project."
              : hint("No notes yet. Press n to write one.", "No notes yet. Use New note to write one.")}
          </EmptyState>
        )}
        {pinned.length > 0 && (
          <NoteGroup title="Pinned" notes={pinned} selectedId={selectedId} openId={noteId} search={search} />
        )}
        {rest.length > 0 && (
          <NoteGroup
            title={pinned.length > 0 ? "Notes" : undefined}
            notes={rest}
            selectedId={selectedId}
            openId={noteId}
            search={search}
          />
        )}
      </section>
      <section className={styles.editorPane} aria-label="Note">
        <Link to="/notes" search={search} className={styles.back}>
          ‹ All notes
        </Link>
        {noteId === null ? (
          <div className={styles.placeholder}>
            <p>
              Pick a note on the left, or press <Kbd keys="n" /> to write a new one.
            </p>
          </div>
        ) : (
          <NoteEditor key={noteId} id={noteId} write={write} />
        )}
      </section>
    </div>
  );
}

function NoteGroup({
  title,
  notes,
  selectedId,
  openId,
  search,
}: {
  title?: string;
  notes: readonly NoteSummary[];
  selectedId: number | null;
  openId: number | null;
  search: NotesSearch;
}) {
  return (
    <div className={styles.group}>
      {title && <h2 className={styles.groupTitle}>{title}</h2>}
      <ol className={styles.list}>
        {notes.map((note) => (
          <NoteRow
            key={note.id}
            note={note}
            selected={note.id === selectedId}
            open={note.id === openId}
            search={search}
          />
        ))}
      </ol>
    </div>
  );
}

function NoteRow({
  note,
  selected,
  open,
  search,
}: {
  note: NoteSummary;
  selected: boolean;
  open: boolean;
  search: NotesSearch;
}) {
  const ref = useScrollIntoView<HTMLLIElement>(selected);
  return (
    <li ref={ref} className={styles.row} data-selected={selected || undefined} data-open={open || undefined}>
      <Link
        to="/notes/$id"
        params={{ id: String(note.id) }}
        search={search}
        className={styles.rowLink}
        aria-current={open ? "page" : undefined}
      >
        <span className={styles.rowTop}>
          {note.pinnedAt && <span className={styles.pin} aria-label="Pinned" />}
          <span className={styles.rowTitle}>{note.title}</span>
          <time className={styles.rowTime} dateTime={note.updatedAt} title={absoluteTime(note.updatedAt)}>
            {relativeTime(note.updatedAt)}
          </time>
        </span>
        {note.excerpt && <span className={styles.excerpt}>{note.excerpt}</span>}
        {note.project && (
          <span className={styles.rowProject}>
            <span className={styles.swatch} style={{ "--swatch": note.project.color } as CSSProperties} />
            {note.project.name}
          </span>
        )}
      </Link>
    </li>
  );
}
