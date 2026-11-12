import { useState } from "react";
import { Dialog } from "../../../components/Dialog.tsx";
import { useToast } from "../../../components/toast/ToastProvider.tsx";
import { ApiError, errorMessage } from "../../../lib/api.ts";
import { useAddLinks } from "../../../lib/queries.ts";
import styles from "./Relations.module.css";
import { TodoSearchPicker } from "./TodoSearchPicker.tsx";

export const LINK_KINDS = [
  { value: "blocks", label: "Blocks", note: "the other todo waits for this one" },
  { value: "blocked_by", label: "Blocked by", note: "this todo waits for the other one" },
  { value: "relates", label: "Relates to", note: "no order, just connected" },
] as const;

export type LinkKindValue = (typeof LINK_KINDS)[number]["value"];

/** The server names the loop in details.chain; say it in words. */
export function linkProblem(error: unknown): string {
  if (error instanceof ApiError && error.details && typeof error.details === "object") {
    const chain = (error.details as { chain?: unknown }).chain;
    if (Array.isArray(chain) && chain.every((id) => typeof id === "number")) {
      return `That would make a loop: ${chain.map((id) => `#${id}`).join(" blocks ")}.`;
    }
  }
  return errorMessage(error);
}

/** "Add link": pick the kind, then the other todo by #id or title. */
const NO_IDS: readonly number[] = [];

export function AddLinkDialog({
  todoId,
  open,
  onOpenChange,
  exclude = NO_IDS,
}: {
  todoId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Already linked or otherwise not pickable. */
  exclude?: readonly number[];
}) {
  const [kind, setKind] = useState<LinkKindValue>("blocked_by");
  const [error, setError] = useState<string | null>(null);
  const add = useAddLinks(todoId);
  const toast = useToast();
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={`Link #${todoId} to another todo`} width={560}>
      {open && (
        <div className={styles.linkDialog}>
          <div className={styles.kinds} role="radiogroup" aria-label="Kind of link">
            {LINK_KINDS.map((option) => (
              <label key={option.value} className={styles.kind} data-on={kind === option.value || undefined}>
                <input
                  type="radio"
                  name="kind"
                  value={option.value}
                  checked={kind === option.value}
                  onChange={() => setKind(option.value)}
                />
                <span className={styles.kindName}>{option.label}</span>
                <span className={styles.kindNote}>{option.note}</span>
              </label>
            ))}
          </div>
          <TodoSearchPicker
            label="Other todo"
            exclude={[todoId, ...exclude]}
            onPick={async (other) => {
              setError(null);
              try {
                await add.mutateAsync([{ kind, todoId: other.id }]);
                toast.show({ message: `Linked #${todoId} and #${other.id}` });
                onOpenChange(false);
              } catch (failure) {
                setError(linkProblem(failure));
              }
            }}
          />
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}
