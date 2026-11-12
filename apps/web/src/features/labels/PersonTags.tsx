import { DEFAULT_PERSON_TAG_COLOR, type PersonTag, PersonTagConflictDetails } from "@organizer/shared";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Dialog } from "../../components/Dialog.tsx";
import { LabelPill } from "../../components/LabelPill.tsx";
import { useToast } from "../../components/toast/ToastProvider.tsx";
import { Button, EmptyState, ErrorState, Field, Loading, TextInput } from "../../components/ui.tsx";
import { ApiError, errorMessage } from "../../lib/api.ts";
import {
  useCreatePersonTag,
  useDeletePersonTag,
  usePersonTags,
  useUpdatePersonTag,
} from "../../lib/queries.ts";
import styles from "./Labels.module.css";

type Editing =
  | { mode: "create" }
  | { mode: "edit"; tag: PersonTag }
  | { mode: "delete"; tag: PersonTag }
  | null;

/** What is wrong with a tag name, or null (the server checks the same). */
export function tagNameProblem(name: string): string | null {
  if (name.includes("::")) return 'Person tags cannot contain "::"; that is for scoped todo labels.';
  if (name.includes(",")) return "Tag names cannot contain commas.";
  if (name.length > 60) return "Keep tag names at 60 characters or fewer.";
  return null;
}

/** Person tags: the user's own notes about colleagues, kept apart from todo labels. */
export function PersonTagsSection() {
  const tags = usePersonTags();
  const [editing, setEditing] = useState<Editing>(null);
  return (
    <section className={styles.group} aria-label="Person tags">
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>Person tags</h2>
        <Button size="sm" onClick={() => setEditing({ mode: "create" })}>
          New person tag
        </Button>
      </div>
      <p className={styles.intro}>
        Your own judgments about people, like <code>fast reply</code> or <code>needs a ticket</code>. They
        show on People and person pages, never on todos.
      </p>
      {tags.isPending && <Loading />}
      {tags.isError && <ErrorState error={tags.error} onRetry={() => void tags.refetch()} />}
      {tags.data?.length === 0 && (
        <EmptyState>No person tags yet. Choose New person tag, or type one on a person's page.</EmptyState>
      )}
      {tags.data && tags.data.length > 0 && (
        <ul className={styles.list}>
          {tags.data.map((tag) => (
            <li key={tag.id} className={styles.row}>
              <span className={styles.pill}>
                <LabelPill name={tag.name} color={tag.color} />
              </span>
              <span className={styles.description}>
                {tag.description || <span className={styles.none}>No description</span>}
              </span>
              <Link to="/people" search={{ tag: tag.name }} className={styles.count}>
                {tag.peopleCount} {tag.peopleCount === 1 ? "person" : "people"}
              </Link>
              <span className={styles.actions}>
                <Button size="sm" variant="ghost" onClick={() => setEditing({ mode: "edit", tag })}>
                  Edit
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing({ mode: "delete", tag })}>
                  Delete
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <TagDialog editing={editing} onClose={() => setEditing(null)} />
    </section>
  );
}

function TagDialog({ editing, onClose }: { editing: Editing; onClose: () => void }) {
  const title =
    editing?.mode === "create"
      ? "New person tag"
      : editing?.mode === "edit"
        ? `Edit ${editing.tag.name}`
        : `Delete ${editing?.tag.name ?? ""}?`;
  return (
    <Dialog
      open={editing !== null}
      onOpenChange={(open) => !open && onClose()}
      title={title}
      description={editing?.mode === "delete" ? "The tag is removed from everyone who has it." : undefined}
      width={460}
    >
      {editing?.mode === "delete" ? (
        <DeleteTag tag={editing.tag} onDone={onClose} />
      ) : editing ? (
        <TagForm tag={editing.mode === "edit" ? editing.tag : undefined} onDone={onClose} />
      ) : null}
    </Dialog>
  );
}

function TagForm({ tag, onDone }: { tag?: PersonTag; onDone: () => void }) {
  const create = useCreatePersonTag();
  const update = useUpdatePersonTag();
  const [name, setName] = useState(tag?.name ?? "");
  const [color, setColor] = useState(tag?.color ?? DEFAULT_PERSON_TAG_COLOR);
  const [description, setDescription] = useState(tag?.description ?? "");
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();
  const problem = trimmed ? tagNameProblem(trimmed) : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (problem || !trimmed) return;
    try {
      if (tag) {
        const patch = {
          ...(trimmed !== tag.name && { name: trimmed }),
          ...(color.toLowerCase() !== tag.color.toLowerCase() && { color }),
          ...(description !== tag.description && { description }),
        };
        if (Object.keys(patch).length > 0) await update.mutateAsync({ id: tag.id, patch });
      } else {
        await create.mutateAsync({ name: trimmed, color, description });
      }
      onDone();
    } catch (failure) {
      const conflict =
        failure instanceof ApiError && failure.code === "conflict"
          ? PersonTagConflictDetails.safeParse(failure.details)
          : null;
      setError(
        conflict?.success
          ? `There is already a tag called ${conflict.data.existing.name}.`
          : errorMessage(failure),
      );
    }
  };

  return (
    <form className={styles.form} onSubmit={submit}>
      <Field label="Name" hint={problem ?? "Shown as a pill on people, like a plain label."}>
        {/* oxlint-disable-next-line jsx-a11y/no-autofocus -- the dialog opens to type a name */}
        <TextInput
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="fast reply"
          autoFocus
          maxLength={60}
        />
      </Field>
      <div className={styles.formRow}>
        <Field label="Color">
          <input
            type="color"
            className={styles.colorInput}
            value={color}
            onChange={(e) => setColor(e.target.value.toUpperCase())}
          />
        </Field>
        <div className={styles.previewPill}>
          {trimmed && !problem && <LabelPill name={trimmed} color={color} />}
        </div>
      </div>
      <Field label="Description">
        <TextInput
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={2000}
          placeholder="What the tag means"
        />
      </Field>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.formActions}>
        <Button
          type="submit"
          variant="primary"
          disabled={!trimmed || problem !== null || create.isPending || update.isPending}
        >
          {tag ? "Save tag" : "Create tag"}
        </Button>
      </div>
    </form>
  );
}

function DeleteTag({ tag, onDone }: { tag: PersonTag; onDone: () => void }) {
  const remove = useDeletePersonTag();
  const toast = useToast();
  return (
    <div className={styles.formActions} style={{ padding: 16 }}>
      <Button onClick={onDone}>Keep it</Button>
      <Button
        variant="danger"
        disabled={remove.isPending}
        onClick={async () => {
          try {
            await remove.mutateAsync(tag.id);
            toast.show({ message: `Deleted person tag ${tag.name}` });
            onDone();
          } catch (error) {
            toast.show({ tone: "error", message: `Could not delete ${tag.name}. ${errorMessage(error)}` });
          }
        }}
      >
        Delete tag
      </Button>
    </div>
  );
}
