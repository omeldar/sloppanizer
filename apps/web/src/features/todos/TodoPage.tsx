import {
  formatDuration,
  type PersonRole,
  PRIORITIES,
  type Todo,
  TODO_STATUSES,
  type TodoStatus,
  STATUS_LABELS,
} from "@organizer/shared";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { Dialog } from "../../components/Dialog.tsx";
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
import { type KeyBinding, useKeys } from "../../keyboard/KeyboardProvider.tsx";
import { ApiError, errorMessage } from "../../lib/api.ts";
import { absoluteTime, dueText, relativeTime } from "../../lib/format.ts";
import { useDeleteTodo, useTodo } from "../../lib/queries.ts";
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

function TodoDetail({ todo, focusComment }: { todo: Todo; focusComment?: number }) {
  const { toggleDone, setPriority, patch } = useTodoActions();
  const [editingTitle, setEditingTitle] = useState(false);
  const [picker, setPicker] = useState<PickerKind | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const composer = useRef<MarkdownEditorHandle>(null);

  const bindings: KeyBinding[] = [
    { keys: "e", run: () => setEditingTitle(true), label: "Edit title", group: "Todo" },
    { keys: "x", run: () => void toggleDone(todo), label: "Mark done or reopen", group: "Todo" },
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

  const pick = (kind: PickerKind) => (open: boolean) => setPicker(open ? kind : null);

  return (
    <div className={styles.page}>
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
          <section aria-label="Description">
            <Description todo={todo} />
          </section>
          <Activity todo={todo} composerRef={composer} focusComment={focusComment} />
        </div>

        <aside className={styles.side} aria-label="Details">
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
            <Button
              variant={todo.status === "done" ? "secondary" : "primary"}
              hint="x"
              onClick={() => void toggleDone(todo)}
            >
              {todo.status === "done" ? "Reopen" : "Mark done"}
            </Button>
            <Button variant="ghost" onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          </div>
          <p className={styles.keysHint}>
            <Kbd keys="l" /> labels <Kbd keys="p" /> project <Kbd keys="r" /> requested by <Kbd keys="o" />
            contacts <Kbd keys="m" /> comment <Kbd keys="1" /> to <Kbd keys="4" /> priority
          </p>
        </aside>
      </div>
      <DeleteDialog todo={todo} open={confirmDelete} onOpenChange={setConfirmDelete} />
    </div>
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
  return (
    <MarkdownField
      title="Description"
      value={todo.descriptionMd}
      save={async (descriptionMd) => (await patch(todo.id, { descriptionMd })) !== null}
      emptyText="No description yet. Choose Write to add notes."
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
      <div className={styles.dialogActions}>
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
              toast.show({ tone: "error", message: `Could not delete #${todo.id}. ${errorMessage(error)}` });
            }
          }}
        >
          Delete todo
        </Button>
      </div>
    </Dialog>
  );
}
