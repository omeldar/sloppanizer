import { API_PREFIX, type FileUse, type ManagedFile } from "@organizer/shared";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Dialog, DialogActions } from "../../components/Dialog.tsx";
import { useToast } from "../../components/toast/ToastProvider.tsx";
import { Button, EmptyState, ErrorState, Loading, PageHeader } from "../../components/ui.tsx";
import { errorMessage } from "../../lib/api.ts";
import { clearAttachmentCache } from "../../lib/attachmentCache.ts";
import { downloadFile } from "../../lib/download.ts";
import { absoluteTime, formatBytes, relativeTime } from "../../lib/format.ts";
import { useDeleteFile, useFiles } from "../../lib/queries.ts";
import { SessionOnly } from "./SessionOnly.tsx";
import listStyles from "../lists/Lists.module.css";
import styles from "./Files.module.css";

type Show = "all" | "unused";
type Order = "newest" | "biggest";

/** The files page: every uploaded file with its size and where it is linked from, to delete old ones. */
export function FilesPage() {
  return (
    <SessionOnly>
      <FilesView />
    </SessionOnly>
  );
}

/** The files a filter and order leave, in that order. */
export function shownFiles(items: readonly ManagedFile[], show: Show, order: Order): ManagedFile[] {
  const kept = show === "unused" ? items.filter((f) => f.usedIn.length === 0) : [...items];
  return order === "biggest" ? kept.toSorted((a, b) => b.size - a.size || b.id - a.id) : kept;
}

function FilesView() {
  const files = useFiles();
  const [show, setShow] = useState<Show>("all");
  const [order, setOrder] = useState<Order>("newest");
  const [deleting, setDeleting] = useState<ManagedFile | null>(null);
  const data = files.data;
  const items = data ? shownFiles(data.items, show, order) : [];
  const unused = data ? data.items.filter((f) => f.usedIn.length === 0) : [];
  const unusedBytes = unused.reduce((sum, f) => sum + f.size, 0);
  const share = data && data.limitBytes > 0 ? Math.min(1, data.usedBytes / data.limitBytes) : 0;

  return (
    <div className={styles.page}>
      <PageHeader
        title="Files"
        meta={data ? `${formatBytes(data.usedBytes)} of ${formatBytes(data.limitBytes)} used` : undefined}
      />
      <p className={styles.intro}>
        Pasted images and attached files count against this account's limit. Delete the ones you no longer
        need: the space is free at once. Links to a deleted file show it as missing.
      </p>

      {data && (
        <div className={styles.usage}>
          <div
            className={styles.meter}
            role="meter"
            aria-label="Space used"
            aria-valuemin={0}
            aria-valuemax={data.limitBytes}
            aria-valuenow={data.usedBytes}
            aria-valuetext={`${formatBytes(data.usedBytes)} of ${formatBytes(data.limitBytes)}`}
            data-level={share >= 0.9 ? "full" : share >= 0.7 ? "high" : undefined}
          >
            <span style={{ width: `${(share * 100).toFixed(1)}%` }} />
          </div>
          <span className={styles.usageText}>
            {data.items.length} {data.items.length === 1 ? "file" : "files"}
            {unused.length > 0 && ` · ${unused.length} not used anywhere (${formatBytes(unusedBytes)})`}
          </span>
        </div>
      )}

      {data && data.items.length > 0 && (
        <div className={styles.tools}>
          <div className={listStyles.modes} role="group" aria-label="Show">
            {(["all", "unused"] as const).map((option) => (
              <button
                key={option}
                type="button"
                className={listStyles.mode}
                aria-pressed={show === option}
                onClick={() => setShow(option)}
              >
                {option === "all" ? "All files" : "Not used anywhere"}
              </button>
            ))}
          </div>
          <div className={listStyles.modes} role="group" aria-label="Order">
            {(["newest", "biggest"] as const).map((option) => (
              <button
                key={option}
                type="button"
                className={listStyles.mode}
                aria-pressed={order === option}
                onClick={() => setOrder(option)}
              >
                {option === "newest" ? "Newest first" : "Biggest first"}
              </button>
            ))}
          </div>
        </div>
      )}

      {files.isPending && <Loading />}
      {files.isError && <ErrorState error={files.error} onRetry={() => void files.refetch()} />}
      {data && data.items.length === 0 && (
        <EmptyState>No files yet. Paste an image or attach a file in a todo, comment or note.</EmptyState>
      )}
      {data && data.items.length > 0 && items.length === 0 && (
        <EmptyState>Every file is linked from somewhere.</EmptyState>
      )}
      {items.length > 0 && (
        <ul className={styles.list} aria-label="Files">
          {items.map((file) => (
            <FileRow key={file.id} file={file} onDelete={() => setDeleting(file)} />
          ))}
        </ul>
      )}

      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.name ?? ""}?`}
        description={
          deleting && deleting.usedIn.length > 0
            ? `It is still linked from ${places(deleting.usedIn.length)}. Those links will show a missing file. This cannot be undone.`
            : "Nothing links to it. This cannot be undone."
        }
        width={460}
      >
        {deleting && <DeleteActions file={deleting} onDone={() => setDeleting(null)} />}
      </Dialog>
    </div>
  );
}

const places = (n: number): string => (n === 1 ? "1 place" : `${n} places`);

function FileRow({ file, onDelete }: { file: ManagedFile; onDelete: () => void }) {
  const toast = useToast();
  const download = () =>
    void downloadFile(file.url.slice(API_PREFIX.length), file.name).catch((error: unknown) =>
      toast.show({ tone: "error", message: `Could not download ${file.name}. ${errorMessage(error)}` }),
    );
  return (
    <li className={styles.row}>
      <div className={styles.main}>
        <button type="button" className={styles.name} onClick={download} title={`Download ${file.name}`}>
          {file.name}
        </button>
        <span className={styles.meta}>
          {formatBytes(file.size)} ·{" "}
          <span title={absoluteTime(file.createdAt)}>{relativeTime(file.createdAt)}</span>
        </span>
        <span className={styles.uses}>
          {file.usedIn.length === 0 ? (
            <span className={styles.unused}>Not used anywhere</span>
          ) : (
            <>
              Used in{" "}
              {file.usedIn.map((use, i) => (
                <span key={`${use.kind}-${use.id}`}>
                  {i > 0 && ", "}
                  <UseLink use={use} />
                </span>
              ))}
            </>
          )}
        </span>
      </div>
      <Button variant="danger" onClick={onDelete} aria-label={`Delete ${file.name}`}>
        Delete
      </Button>
    </li>
  );
}

const KIND: Record<FileUse["kind"], string> = {
  todo: "todo",
  comment: "comment on",
  note: "note",
  person: "notes on",
};

function UseLink({ use }: { use: FileUse }) {
  const label = `${KIND[use.kind]} ${use.title}`;
  if (use.kind === "note")
    return (
      <Link to="/notes/$id" params={{ id: String(use.id) }}>
        {label}
      </Link>
    );
  if (use.kind === "person")
    return (
      <Link to="/people/$id" params={{ id: String(use.id) }}>
        {label}
      </Link>
    );
  return (
    <Link to="/todos/$id" params={{ id: String(use.todoId ?? use.id) }}>
      {label}
    </Link>
  );
}

function DeleteActions({ file, onDone }: { file: ManagedFile; onDone: () => void }) {
  const remove = useDeleteFile();
  const toast = useToast();
  return (
    <DialogActions>
      <Button onClick={onDone}>Keep it</Button>
      <Button
        variant="danger"
        disabled={remove.isPending}
        onClick={async () => {
          try {
            await remove.mutateAsync(file.id);
            clearAttachmentCache();
            toast.show({ message: `Deleted ${file.name}, ${formatBytes(file.size)} free again` });
            onDone();
          } catch (error) {
            toast.show({ tone: "error", message: `Could not delete ${file.name}. ${errorMessage(error)}` });
          }
        }}
      >
        Delete file
      </Button>
    </DialogActions>
  );
}
