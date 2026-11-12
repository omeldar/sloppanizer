import { type ClipboardEvent, type KeyboardEvent, type Ref, useState } from "react";
import { useToast } from "../../../components/toast/ToastProvider.tsx";
import { Button } from "../../../components/ui.tsx";
import { errorMessage } from "../../../lib/api.ts";
import { useAddSubtasks } from "../../../lib/queries.ts";
import styles from "./Relations.module.css";

/** Pasted text -> one title per non-empty line (list markers and checkboxes removed, 300 characters max). */
export function pastedTitles(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s+/, "")
        .replace(/^\[[ xX]\]\s+/, "")
        .trim(),
    )
    .filter(Boolean)
    .map((line) => line.slice(0, 300));
}

/** "Add subtask": Enter creates one; pasting several lines offers one subtask per line. */
export function SubtaskInput({ todoId, inputRef }: { todoId: number; inputRef?: Ref<HTMLInputElement> }) {
  const [text, setText] = useState("");
  const [pasted, setPasted] = useState<string[] | null>(null);
  const add = useAddSubtasks(todoId);
  const toast = useToast();

  const create = async (titles: string[]) => {
    try {
      await add.mutateAsync(titles);
      setText("");
      setPasted(null);
    } catch (error) {
      toast.show({ tone: "error", message: `Could not add the subtask. ${errorMessage(error)}` });
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && text.trim() && !add.isPending) {
      event.preventDefault();
      void create([text.trim().slice(0, 300)]);
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const titles = pastedTitles(event.clipboardData.getData("text"));
    if (titles.length < 2) return;
    event.preventDefault();
    setPasted(titles.slice(0, 50));
  };

  return (
    <div className={styles.subtaskInput}>
      <input
        ref={inputRef}
        className={styles.addInput}
        value={text}
        maxLength={300}
        placeholder="Add subtask"
        aria-label="Add subtask"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
      {pasted && (
        <div className={styles.pasted} role="alert">
          <span>
            Add {pasted.length} subtasks, one per line?
            {pasted.length === 50 && " Only the first 50 lines are used."}
          </span>
          <Button size="sm" variant="primary" disabled={add.isPending} onClick={() => void create(pasted)}>
            Add {pasted.length}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setPasted(null)}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
