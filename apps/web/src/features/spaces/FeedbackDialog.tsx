import type { FeedbackKind } from "@organizer/shared";
import { useRouterState } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { useCommands } from "../../app/commands.tsx";
import { Dialog, DialogActions, DialogBody } from "../../components/Dialog.tsx";
import { useToast } from "../../components/toast/ToastProvider.tsx";
import { Button, Field, TextInput } from "../../components/ui.tsx";
import { errorMessage } from "../../lib/api.ts";
import { useSendFeedback } from "../../lib/spaces.ts";
import styles from "./Spaces.module.css";

const KINDS: { value: FeedbackKind; label: string; note: string; placeholder: string }[] = [
  {
    value: "bug",
    label: "Report a bug",
    note: "Something broke or looks wrong",
    placeholder: "What did you do, what happened, what did you expect?",
  },
  {
    value: "feature",
    label: "Request a feature",
    note: "Something you miss or an idea",
    placeholder: "What would you like to do, and why?",
  },
];

/**
 * Bug reports and feature requests: they go to the Sloppanizer project, where the admins plan them like
 * any todo. Opened from the status bar, the sidebar and the palette.
 */
export function FeedbackDialog() {
  const { feedback, close } = useCommands();
  return (
    <Dialog
      open={feedback !== null}
      onOpenChange={(open) => !open && close("feedback")}
      title="Send feedback"
      description="Goes straight to the people building Sloppanizer. Thank you!"
      width={520}
    >
      {feedback !== null && <FeedbackForm initial={feedback} onDone={() => close("feedback")} />}
    </Dialog>
  );
}

function FeedbackForm({ initial, onDone }: { initial: FeedbackKind; onDone: () => void }) {
  const send = useSendFeedback();
  const toast = useToast();
  const page = useRouterState({ select: (s) => s.location.pathname });
  const [kind, setKind] = useState<FeedbackKind>(initial);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const chosen = KINDS.find((k) => k.value === kind) ?? KINDS[0];

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      await send.mutateAsync({ kind, title: title.trim(), description, page });
      toast.show({ message: kind === "bug" ? "Bug report sent. Thanks!" : "Feature request sent. Thanks!" });
      onDone();
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };

  return (
    <DialogBody onSubmit={submit}>
      <div className={styles.kinds} role="radiogroup" aria-label="Kind of feedback">
        {KINDS.map((option) => (
          <label key={option.value} className={styles.kind} data-on={kind === option.value || undefined}>
            <input
              type="radio"
              name="feedback-kind"
              value={option.value}
              checked={kind === option.value}
              onChange={() => setKind(option.value)}
            />
            <span className={styles.kindName}>{option.label}</span>
            <span className={styles.kindNote}>{option.note}</span>
          </label>
        ))}
      </div>
      <Field label="Title">
        <TextInput
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={kind === "bug" ? "Planner forgets the week I picked" : "Export to CSV"}
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- the dialog opens to type
          autoFocus
          required
          maxLength={200}
        />
      </Field>
      <Field label="Details" hint="Optional. Markdown works. The page you are on is added for us.">
        <textarea
          className={styles.textarea}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={chosen?.placeholder}
          rows={5}
          maxLength={20_000}
        />
      </Field>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <DialogActions>
        <Button type="submit" variant="primary" disabled={!title.trim() || send.isPending}>
          {send.isPending ? "Sending" : "Send"}
        </Button>
      </DialogActions>
    </DialogBody>
  );
}
