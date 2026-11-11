import type { CreateTodo } from "@organizer/shared";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { useCommands } from "../../app/commands.tsx";
import { Dialog } from "../../components/Dialog.tsx";
import { LabelPill } from "../../components/LabelPill.tsx";
import { Popover } from "../../components/Popover.tsx";
import {
  LabelPicker,
  PeoplePicker,
  type PersonChoice,
  ProjectPicker,
  toggleLabel,
} from "../../components/pickers/pickers.tsx";
import { useToast } from "../../components/toast/ToastProvider.tsx";
import { Button, FieldButton, Kbd, TextInput } from "../../components/ui.tsx";
import { errorMessage } from "../../lib/api.ts";
import { useCreateTodo, useLabels, useProjects } from "../../lib/queries.ts";
import { personRef } from "../todos/TodoPickerDialog.tsx";
import styles from "./QuickAdd.module.css";
import { parseQuickTitle } from "./tokens.ts";

export function QuickAdd() {
  const { quickAdd, close } = useCommands();
  return (
    <Dialog
      open={quickAdd !== null}
      onOpenChange={(open) => !open && close("quickAdd")}
      title="New todo"
      width={600}
      placement="top"
    >
      {quickAdd && <QuickAddForm projectSlug={quickAdd.projectSlug} onDone={() => close("quickAdd")} />}
    </Dialog>
  );
}

function QuickAddForm({ projectSlug, onDone }: { projectSlug?: string; onDone: () => void }) {
  const projects = useProjects();
  const labels = useLabels();
  const create = useCreateTodo();
  const toast = useToast();
  const navigate = useNavigate();

  const [text, setText] = useState("");
  const [projectId, setProjectId] = useState<number | null>(
    () => projects.data?.find((p) => p.slug === projectSlug)?.id ?? null,
  );
  const [picked, setPicked] = useState<string[]>([]);
  const [people, setPeople] = useState<PersonChoice[]>([]);
  const [dueOn, setDueOn] = useState("");
  const [open, setOpen] = useState<"project" | "labels" | "people" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const parsed = parseQuickTitle(text, labels.data ?? []);
  const allLabels = parsed.labels.reduce(
    (acc, name) => (acc.some((n) => n.toLowerCase() === name.toLowerCase()) ? acc : toggleLabel(acc, name)),
    picked,
  );
  const project = projects.data?.find((p) => p.id === projectId);
  const labelColor = (name: string) =>
    labels.data?.find((l) => l.name.toLowerCase() === name.toLowerCase())?.color ?? "#8B95A5";

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!parsed.title) {
      setError("Give the todo a title.");
      return;
    }
    const input: CreateTodo = {
      title: parsed.title,
      projectId,
      ...(allLabels.length > 0 && { labels: allLabels }),
      ...(people.length > 0 && { requestedBy: people.map(personRef) }),
      ...(dueOn && { dueOn }),
    };
    try {
      const todo = await create.mutateAsync(input);
      onDone();
      toast.show({
        message: `Added #${todo.id}`,
        action: {
          label: "Open",
          run: () => void navigate({ to: "/todos/$id", params: { id: String(todo.id) } }),
        },
      });
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };

  return (
    <form
      className={styles.form}
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) void submit(event);
      }}
    >
      <TextInput
        className={styles.title}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setError(null);
        }}
        placeholder="What needs doing? Add labels inline with ~name"
        aria-label="Title"
        maxLength={400}
        // The dialog opens to type a title.
        // oxlint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
      />
      {parsed.unknown.length > 0 && (
        <p className={styles.note}>
          No label named {parsed.unknown.map((t) => `~${t}`).join(", ")}; it stays in the title.
        </p>
      )}
      <div className={styles.fields}>
        <span className={styles.fieldName}>Project</span>
        <Popover
          open={open === "project"}
          onOpenChange={(o) => setOpen(o ? "project" : null)}
          trigger={<FieldButton empty={!project}>{project ? project.name : "Inbox"}</FieldButton>}
        >
          <ProjectPicker
            value={projectId}
            onChange={(id) => {
              setProjectId(id);
              setOpen(null);
            }}
          />
        </Popover>

        <span className={styles.fieldName}>Labels</span>
        <Popover
          open={open === "labels"}
          onOpenChange={(o) => setOpen(o ? "labels" : null)}
          trigger={
            <FieldButton empty={allLabels.length === 0}>
              {allLabels.length === 0
                ? "No labels"
                : allLabels.map((name) => <LabelPill key={name} name={name} color={labelColor(name)} />)}
            </FieldButton>
          }
        >
          <LabelPicker
            value={allLabels}
            onToggle={(name) => {
              // A label that came from a ~token is removed from the text.
              const fromToken = parsed.labels.some((n) => n.toLowerCase() === name.toLowerCase());
              if (fromToken)
                setText((t) => t.replace(new RegExp(`(^|\\s)~${escapeRegExp(name)}(?=\\s|$)`, "i"), "$1"));
              setPicked((current) => (fromToken ? current : toggleLabel(current, name)));
            }}
          />
        </Popover>

        <span className={styles.fieldName}>Requested by</span>
        <Popover
          open={open === "people"}
          onOpenChange={(o) => setOpen(o ? "people" : null)}
          trigger={
            <FieldButton empty={people.length === 0}>
              {people.length === 0 ? "Nobody" : people.map((p) => p.displayName).join(", ")}
            </FieldButton>
          }
        >
          <PeoplePicker
            value={people}
            onToggle={(choice) =>
              setPeople((current) => {
                const same = (c: PersonChoice) =>
                  c.displayName.toLowerCase() === choice.displayName.toLowerCase();
                return current.some(same) ? current.filter((c) => !same(c)) : [...current, choice];
              })
            }
          />
        </Popover>

        <span className={styles.fieldName}>Due</span>
        <input
          type="date"
          className={styles.date}
          value={dueOn}
          onChange={(event) => setDueOn(event.target.value)}
          aria-label="Due date"
        />
      </div>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <footer className={styles.footer}>
        <span className={styles.hint}>
          <Kbd keys="Enter" /> save <Kbd keys="Escape" /> cancel
        </span>
        <Button type="submit" variant="primary" disabled={create.isPending}>
          {create.isPending ? "Adding" : "Add todo"}
        </Button>
      </footer>
    </form>
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
