import { type ActivityItem, type Comment, describeEvent, type Me, type Todo } from "@organizer/shared";
import { type Ref, useEffect, useRef, useState } from "react";
import { Dialog, DialogBody, DialogActions } from "../../components/Dialog.tsx";
import { MarkdownEditor, type MarkdownEditorHandle } from "../../components/markdown/MarkdownEditor.tsx";
import { MarkdownPreview } from "../../components/markdown/MarkdownPreview.tsx";
import { useToast } from "../../components/toast/ToastProvider.tsx";
import { Button, ErrorState, Loading } from "../../components/ui.tsx";
import { errorMessage } from "../../lib/api.ts";
import { absoluteTime, relativeTime } from "../../lib/format.ts";
import {
  useActivity,
  useCreateComment,
  useDeleteComment,
  useMe,
  useUpdateComment,
} from "../../lib/queries.ts";
import styles from "./Activity.module.css";

const SHOW_CHANGES_KEY = "organizer.activity.changes";

function readShowChanges(): boolean {
  try {
    return localStorage.getItem(SHOW_CHANGES_KEY) !== "false";
  } catch {
    return true;
  }
}

/** The browser session may change any comment; a token only its own (the server enforces the same). */
export function canChangeComment(comment: Pick<Comment, "actor">, me: Me | undefined): boolean {
  if (!me || me.scope !== "write") return false;
  return me.via === "session" || comment.actor === me.actor;
}

/** Comments always; history lines only with "Show changes". */
export function visibleItems(items: readonly ActivityItem[], showChanges: boolean): ActivityItem[] {
  return showChanges ? [...items] : items.filter((item) => item.type === "comment");
}

/**
 * One thread per todo, oldest first: history lines (status, people, dates) and comments, with the
 * composer at the bottom. `focusComment` scrolls to a comment (search results link there).
 */
export function Activity({
  todo,
  composerRef,
  focusComment,
}: {
  todo: Todo;
  composerRef?: Ref<MarkdownEditorHandle>;
  focusComment?: number;
}) {
  const activity = useActivity(todo.id);
  const me = useMe();
  const [showChanges, setShowChanges] = useState(readShowChanges);
  const people = new Map([...todo.requestedBy, ...todo.contacts].map((p) => [p.id, p.displayName]));
  const items = visibleItems(activity.data?.items ?? [], showChanges);
  const comments = (activity.data?.items ?? []).filter((item) => item.type === "comment").length;

  const toggle = () => {
    setShowChanges((current) => {
      try {
        localStorage.setItem(SHOW_CHANGES_KEY, String(!current));
      } catch {
        // Private mode: the choice lasts until reload.
      }
      return !current;
    });
  };

  useEffect(() => {
    if (!focusComment || !activity.data) return;
    document.getElementById(`comment-${focusComment}`)?.scrollIntoView?.({ block: "center" });
  }, [focusComment, activity.data]);

  return (
    <section className={styles.activity} aria-label="Activity">
      <div className={styles.head}>
        <h2 className={styles.title}>
          Activity{" "}
          <span className={styles.count}>
            {comments > 0 ? `${comments} ${comments === 1 ? "comment" : "comments"}` : ""}
          </span>
        </h2>
        <label className={styles.switch}>
          <input type="checkbox" checked={showChanges} onChange={toggle} />
          Show changes
        </label>
      </div>
      {activity.isPending && <Loading />}
      {activity.isError && <ErrorState error={activity.error} onRetry={() => void activity.refetch()} />}
      {activity.data && (
        <ol className={styles.thread}>
          {items.map((item) =>
            item.type === "event" ? (
              <li key={`e${item.event.id}`} className={styles.event}>
                <span className={styles.marker} aria-hidden="true" />
                <span className={styles.eventText}>
                  <span className={styles.actor}>{item.event.actor}</span> {describeEvent(item.event, people)}
                </span>
                <Time instant={item.event.createdAt} />
              </li>
            ) : (
              <CommentBlock
                key={`c${item.comment.id}`}
                comment={item.comment}
                todoId={todo.id}
                canChange={canChangeComment(item.comment, me.data)}
                focused={item.comment.id === focusComment}
              />
            ),
          )}
          {items.length === 0 && (
            <li className={styles.empty}>
              {showChanges
                ? "Nothing here yet."
                : "No comments yet. Changes are hidden; switch on Show changes to see them."}
            </li>
          )}
        </ol>
      )}
      {me.data?.scope !== "read" && <Composer todoId={todo.id} editorRef={composerRef} />}
    </section>
  );
}

function Time({ instant }: { instant: string }) {
  return (
    <time className={styles.time} dateTime={instant} title={absoluteTime(instant)}>
      {relativeTime(instant)}
    </time>
  );
}

function CommentBlock({
  comment,
  todoId,
  canChange,
  focused,
}: {
  comment: Comment;
  todoId: number;
  canChange: boolean;
  focused: boolean;
}) {
  const update = useUpdateComment();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.bodyMd);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = async () => {
    if (!draft.trim()) return;
    try {
      await update.mutateAsync({ id: comment.id, bodyMd: draft });
      setEditing(false);
    } catch (error) {
      toast.show({ tone: "error", message: `Could not save the comment. ${errorMessage(error)}` });
    }
  };

  return (
    <li id={`comment-${comment.id}`} className={styles.comment} data-focused={focused || undefined}>
      <div className={styles.commentHead}>
        <span className={styles.commentActor}>{comment.actor}</span>
        <Time instant={comment.createdAt} />
        {comment.editedAt && (
          <span className={styles.edited} title={`Edited ${absoluteTime(comment.editedAt)}`}>
            edited
          </span>
        )}
        {canChange && !editing && (
          <span className={styles.commentActions}>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft(comment.bodyMd);
                setEditing(true);
              }}
            >
              Edit
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          </span>
        )}
      </div>
      {editing ? (
        <div className={styles.editBox}>
          <MarkdownEditor
            label="Edit comment"
            value={comment.bodyMd}
            onChange={setDraft}
            onSubmit={() => void save()}
            compact
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- Edit opens the box to type
            autoFocus
          />
          <div className={styles.composerActions}>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              hint="ctrl+Enter"
              disabled={!draft.trim() || update.isPending}
              onClick={() => void save()}
            >
              Save comment
            </Button>
          </div>
        </div>
      ) : (
        <div className={styles.commentBody}>
          <MarkdownPreview source={comment.bodyMd} />
        </div>
      )}
      <DeleteCommentDialog
        comment={comment}
        todoId={todoId}
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
      />
    </li>
  );
}

function DeleteCommentDialog({
  comment,
  todoId,
  open,
  onOpenChange,
}: {
  comment: Comment;
  todoId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const remove = useDeleteComment();
  const toast = useToast();
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Delete this comment?"
      description={`The comment on #${todoId} is removed for good. Attached files stay stored.`}
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
                await remove.mutateAsync(comment.id);
                onOpenChange(false);
                toast.show({ message: "Deleted the comment" });
              } catch (error) {
                toast.show({
                  tone: "error",
                  message: `Could not delete the comment. ${errorMessage(error)}`,
                });
              }
            }}
          >
            Delete comment
          </Button>
        </DialogActions>
      </DialogBody>
    </Dialog>
  );
}

/** New comment box; ctrl+enter sends, the text clears after sending. */
function Composer({ todoId, editorRef }: { todoId: number; editorRef?: Ref<MarkdownEditorHandle> }) {
  const create = useCreateComment(todoId);
  const toast = useToast();
  const [draft, setDraft] = useState("");
  // A new key gives a fresh, empty editor after sending (CodeMirror owns its text).
  const [round, setRound] = useState(0);
  const sending = useRef(false);

  const send = async () => {
    if (!draft.trim() || sending.current) return;
    sending.current = true;
    try {
      await create.mutateAsync(draft);
      setDraft("");
      setRound((r) => r + 1);
    } catch (error) {
      toast.show({ tone: "error", message: `Could not send the comment. ${errorMessage(error)}` });
    } finally {
      sending.current = false;
    }
  };

  return (
    <div className={styles.composer}>
      <MarkdownEditor
        key={round}
        ref={editorRef}
        label="New comment"
        placeholder="Write a comment. Markdown and pasted images work; ctrl+enter sends."
        value=""
        onChange={setDraft}
        onSubmit={() => void send()}
        compact
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- after sending, the next comment can be typed right away
        autoFocus={round > 0}
      />
      <div className={styles.composerActions}>
        <Button
          variant="primary"
          size="sm"
          hint="ctrl+Enter"
          disabled={!draft.trim() || create.isPending}
          onClick={() => void send()}
        >
          Comment
        </Button>
      </div>
    </div>
  );
}
