import type { Todo } from "@organizer/shared";
import { useState } from "react";
import { useToast } from "../../../components/toast/ToastProvider.tsx";
import { Button } from "../../../components/ui.tsx";
import { breakDown, useAiSettings } from "../../../lib/ai.ts";
import { errorMessage } from "../../../lib/api.ts";
import { useAddSubtasks } from "../../../lib/queries.ts";
import styles from "./Relations.module.css";

/** "Suggest steps": the assistant proposes subtasks; the ticked ones are added in order. */
export function SuggestSteps({ todo, existing }: { todo: Todo; existing: readonly string[] }) {
  const ai = useAiSettings();
  const add = useAddSubtasks(todo.id);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<string[] | null>(null);
  const [off, setOff] = useState<ReadonlySet<number>>(new Set());
  const [note, setNote] = useState("");
  if (!ai.data || ai.data.provider === "none" || todo.status === "done") return null;

  const ask = async () => {
    if (!ai.data) return;
    setBusy(true);
    try {
      const result = await breakDown(todo.id, existing, ai.data);
      setSteps(result.steps);
      setOff(new Set());
      setNote(result.note);
      if (result.steps.length === 0) toast.show({ message: result.note || "No new steps to suggest." });
    } catch (failure) {
      toast.show({ tone: "error", message: errorMessage(failure) });
    } finally {
      setBusy(false);
    }
  };

  const chosen = (steps ?? []).filter((_, i) => !off.has(i));
  return (
    <div className={styles.suggest}>
      {!steps || steps.length === 0 ? (
        <Button size="sm" variant="ghost" onClick={() => void ask()} disabled={busy}>
          {busy ? "Thinking…" : "✦ Suggest steps"}
        </Button>
      ) : (
        <div className={styles.suggestBox} role="region" aria-label="Suggested steps">
          {note && <p className={styles.suggestNote}>{note}</p>}
          <ul className={styles.suggestList}>
            {steps.map((step, i) => (
              <li key={step}>
                <label className={styles.suggestItem}>
                  <input
                    type="checkbox"
                    checked={!off.has(i)}
                    onChange={() => {
                      const next = new Set(off);
                      if (next.has(i)) next.delete(i);
                      else next.add(i);
                      setOff(next);
                    }}
                  />
                  {step}
                </label>
              </li>
            ))}
          </ul>
          <div className={styles.suggestActions}>
            <Button
              size="sm"
              variant="primary"
              disabled={chosen.length === 0 || add.isPending}
              onClick={() =>
                add.mutate(chosen, {
                  onSuccess: () => {
                    setSteps(null);
                    toast.show({
                      message: `Added ${chosen.length} subtask${chosen.length === 1 ? "" : "s"}`,
                    });
                  },
                  onError: (failure) => toast.show({ tone: "error", message: errorMessage(failure) }),
                })
              }
            >
              Add {chosen.length} as subtasks
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSteps(null)}>
              Discard
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
