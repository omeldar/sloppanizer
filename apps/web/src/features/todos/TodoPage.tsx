import {
  type ChecklistItem,
  countChecklist,
  formatDuration,
  type PersonRole,
  PRIORITIES,
  type Todo,
  TODO_STATUSES,
  type TodoStatus,
  STATUS_LABELS,
} from "@organizer/shared";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogBody, DialogActions } from "../../components/Dialog.tsx";
import { LabelPill } from "../../components/LabelPill.tsx";
import type { MarkdownEditorHandle } from "../../components/markdown/MarkdownEditor.tsx";
import { MarkdownField } from "../../components/markdown/MarkdownField.tsx";
import { Popover } from "../../components/Popover.tsx";
import { LabelPicker, PeoplePicker, ProjectPicker } from "../../components/pickers/pickers.tsx";
import { useToast } from "../../components/toast/ToastProvider.tsx";
import {
  Button,
  EmptyState,
  ErrorState,
  FieldButton,
  Kbd,
  Loading,
  TitleInput,
} from "../../components/ui.tsx";
import { type KeyBinding, useKeyHold, useKeys } from "../../keyboard/KeyboardProvider.tsx";
import { ApiError, errorMessage } from "../../lib/api.ts";
import { absoluteTime, dueText, relativeTime } from "../../lib/format.ts";
import {
  childrenParams,
  invalidateTodoViews,
  useBulkUpdate,
  useDeleteTodo,
  useTodo,
  useTodos,
  useToggleChecklist,
} from "../../lib/queries.ts";
import { useCommands } from "../../app/commands.tsx";
import { AddLinkDialog } from "./relations/AddLinkDialog.tsx";
import { Links, linkedIds, WaitingLine } from "./relations/Links.tsx";
import { WebLinks } from "./relations/WebLinks.tsx";
import { PlannedTime } from "../planner/PlannedTime.tsx";
import { Subtasks } from "./relations/Subtasks.tsx";
import { TodoSearchPicker } from "./relations/TodoSearchPicker.tsx";
import { RepeatField } from "./repeat/RepeatField.tsx";
import { PersonChip } from "../people/PersonChip.tsx";
import { Activity } from "./Activity.tsx";
import { chosen, type PickerKind, togglePersonPatch } from "./TodoPickerDialog.tsx";
import styles from "./TodoPage.module.css";
import { useTodoActions } from "./useTodoActions.ts";

const route = getRouteApi("/todos/$id");

export function TodoPage() {
  const { id } = route.useParams();
  const search = route.useSearch();
  const todoId = Number(id);
  const todo = useTodo(todoId);
  // "m" or "e" pressed before the todo is there run once it is.
  useKeyHold(todo.isPending);

  if (
    !Number.isInteger(todoId) ||
    todoId <= 0 ||
    (todo.error instanceof ApiError && todo.error.status === 404)
  ) {
    return (
      <div className={styles.page}>
        <EmptyState>
          There is no todo #{id}. It may have been deleted. <Link to="/">Go to Next up</Link>.
        </EmptyState>
      </div>
    );
  }
  if (todo.isPending) return <Loading />;
  if (todo.isError) return <ErrorState error={todo.error} onRetry={() => void todo.refetch()} />;
  return <TodoDetail key={todo.data.id} todo={todo.data} focusComment={search.comment} />;
}

type SidePicker = PickerKind | "parent" | "repeat";

function TodoDetail({ todo, focusComment }: { todo: Todo; focusComment?: number }) {
  // Phones fold the details into one summary line until opened.
  const [detailsOpen, setDetailsOpen] = useState(false);
  const { setPriority, patch } = useTodoActions();
  const navigate = useNavigate();
  const { setTodoCommands } = useCommands();
  const [editingTitle, setEditingTitle] = useState(false);
  const [picker, setPicker] = useState<SidePicker | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [addingLink, setAddingLink] = useState(false);
  const composer = useRef<MarkdownEditorHandle>(null);
  const subtaskInput = useRef<HTMLInputElement>(null);
  const done = useDoneWithSubtasks(todo);
  const anchor = todo.dueOn ?? todo.plannedOn;

  const newSubtask = () => subtaskInput.current?.focus();
  const openRepeat = () => anchor && setPicker("repeat");
  const goToParent = () =>
    todo.parent && void navigate({ to: "/todos/$id", params: { id: String(todo.parent.id) } });

  // The palette offers this page's actions while it is open.
  useEffect(() => {
    setTodoCommands({
      todoId: todo.id,
      newSubtask,
      addLink: () => setAddingLink(true),
      // After the palette closed, so the popover keeps its focus.
      repeat: anchor ? () => setTimeout(() => setPicker("repeat"), 0) : undefined,
      goToParent: todo.parent ? goToParent : undefined,
    });
    return () => setTodoCommands(null);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the actions only change with these values
  }, [todo.id, todo.parent?.id, anchor, setTodoCommands]);

  const bindings: KeyBinding[] = [
    { keys: "e", run: () => setEditingTitle(true), label: "Edit title", group: "Todo" },
    { keys: "x", run: done.toggle, label: "Mark done or reopen", group: "Todo" },
    { keys: "s", run: newSubtask, label: "Add subtask", group: "Todo" },
    { keys: "b", run: () => setAddingLink(true), label: "Add link", group: "Todo" },
    { keys: "shift+r", run: openRepeat, label: "Repeat", group: "Todo" },
    { keys: "u", run: goToParent, label: "Go to the parent todo", group: "Todo" },
    { keys: "l", run: () => setPicker("labels"), label: "Labels", group: "Todo" },
    { keys: "p", run: () => setPicker("project"), label: "Project", group: "Todo" },
    { keys: "r", run: () => setPicker("people"), label: "Requested by", group: "Todo" },
    { keys: "o", run: () => setPicker("contacts"), label: "Contacts", group: "Todo" },
    { keys: "m", run: () => composer.current?.focus(), label: "Write a comment", group: "Todo" },
    ...PRIORITIES.map((priority, i) => ({
      keys: String(i + 1),
      run: () => void setPriority(todo, priority),
      label: i === 0 ? "Priority critical, high, medium, low (1 to 4)" : undefined,
      group: "Todo",
    })),
  ];
  useKeys(bindings, { enabled: !editingTitle });

  const pick = (kind: SidePicker) => (open: boolean) => setPicker(open ? kind : null);

  return (
    <div className={styles.page}>
      {todo.parent && (
        <nav className={styles.parent} aria-label="Parent todo">
          <span className={styles.parentLabel}>Subtask of</span>
          <Link to="/todos/$id" params={{ id: String(todo.parent.id) }} className={styles.parentLink}>
            <span className={styles.parentId}>#{todo.parent.id}</span> {todo.parent.title}
          </Link>
        </nav>
      )}
      <div className={styles.head}>
        <span className={styles.id}>#{todo.id}</span>
        {editingTitle ? (
          <TitleInput
            className={styles.titleInput}
            maxLength={300}
            initial={todo.title}
            onDone={(title) => {
              setEditingTitle(false);
              if (title && title !== todo.title) void patch(todo.id, { title });
            }}
          />
        ) : (
          <h1 className={styles.title}>
            <button
              type="button"
              className={styles.titleButton}
              onClick={() => setEditingTitle(true)}
              title="Edit title (e)"
            >
              {todo.title}
            </button>
          </h1>
        )}
      </div>

      <div className={styles.columns}>
        <div className={styles.body}>
          <WaitingLine todo={todo} />
          <section aria-label="Description">
            <Description todo={todo} />
          </section>
          <Subtasks todo={todo} inputRef={subtaskInput} />
          <Links todo={todo} onAdd={() => setAddingLink(true)} />
          <WebLinks todo={todo} />
          <PlannedTime todo={todo} />
          <Activity todo={todo} composerRef={composer} focusComment={focusComment} />
        </div>

        <aside className={styles.side} aria-label="Details" data-open={detailsOpen || undefined}>
          <button
            type="button"
            className={styles.detailsToggle}
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen((open) => !open)}
          >
            <span className={styles.detailsSummary}>
              {STATUS_LABELS[todo.status]}
              {todo.project ? ` · ${todo.project.name}` : " · Inbox"}
              {todo.dueOn ? ` · ${dueText(todo.dueOn)}` : ""}
              {todo.labels.length > 0
                ? ` · ${todo.labels.length} ${todo.labels.length === 1 ? "label" : "labels"}`
                : ""}
            </span>
            <span className={styles.detailsMore}>{detailsOpen ? "Less" : "Details"}</span>
          </button>
          <dl className={styles.fields}>
            <dt>Status</dt>
            <dd>
              <select
                className={styles.status}
                data-status={todo.status}
                value={todo.status}
                aria-label="Status"
                onChange={(event) => void patch(todo.id, { status: event.target.value as TodoStatus })}
              >
                {TODO_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {STATUS_LABELS[status]}
                  </option>
                ))}
              </select>
            </dd>

            <dt>Project</dt>
            <dd>
              <Popover
                open={picker === "project"}
                onOpenChange={pick("project")}
                trigger={<FieldButton empty={!todo.project}>{todo.project?.name ?? "Inbox"}</FieldButton>}
              >
                <ProjectPicker
                  value={todo.projectId}
                  onChange={(projectId) => {
                    setPicker(null);
                    if (projectId !== todo.projectId) void patch(todo.id, { projectId });
                  }}
                />
              </Popover>
            </dd>

            <dt>Subtask of</dt>
            <dd>
              <ParentField todo={todo} open={picker === "parent"} onOpenChange={pick("parent")} />
            </dd>

            <dt>Labels</dt>
            <dd>
              <Popover
                open={picker === "labels"}
                onOpenChange={pick("labels")}
                trigger={
                  <FieldButton empty={todo.labels.length === 0}>
                    {todo.labels.length === 0
                      ? "No labels"
                      : todo.labels.map((l) => <LabelPill key={l.id} name={l.name} color={l.color} />)}
                  </FieldButton>
                }
              >
                <LabelPicker
                  value={todo.labels.map((l) => l.name)}
                  onToggle={(name) => {
                    const has = todo.labels.some((l) => l.name.toLowerCase() === name.toLowerCase());
                    void patch(todo.id, has ? { removeLabels: [name] } : { addLabels: [name] });
                  }}
                />
              </Popover>
            </dd>

            <dt>Requested by</dt>
            <dd>
              <PeopleField
                todo={todo}
                role="requester"
                open={picker === "people"}
                onOpenChange={pick("people")}
              />
            </dd>

            <dt>Contacts</dt>
            <dd>
              <PeopleField
                todo={todo}
                role="contact"
                open={picker === "contacts"}
                onOpenChange={pick("contacts")}
              />
            </dd>

            <dt>Due</dt>
            <dd>
              <DateInput
                label="Due date"
                value={todo.dueOn}
                onChange={(dueOn) => void patch(todo.id, { dueOn })}
              />
              {todo.dueOn && todo.status !== "done" && (
                <span className={styles.dateNote}>{dueText(todo.dueOn)}</span>
              )}
            </dd>

            <dt>Planned</dt>
            <dd>
              <DateInput
                label="Planned day"
                value={todo.plannedOn}
                onChange={(plannedOn) => void patch(todo.id, { plannedOn })}
              />
            </dd>

            <dt>Repeat</dt>
            <dd>
              <RepeatField
                value={todo.recurrence}
                anchor={anchor}
                open={picker === "repeat"}
                onOpenChange={pick("repeat")}
                onChange={(recurrence) => void patch(todo.id, { recurrence })}
              />
              {todo.nextOccurrence && (
                <span className={styles.dateNote}>
                  Next one:{" "}
                  <Link to="/todos/$id" params={{ id: String(todo.nextOccurrence.id) }}>
                    #{todo.nextOccurrence.id}
                  </Link>
                </span>
              )}
            </dd>
          </dl>

          <dl className={styles.meta}>
            <MetaRow label="Created" instant={todo.createdAt} />
            {todo.doneAt && <MetaRow label="Done" instant={todo.doneAt} />}
            {todo.durationMs !== null && (
              <div>
                <dt>Took</dt>
                <dd className={styles.took}>{formatDuration(todo.durationMs)}</dd>
              </div>
            )}
            <MetaRow label="Updated" instant={todo.updatedAt} />
            <MetaRow label="Last activity" instant={todo.lastActivityAt} />
          </dl>

          <div className={styles.sideActions}>
            <Button variant={todo.status === "done" ? "secondary" : "primary"} hint="x" onClick={done.toggle}>
              {todo.status === "done" ? "Reopen" : "Mark done"}
            </Button>
            <Button variant="ghost" onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          </div>
          <p className={styles.keysHint}>
            <Kbd keys="l" /> labels <Kbd keys="p" /> project <Kbd keys="r" /> requested by <Kbd keys="o" />
            contacts <Kbd keys="m" /> comment <Kbd keys="1" /> to <Kbd keys="4" /> priority <Kbd keys="s" />{" "}
            subtask <Kbd keys="b" /> link <Kbd keys="shift+r" /> repeat
            {todo.parent && (
              <>
                {" "}
                <Kbd keys="u" /> parent
              </>
            )}
          </p>
        </aside>
      </div>
      <DeleteDialog todo={todo} open={confirmDelete} onOpenChange={setConfirmDelete} />
      <AddLinkDialog
        todoId={todo.id}
        open={addingLink}
        onOpenChange={setAddingLink}
        exclude={linkedIds(todo)}
      />
      <Dialog
        open={done.asking !== null}
        onOpenChange={(open) => !open && done.cancel()}
        title={
          done.asking
            ? `${done.asking.length} ${done.asking.length === 1 ? "subtask is" : "subtasks are"} still open. Mark them done too?`
            : ""
        }
        width={460}
      >
        <DialogBody>
          <DialogActions>
            <Button onClick={() => void done.confirm(false)}>No, only #{todo.id}</Button>
            {/* oxlint-disable-next-line jsx-a11y/no-autofocus -- the answer the question asks for */}
            <Button variant="primary" onClick={() => void done.confirm(true)} autoFocus>
              Yes, mark them done
            </Button>
          </DialogActions>
        </DialogBody>
      </Dialog>
    </div>
  );
}

/**
 * Done for a todo with open subtasks first asks whether to close them too (bulk), else it is the
 * normal done or reopen with undo.
 */
function useDoneWithSubtasks(todo: Todo) {
  const { toggleDone } = useTodoActions();
  const bulk = useBulkUpdate();
  const toast = useToast();
  const children = useTodos(childrenParams(todo.id), todo.progress.subtasks.total > 0);
  const [asking, setAsking] = useState<Todo[] | null>(null);
  const open = (children.data?.items ?? []).filter((c) => c.status !== "done");

  const toggle = () => {
    if (
      todo.status !== "done" &&
      todo.progress.subtasks.total > todo.progress.subtasks.done &&
      open.length > 0
    ) {
      setAsking(open);
      return;
    }
    void toggleDone(todo);
  };

  const confirm = async (withChildren: boolean) => {
    const openChildren = asking ?? [];
    setAsking(null);
    if (!withChildren) return toggleDone(todo);
    try {
      await bulk.mutateAsync({ ids: [todo.id, ...openChildren.map((c) => c.id)], patch: { status: "done" } });
    } catch (error) {
      toast.show({ tone: "error", message: `Could not mark them done. ${errorMessage(error)}` });
      return;
    }
    // Undo puts each one back to the status it had.
    const before = [todo, ...openChildren];
    const byStatus = new Map<TodoStatus, number[]>();
    for (const t of before) byStatus.set(t.status, [...(byStatus.get(t.status) ?? []), t.id]);
    toast.show({
      message: `Marked #${todo.id} and ${openChildren.length} ${openChildren.length === 1 ? "subtask" : "subtasks"} done`,
      action: {
        label: "Undo",
        run: () => {
          for (const [status, ids] of byStatus) bulk.mutate({ ids, patch: { status } });
        },
      },
    });
  };

  return { toggle, asking, confirm, cancel: () => setAsking(null) };
}

/** "Subtask of": pick the parent by #id or title, or clear it. */
function ParentField({
  todo,
  open,
  onOpenChange,
}: {
  todo: Todo;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { patch } = useTodoActions();
  return (
    <span className={styles.parentField}>
      <Popover
        open={open}
        onOpenChange={onOpenChange}
        trigger={
          <FieldButton empty={!todo.parent} aria-label="Subtask of">
            {todo.parent ? `#${todo.parent.id} ${todo.parent.title}` : "None"}
          </FieldButton>
        }
      >
        <TodoSearchPicker
          label="Parent todo"
          exclude={[todo.id]}
          onPick={(parent) => {
            onOpenChange(false);
            if (parent.id !== todo.parent?.id) void patch(todo.id, { parentId: parent.id });
          }}
        />
      </Popover>
      {todo.parent && (
        <button
          type="button"
          className={styles.clear}
          onClick={() => void patch(todo.id, { parentId: null })}
          aria-label="Clear subtask of"
        >
          Clear
        </button>
      )}
    </span>
  );
}

/** Requesters or contacts: chips with a hover card, and a button that opens the people picker. */
function PeopleField({
  todo,
  role,
  open,
  onOpenChange,
}: {
  todo: Todo;
  role: PersonRole;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { patch } = useTodoActions();
  const people = role === "contact" ? todo.contacts : todo.requestedBy;
  const label = role === "contact" ? "Contacts" : "Requested by";
  return (
    <div className={styles.peopleField}>
      {people.map((person) => (
        <PersonChip key={person.id} person={person} />
      ))}
      <Popover
        open={open}
        onOpenChange={onOpenChange}
        trigger={
          <FieldButton
            empty={people.length === 0}
            className={people.length > 0 ? styles.peopleEdit : undefined}
            aria-label={`${label}: add or remove people`}
          >
            {people.length === 0 ? "Nobody" : "Edit"}
          </FieldButton>
        }
      >
        <PeoplePicker
          label={label}
          value={chosen(people)}
          onToggle={(choice) => void patch(todo.id, togglePersonPatch(todo, role, choice))}
        />
      </Popover>
    </div>
  );
}

function MetaRow({ label, instant }: { label: string; instant: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <time dateTime={instant}>{absoluteTime(instant)}</time>{" "}
        <span className={styles.relative}>{relativeTime(instant)}</span>
      </dd>
    </div>
  );
}

function DateInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  return (
    <span className={styles.dateRow}>
      <input
        type="date"
        className={styles.date}
        aria-label={label}
        value={value ?? ""}
        onChange={(event) => {
          const next = event.target.value || null;
          if (next !== value) onChange(next);
        }}
      />
      {value && (
        <button
          type="button"
          className={styles.clear}
          onClick={() => onChange(null)}
          aria-label={`Clear ${label.toLowerCase()}`}
        >
          Clear
        </button>
      )}
    </span>
  );
}

function Description({ todo }: { todo: Todo }) {
  const { patch } = useTodoActions();
  const toggle = useToggleChecklist(todo.id);
  const client = useQueryClient();
  const toast = useToast();
  const count = countChecklist(todo.descriptionMd);
  const { mutate: toggleItem, isPending: busy } = toggle;
  const onToggle = useCallback(
    (item: ChecklistItem, checked: boolean) =>
      toggleItem(
        { index: item.index, checked, text: item.text },
        {
          onError: (error) => {
            if (error instanceof ApiError && error.status === 409) {
              // Someone changed the text: show the current one, the user clicks again.
              void invalidateTodoViews(client);
              toast.show({ tone: "error", message: "The checklist changed. Try again." });
            } else {
              toast.show({ tone: "error", message: `Could not save the checklist. ${errorMessage(error)}` });
            }
          },
        },
      ),
    [toggleItem, client, toast],
  );
  // Stable between renders, so the preview does not rebuild its checklist context each time.
  const checklist = useMemo(() => ({ busy, onToggle }), [busy, onToggle]);
  return (
    <MarkdownField
      title="Description"
      meta={count.total > 0 ? `Checklist ${count.done} of ${count.total}` : undefined}
      value={todo.descriptionMd}
      save={async (descriptionMd) => (await patch(todo.id, { descriptionMd })) !== null}
      emptyText="No description yet. Choose Write to add notes."
      checklist={checklist}
    />
  );
}

function DeleteDialog({
  todo,
  open,
  onOpenChange,
}: {
  todo: Todo;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const remove = useDeleteTodo();
  const navigate = useNavigate();
  const toast = useToast();
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Delete #${todo.id}?`}
      description="The todo and its history are removed for good. Mark it done instead if you want to keep a record."
      width={440}
    >
      <DialogBody>
        <DialogActions>
          <Button onClick={() => onOpenChange(false)}>Keep it</Button>
          <Button
            variant="danger"
            disabled={remove.isPending}
            onClick={async () => {
              try {
                await remove.mutateAsync(todo.id);
                onOpenChange(false);
                toast.show({ message: `Deleted #${todo.id}` });
                void navigate({
                  to: todo.project ? "/projects/$slug" : "/inbox",
                  params: todo.project ? { slug: todo.project.slug } : {},
                });
              } catch (error) {
                toast.show({
                  tone: "error",
                  message: `Could not delete #${todo.id}. ${errorMessage(error)}`,
                });
              }
            }}
          >
            Delete todo
          </Button>
        </DialogActions>
      </DialogBody>
    </Dialog>
  );
}
