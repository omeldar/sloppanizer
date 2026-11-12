import {
  DEFAULT_LABEL_COLOR,
  type Label,
  labelNameProblem,
  parseLabelName,
  ScopeConflictDetails,
  scopeKey,
  type UpdateLabel,
} from "@organizer/shared";
import { type FormEvent, useState } from "react";
import { Dialog } from "../../components/Dialog.tsx";
import { LabelPill } from "../../components/LabelPill.tsx";
import { useToast } from "../../components/toast/ToastProvider.tsx";
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  Loading,
  PageHeader,
  TextInput,
} from "../../components/ui.tsx";
import { ApiError, errorMessage } from "../../lib/api.ts";
import { useCreateLabel, useDeleteLabel, useLabels, useUpdateLabel } from "../../lib/queries.ts";
import styles from "./Labels.module.css";
import { PersonTagsSection } from "./PersonTags.tsx";

type Editing = { mode: "create" } | { mode: "edit"; label: Label } | { mode: "delete"; label: Label } | null;

export function LabelsPage() {
  const labels = useLabels();
  const [editing, setEditing] = useState<Editing>(null);

  const groups = new Map<string, Label[]>();
  for (const label of labels.data ?? []) {
    const key = label.scope ?? "";
    groups.set(key, [...(groups.get(key) ?? []), label]);
  }
  const ordered = [...groups].toSorted(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));

  return (
    <div className={styles.page}>
      <PageHeader
        title="Labels"
        meta={labels.data ? `${labels.data.length} labels` : undefined}
        actions={
          <Button variant="primary" onClick={() => setEditing({ mode: "create" })}>
            New label
          </Button>
        }
      />
      <p className={styles.intro}>
        Scoped labels like <code>priority::high</code> allow one value per scope on a todo: adding another
        value of the scope replaces it. Plain labels like <code>homelab</code> combine freely.
      </p>
      {labels.isPending && <Loading />}
      {labels.isError && <ErrorState error={labels.error} onRetry={() => void labels.refetch()} />}
      {labels.data?.length === 0 && <EmptyState>No labels yet. Choose New label to add one.</EmptyState>}
      {ordered.map(([scope, list]) => (
        <section key={scope} className={styles.group}>
          <h2 className={styles.groupTitle}>
            {scope ? (
              <>
                Scope <span className={styles.mono}>{scope}</span>
              </>
            ) : (
              "Plain labels"
            )}
          </h2>
          <ul className={styles.list}>
            {list.map((label) => (
              <li key={label.id} className={styles.row}>
                <span className={styles.pill}>
                  <LabelPill name={label.name} color={label.color} />
                </span>
                <span className={styles.description}>
                  {label.description || <span className={styles.none}>No description</span>}
                </span>
                <span className={styles.color}>{label.color.toUpperCase()}</span>
                <span className={styles.actions}>
                  <Button size="sm" variant="ghost" onClick={() => setEditing({ mode: "edit", label })}>
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing({ mode: "delete", label })}>
                    Delete
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <LabelDialog editing={editing} onClose={() => setEditing(null)} />
      <PersonTagsSection />
    </div>
  );
}

function LabelDialog({ editing, onClose }: { editing: Editing; onClose: () => void }) {
  const title =
    editing?.mode === "create"
      ? "New label"
      : editing?.mode === "edit"
        ? `Edit ${editing.label.name}`
        : `Delete ${editing?.label.name ?? ""}?`;
  return (
    <Dialog
      open={editing !== null}
      onOpenChange={(open) => !open && onClose()}
      title={title}
      description={
        editing?.mode === "delete" ? "The label is removed from every todo that has it." : undefined
      }
      width={460}
    >
      {editing?.mode === "delete" ? (
        <DeleteLabel label={editing.label} onDone={onClose} />
      ) : editing ? (
        <LabelForm label={editing.mode === "edit" ? editing.label : undefined} onDone={onClose} />
      ) : null}
    </Dialog>
  );
}

function LabelForm({ label, onDone }: { label?: Label; onDone: () => void }) {
  const create = useCreateLabel();
  const update = useUpdateLabel();
  const [name, setName] = useState(label?.name ?? "");
  const [color, setColor] = useState(label?.color ?? DEFAULT_LABEL_COLOR);
  const [description, setDescription] = useState(label?.description ?? "");
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ patch: UpdateLabel; details: ScopeConflictDetails } | null>(
    null,
  );
  const trimmed = name.trim();
  const problem = trimmed ? labelNameProblem(trimmed) : null;
  const parsed = parseLabelName(trimmed);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (problem) return;
    let patch: UpdateLabel = {};
    try {
      if (label) {
        patch = {
          ...(trimmed !== label.name && { name: trimmed }),
          ...(color.toLowerCase() !== label.color.toLowerCase() && { color }),
          ...(description !== label.description && { description }),
        };
        if (Object.keys(patch).length > 0) await update.mutateAsync({ id: label.id, patch });
      } else {
        await create.mutateAsync({ name: trimmed, color, description });
      }
      onDone();
    } catch (failure) {
      const details =
        label && failure instanceof ApiError && failure.code === "conflict"
          ? ScopeConflictDetails.safeParse(failure.details)
          : null;
      if (details?.success) setConflict({ patch, details: details.data });
      else setError(errorMessage(failure));
    }
  };

  if (label && conflict && parsed.scope) {
    return (
      <ScopeConflict
        label={label}
        newName={trimmed}
        scope={parsed.scope}
        details={conflict.details}
        pending={update.isPending}
        onKeep={async () => {
          try {
            await update.mutateAsync({
              id: label.id,
              patch: { ...conflict.patch, onScopeConflict: "replace" },
            });
            onDone();
          } catch (failure) {
            setConflict(null);
            setError(errorMessage(failure));
          }
        }}
        onCancel={() => setConflict(null)}
      />
    );
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      <Field
        label="Name"
        hint={
          problem ??
          (parsed.scope
            ? `Scope ${parsed.scope}, value ${parsed.value}`
            : "Use scope::value for a scoped label.")
        }
      >
        {/* oxlint-disable-next-line jsx-a11y/no-autofocus -- the dialog opens to type a name */}
        <TextInput
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="area::backend or homelab"
          autoFocus
          maxLength={100}
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
          placeholder="What the label is for"
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
          {label ? "Save label" : "Create label"}
        </Button>
      </div>
    </form>
  );
}

/** A rename into a scope some todos already use: list them and offer to keep the renamed label. */
export function ScopeConflict({
  label,
  newName,
  scope,
  details,
  pending,
  onKeep,
  onCancel,
}: {
  label: Label;
  newName: string;
  scope: string;
  details: ScopeConflictDetails;
  pending: boolean;
  onKeep: () => void;
  onCancel: () => void;
}) {
  const labels = useLabels();
  const colorOf = (name: string) =>
    labels.data?.find((l) => l.name.toLowerCase() === name.toLowerCase())?.color ?? DEFAULT_LABEL_COLOR;
  const n = details.conflicts.length;
  const inScope = (name: string) => {
    const other = parseLabelName(name);
    return other.scope !== null && scopeKey(other.scope) === scopeKey(scope) && name !== label.name;
  };
  return (
    <section className={styles.form} aria-label="Scope conflict">
      <p className={styles.conflictText}>
        {n === 1 ? "One todo already has" : `${n} todos already have`} a label of the scope{" "}
        <span className={styles.mono}>{scope}</span>. A todo keeps one label per scope, so renaming to{" "}
        <LabelPill name={newName} color={label.color} /> would give {n === 1 ? "it" : "them"} two. Nothing
        changed yet.
      </p>
      <ul className={styles.conflicts} aria-label="Affected todos">
        {details.conflicts.map((todo) => (
          <li key={todo.todoId} className={styles.conflictRow}>
            <span className={styles.conflictId}>#{todo.todoId}</span>
            <span className={styles.conflictTitle}>{todo.title}</span>
            <span className={styles.conflictLabels}>
              <span className={styles.conflictLoses}>loses</span>
              {todo.labels.filter(inScope).map((name) => (
                <LabelPill key={name} name={name} color={colorOf(name)} />
              ))}
            </span>
          </li>
        ))}
      </ul>
      <div className={styles.formActions}>
        <Button onClick={onCancel}>Cancel</Button>
        {/* oxlint-disable-next-line jsx-a11y/no-autofocus -- the choice the rename asked for; Esc cancels */}
        <Button variant="primary" disabled={pending} onClick={onKeep} autoFocus>
          Keep the renamed label on them
        </Button>
      </div>
    </section>
  );
}

function DeleteLabel({ label, onDone }: { label: Label; onDone: () => void }) {
  const remove = useDeleteLabel();
  const toast = useToast();
  return (
    <div className={styles.formActions} style={{ padding: 16 }}>
      <Button onClick={onDone}>Keep it</Button>
      <Button
        variant="danger"
        disabled={remove.isPending}
        onClick={async () => {
          try {
            await remove.mutateAsync(label.id);
            toast.show({ message: `Deleted label ${label.name}` });
            onDone();
          } catch (error) {
            toast.show({ tone: "error", message: `Could not delete ${label.name}. ${errorMessage(error)}` });
          }
        }}
      >
        Delete label
      </Button>
    </div>
  );
}
