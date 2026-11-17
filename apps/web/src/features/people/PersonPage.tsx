import {
  formatDuration,
  type Person,
  type PersonRole,
  priorityOf,
  PROJECT_COLORS,
  STATUS_LABELS,
  type Todo,
  type Topic,
  TopicConflictDetails,
  type UpdatePerson,
} from "@organizer/shared";
import { useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useId, useRef, useState } from "react";
import { Dialog, DialogActions, DialogBody } from "../../components/Dialog.tsx";
import { LabelPill } from "../../components/LabelPill.tsx";
import { MarkdownField } from "../../components/markdown/MarkdownField.tsx";
import { Menu } from "../../components/Menu.tsx";
import { Popover } from "../../components/Popover.tsx";
import { Picker } from "../../components/pickers/Picker.tsx";
import { useToast } from "../../components/toast/ToastProvider.tsx";
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  FieldButton,
  Kbd,
  Loading,
  TextInput,
} from "../../components/ui.tsx";
import { useKeys } from "../../keyboard/KeyboardProvider.tsx";
import { ApiError, errorMessage } from "../../lib/api.ts";
import { absoluteDate, absoluteTime } from "../../lib/format.ts";
import {
  useCreatePersonTag,
  useDeletePerson,
  useDeleteTopic,
  usePerson,
  usePersonTags,
  useRenameTopic,
  useTeams,
  topicsQuery,
  useTodos,
  useTopics,
  useUpdatePerson,
} from "../../lib/queries.ts";
import { EmailActions } from "./EmailActions.tsx";
import { InlineText } from "./InlineText.tsx";
import { PersonStats } from "./PersonStats.tsx";
import styles from "./People.module.css";
import { TopicInput } from "./TopicInput.tsx";

const route = getRouteApi("/people/$id");

export function PersonPage() {
  const { id } = route.useParams();
  const personId = Number(id);
  const person = usePerson(personId);
  if (!Number.isInteger(personId) || (person.error instanceof ApiError && person.error.status === 404)) {
    return (
      <EmptyState>
        There is no person {id}. They may have been removed. <Link to="/people">Back to People</Link>.
      </EmptyState>
    );
  }
  if (person.isPending) return <Loading />;
  if (person.isError) return <ErrorState error={person.error} onRetry={() => void person.refetch()} />;
  return <PersonDetail key={person.data.id} person={person.data} />;
}

function PersonDetail({ person }: { person: Person }) {
  const update = useUpdatePerson();
  const toast = useToast();
  const teams = useTeams();
  const teamList = useId();
  // One query for every chip's count and id; a chip whose topic is not in it looks it up when needed.
  const allTopics = useTopics("", true, TOPIC_LIST_LIMIT);
  const topicByName = new Map((allTopics.data ?? []).map((t) => [t.name.toLowerCase(), t]));
  const [editingName, setEditingName] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const topicInput = useRef<HTMLInputElement>(null);

  const save = async (patch: UpdatePerson): Promise<boolean> => {
    try {
      await update.mutateAsync({ id: person.id, patch });
      return true;
    } catch (error) {
      toast.show({ tone: "error", message: `Could not save ${person.displayName}. ${errorMessage(error)}` });
      return false;
    }
  };

  useKeys(
    [
      { keys: "e", run: () => setEditingName(true), label: "Edit name", group: "Person" },
      { keys: "t", run: () => topicInput.current?.focus(), label: "Add topics", group: "Person" },
      { keys: "l", run: () => setTagsOpen(true), label: "Tags", group: "Person" },
    ],
    { enabled: !editingName },
  );

  return (
    <div className={styles.personPage}>
      <header className={styles.personHead}>
        {editingName ? (
          <NameForm
            person={person}
            onDone={(names) => {
              setEditingName(false);
              if (names) void save(names);
            }}
          />
        ) : (
          <h1 className={styles.personName}>
            <button
              type="button"
              className={styles.titleButton}
              onClick={() => setEditingName(true)}
              title="Edit name (e)"
            >
              {person.displayName}
            </button>
          </h1>
        )}
        <span className={styles.personCounts}>
          requested {person.counts.requested}, {person.counts.requestedOpen} open, contact for{" "}
          {person.counts.contact}
        </span>
      </header>

      <div className={styles.personColumns}>
        <section className={styles.personMain} aria-label="Notes and todos">
          <MarkdownField
            title="Notes"
            value={person.notesMd}
            save={(notesMd) => save({ notesMd })}
            emptyText="No notes yet. Choose Write to note how they work, what they own, what to watch out for."
          />
          <PersonTodos person={person} role="requester" title="Requested" />
          <PersonTodos person={person} role="contact" title="Contact for" />
        </section>

        <aside className={styles.personSide} aria-label="Details">
          <dl className={styles.fields}>
            <dt>Short note</dt>
            <dd>
              <InlineText
                label="Short note"
                value={person.note}
                placeholder="Tells namesakes apart"
                maxLength={2000}
                onSave={(note) => void save({ note })}
              />
            </dd>
            <dt>Team</dt>
            <dd>
              <InlineText
                label="Team"
                value={person.team}
                placeholder="Team or department"
                maxLength={100}
                list={teamList}
                onSave={(team) => void save({ team })}
              />
              <datalist id={teamList}>
                {(teams.data ?? []).map((team) => (
                  // oxlint-disable-next-line jsx-a11y/control-has-associated-label -- a datalist suggestion; its value is the text
                  <option key={team.name} value={team.name} />
                ))}
              </datalist>
            </dd>
            <dt>Email</dt>
            <dd>
              <InlineText
                label="Email"
                type="email"
                value={person.email}
                placeholder="name@example.com"
                maxLength={254}
                onSave={(email) => void save({ email })}
              />
              {person.email && <EmailActions email={person.email} />}
            </dd>
            <dt>Topics</dt>
            <dd>
              <TopicInput
                inputRef={topicInput}
                topics={person.topics}
                onAdd={(name) => void save({ addTopics: [name] })}
                onRemove={(name) => void save({ removeTopics: [name] })}
                renderChip={(name) => (
                  <TopicChip
                    name={name}
                    topic={topicByName.get(name.toLowerCase())}
                    person={person}
                    onRemove={() => void save({ removeTopics: [name] })}
                  />
                )}
              />
            </dd>
            <dt>Tags</dt>
            <dd>
              <TagField person={person} open={tagsOpen} onOpenChange={setTagsOpen} save={save} />
            </dd>
          </dl>
          <PersonStats personId={person.id} />
          <dl className={styles.meta}>
            <div>
              <dt>Added</dt>
              <dd>
                <time dateTime={person.createdAt}>{absoluteTime(person.createdAt)}</time>
              </dd>
            </div>
          </dl>
          <div className={styles.sideActions}>
            <Button variant="ghost" onClick={() => setConfirmDelete(true)}>
              Delete person
            </Button>
          </div>
          <p className={styles.keysHint}>
            <Kbd keys="e" /> name <Kbd keys="t" /> topics <Kbd keys="l" /> tags
          </p>
        </aside>
      </div>
      <DeletePersonDialog person={person} open={confirmDelete} onOpenChange={setConfirmDelete} />
    </div>
  );
}

function NameForm({
  person,
  onDone,
}: {
  person: Person;
  onDone: (names: { firstName: string; lastName: string } | null) => void;
}) {
  const [firstName, setFirstName] = useState(person.firstName);
  const [lastName, setLastName] = useState(person.lastName);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const names = { firstName: firstName.trim(), lastName: lastName.trim() };
    if (!names.firstName || !names.lastName) return;
    const changed = names.firstName !== person.firstName || names.lastName !== person.lastName;
    onDone(changed ? names : null);
  };
  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Esc anywhere in the form cancels the rename
    <form
      className={styles.nameForm}
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onDone(null);
        }
      }}
    >
      {/* Two labelled fields, each with its text selected: typing replaces that part of the name only. */}
      <Field label="First name">
        <TextInput
          value={firstName}
          onChange={(e) => setFirstName(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          maxLength={100}
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- opened on purpose with e
          autoFocus
        />
      </Field>
      <Field label="Last name">
        <TextInput
          value={lastName}
          onChange={(e) => setLastName(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          maxLength={100}
        />
      </Field>
      <Button type="submit" variant="primary" size="sm">
        Save name
      </Button>
      <Button size="sm" variant="ghost" onClick={() => onDone(null)}>
        Cancel
      </Button>
    </form>
  );
}

/** The most topics GET /topics returns at once. */
const TOPIC_LIST_LIMIT = 200;

/** A topic with its menu: show everyone with it, rename or delete it for all, or remove it here. */
function TopicChip({
  name,
  topic,
  person,
  onRemove,
}: {
  name: string;
  /** From the page's topic list; undefined while it loads or when the topic is past its limit. */
  topic: Topic | undefined;
  person: Person;
  onRemove: () => void;
}) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const toast = useToast();
  const [dialog, setDialog] = useState<{ kind: "rename" | "delete"; topic: Topic } | null>(null);
  const open = async (kind: "rename" | "delete") => {
    try {
      const found =
        topic ??
        (await client.fetchQuery(topicsQuery(name))).find((t) => t.name.toLowerCase() === name.toLowerCase());
      if (found) setDialog({ kind, topic: found });
      else toast.show({ tone: "error", message: `The topic ${name} does not exist any more.` });
    } catch (error) {
      toast.show({ tone: "error", message: `Could not load the topic ${name}. ${errorMessage(error)}` });
    }
  };
  return (
    <>
      <Menu
        label={`Topic ${name}`}
        trigger={
          <button type="button" className={styles.chip} aria-label={`Topic ${name}, open menu`}>
            {name}
            <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true" className={styles.chipCaret}>
              <path d="M1 2.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.3" />
            </svg>
          </button>
        }
        items={[
          {
            label: `Show people with this topic${topic ? ` (${topic.peopleCount})` : ""}`,
            run: () => void navigate({ to: "/people", search: { topic: name } }),
          },
          { label: `Remove from ${person.firstName}`, run: onRemove },
          { label: "Rename topic for everyone", run: () => void open("rename") },
          { label: "Delete topic for everyone", run: () => void open("delete"), danger: true },
        ]}
      />
      {dialog?.kind === "rename" && (
        <RenameTopicDialog topic={dialog.topic} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "delete" && (
        <DeleteTopicDialog topic={dialog.topic} onClose={() => setDialog(null)} />
      )}
    </>
  );
}

function RenameTopicDialog({ topic, onClose }: { topic: { id: number; name: string }; onClose: () => void }) {
  const rename = useRenameTopic();
  const [name, setName] = useState(topic.name);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await rename.mutateAsync({ id: topic.id, name: name.trim() });
      onClose();
    } catch (failure) {
      const conflict =
        failure instanceof ApiError && failure.code === "conflict"
          ? TopicConflictDetails.safeParse(failure.details)
          : null;
      setError(
        conflict?.success
          ? `There is already a topic "${conflict.data.existing.name}". Remove this one from the people who have it instead, or pick another name.`
          : errorMessage(failure),
      );
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title={`Rename ${topic.name}`} width={440}>
      <DialogBody onSubmit={submit}>
        <Field label="New name" hint="Changes the topic for everyone who has it.">
          {/* oxlint-disable-next-line jsx-a11y/no-autofocus -- the dialog opens to type */}
          <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus />
        </Field>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!name.trim() || rename.isPending}>
            Rename topic
          </Button>
        </DialogActions>
      </DialogBody>
    </Dialog>
  );
}

function DeleteTopicDialog({
  topic,
  onClose,
}: {
  topic: { id: number; name: string; peopleCount: number };
  onClose: () => void;
}) {
  const remove = useDeleteTopic();
  const toast = useToast();
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Delete ${topic.name}?`}
      description={`The topic is removed from ${topic.peopleCount === 1 ? "the one person" : `all ${topic.peopleCount} people`} who have it.`}
      width={440}
    >
      <DialogBody>
        <DialogActions>
          <Button onClick={onClose}>Keep it</Button>
          <Button
            variant="danger"
            disabled={remove.isPending}
            onClick={async () => {
              try {
                await remove.mutateAsync(topic.id);
                toast.show({ message: `Deleted topic ${topic.name}` });
                onClose();
              } catch (error) {
                toast.show({
                  tone: "error",
                  message: `Could not delete ${topic.name}. ${errorMessage(error)}`,
                });
              }
            }}
          >
            Delete topic
          </Button>
        </DialogActions>
      </DialogBody>
    </Dialog>
  );
}

/** Person tags, picked like labels; a new name creates the tag with the next palette color. */
function TagField({
  person,
  open,
  onOpenChange,
  save,
}: {
  person: Person;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  save: (patch: UpdatePerson) => Promise<boolean>;
}) {
  const tags = usePersonTags();
  const create = useCreatePersonTag();
  const toast = useToast();
  const [search, setSearch] = useState("");
  const selected = new Set(person.tags.map((t) => t.name.toLowerCase()));
  const all = tags.data ?? [];
  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      trigger={
        <FieldButton empty={person.tags.length === 0} aria-label="Tags">
          {person.tags.length === 0
            ? "No tags"
            : person.tags.map((tag) => (
                <LabelPill
                  key={tag.id}
                  name={tag.name}
                  color={tag.color}
                  title={tag.description || tag.name}
                />
              ))}
        </FieldButton>
      }
    >
      <Picker
        label="Tags"
        placeholder="Add or remove tags, or type a new one"
        search={search}
        onSearchChange={setSearch}
        items={all
          .filter((tag) => tag.name.toLowerCase().includes(search.trim().toLowerCase()))
          .map((tag) => ({
            value: tag.name.toLowerCase(),
            search: tag.name,
            label: <LabelPill name={tag.name} color={tag.color} />,
            note: tag.description || undefined,
          }))}
        selected={selected}
        onPick={(lower) => {
          const tag = all.find((t) => t.name.toLowerCase() === lower);
          if (tag) void save(selected.has(lower) ? { removeTags: [tag.name] } : { addTags: [tag.name] });
        }}
        createItem={(text) => {
          const name = text.trim();
          if (!name || name.includes(",") || name.includes("::")) return null;
          if (all.some((t) => t.name.toLowerCase() === name.toLowerCase())) return null;
          return {
            label: `Create tag ${name}`,
            run: async () => {
              try {
                const color = PROJECT_COLORS[all.length % PROJECT_COLORS.length] as string;
                const tag = await create.mutateAsync({ name, color });
                setSearch("");
                await save({ addTags: [tag.name] });
              } catch (error) {
                toast.show({ tone: "error", message: `Could not create the tag. ${errorMessage(error)}` });
              }
            },
          };
        }}
        empty="No tags yet. Type a name to create one, like fast reply."
      />
    </Popover>
  );
}

const TODO_TABS = { active: "Active", done: "Done", all: "All" } as const;
type TodoTab = keyof typeof TODO_TABS;

function PersonTodos({ person, role, title }: { person: Person; role: PersonRole; title: string }) {
  const [tab, setTab] = useState<TodoTab>("active");
  const todos = useTodos({
    personId: person.id,
    personRole: role,
    status: tab === "active" ? undefined : tab,
    sort: "created",
    order: "desc",
    limit: 200,
  });
  const items = todos.data?.items ?? [];
  return (
    <section className={styles.todos} aria-label={title}>
      <div className={styles.todosHead}>
        <h2 className={styles.todosTitle}>
          {title} <span className={styles.todosCount}>{todos.data?.total ?? ""}</span>
        </h2>
        <div className={styles.tabs} role="group" aria-label={`${title} todos`}>
          {(Object.keys(TODO_TABS) as TodoTab[]).map((key) => (
            <button
              key={key}
              type="button"
              className={styles.tab}
              aria-pressed={tab === key}
              onClick={() => setTab(key)}
            >
              {TODO_TABS[key]}
            </button>
          ))}
        </div>
      </div>
      {todos.isPending && <Loading />}
      {todos.isError && <ErrorState error={todos.error} onRetry={() => void todos.refetch()} />}
      {todos.data && items.length === 0 && (
        <p className={styles.quiet}>
          {tab === "active" ? `No open todos here.` : tab === "done" ? "Nothing done yet." : "No todos yet."}
        </p>
      )}
      {items.length > 0 && (
        <ol className={styles.todoList}>
          {items.map((todo) => (
            <PersonTodoRow key={todo.id} todo={todo} />
          ))}
        </ol>
      )}
    </section>
  );
}

function PersonTodoRow({ todo }: { todo: Todo }) {
  return (
    <li
      className={styles.todoRow}
      data-priority={priorityOf(todo.labels) ?? "none"}
      data-done={todo.status === "done" || undefined}
    >
      <span className={styles.todoBand} aria-hidden="true" />
      <span className={styles.todoId}>#{todo.id}</span>
      <Link to="/todos/$id" params={{ id: String(todo.id) }} className={styles.todoTitle}>
        {todo.title}
      </Link>
      <span className={styles.todoStatus} data-status={todo.status}>
        {STATUS_LABELS[todo.status]}
      </span>
      <span className={styles.todoDate} title={`Created ${absoluteTime(todo.createdAt)}`}>
        {absoluteDate(todo.createdAt)}
      </span>
      <span className={styles.todoDate}>
        {todo.doneAt && todo.durationMs !== null ? `took ${formatDuration(todo.durationMs)}` : ""}
      </span>
    </li>
  );
}

function DeletePersonDialog({
  person,
  open,
  onOpenChange,
}: {
  person: Person;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const remove = useDeletePerson();
  const navigate = useNavigate();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setError(null);
        onOpenChange(next);
      }}
      title={`Delete ${person.displayName}?`}
      description="Their notes, topics and tags are removed for good."
      width={440}
    >
      <DialogBody>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        <DialogActions>
          <Button onClick={() => onOpenChange(false)}>Keep</Button>
          <Button
            variant="danger"
            disabled={remove.isPending}
            onClick={async () => {
              try {
                await remove.mutateAsync(person.id);
                onOpenChange(false);
                toast.show({ message: `Deleted ${person.displayName}` });
                void navigate({ to: "/people" });
              } catch (failure) {
                setError(deleteProblem(failure));
              }
            }}
          >
            Delete person
          </Button>
        </DialogActions>
      </DialogBody>
    </Dialog>
  );
}

/** 409 while linked: say how many todos and what to do. */
export function deleteProblem(failure: unknown): string {
  if (failure instanceof ApiError && failure.code === "conflict") {
    const linked = (failure.details as { linkedTodos?: unknown } | undefined)?.linkedTodos;
    if (typeof linked === "number") {
      return `Linked to ${linked} ${linked === 1 ? "todo" : "todos"}. Remove them from ${linked === 1 ? "that todo" : "those todos"} first.`;
    }
  }
  return errorMessage(failure);
}
