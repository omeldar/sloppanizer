import {
  API_PREFIX,
  type RestorePreview,
  RestoreProblemDetails,
  type RestoreResult,
} from "@organizer/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { type DragEvent, type FormEvent, useEffect, useRef, useState } from "react";
import { Dialog } from "../../components/Dialog.tsx";
import { useToast } from "../../components/toast/ToastProvider.tsx";
import { Button, Field, Loading, TextInput } from "../../components/ui.tsx";
import { ApiError, errorMessage } from "../../lib/api.ts";
import { absoluteTime, formatBytes, relativeTime } from "../../lib/format.ts";
import { applyRestore, cancelRestore, uploadRestore, useBackups } from "../../lib/queries.ts";
import styles from "./Settings.module.css";

/** Same limit as the server ("Export files can be up to 1 GB."). */
export const MAX_RESTORE_BYTES = 1024 ** 3;

/** The tables the preview compares, in the user's words. */
export const RESTORE_TABLES = [
  ["todos", "Todos"],
  ["notes", "Notes"],
  ["comments", "Comments"],
  ["people", "People"],
  ["projects", "Projects"],
  ["labels", "Labels"],
  ["attachments", "Files"],
] as const;

type State =
  | { step: "idle" }
  | { step: "checking"; fileName: string }
  | { step: "problems"; fileName: string; message: string; problems: string[] }
  | { step: "preview"; preview: RestorePreview };

/** The first, one-line summary of what a restore brought back. */
export function restoredSummary(result: RestoreResult): string {
  const count = (table: string, one: string, many: string) => {
    const n = result.counts[table] ?? 0;
    return `${n} ${n === 1 ? one : many}`;
  };
  return `Restored ${count("todos", "todo", "todos")}, ${count("notes", "note", "notes")} and ${count("people", "person", "people")}.`;
}

export function RestoreSection() {
  const [state, setState] = useState<State>({ step: "idle" });
  const [confirming, setConfirming] = useState(false);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const hash = useRouterState({ select: (s) => s.location.hash });

  // The palette's "Restore from export" lands here.
  useEffect(() => {
    if (hash === "restore") input.current?.focus();
  }, [hash]);

  const check = async (file: File) => {
    if (file.size > MAX_RESTORE_BYTES) {
      setState({
        step: "problems",
        fileName: file.name,
        message: "Export files can be up to 1 GB.",
        problems: [],
      });
      return;
    }
    setState({ step: "checking", fileName: file.name });
    try {
      setState({ step: "preview", preview: await uploadRestore(file, file.name) });
    } catch (error) {
      const details = error instanceof ApiError ? RestoreProblemDetails.safeParse(error.details) : null;
      setState({
        step: "problems",
        fileName: file.name,
        message: errorMessage(error),
        problems: details?.success ? details.data.problems : [],
      });
    }
  };

  const reset = () => {
    setState({ step: "idle" });
    if (input.current) input.current.value = "";
  };

  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) void check(file);
  };

  return (
    <section className={styles.section} id="restore" aria-labelledby="restore-heading">
      <h2 className={styles.heading} id="restore-heading">
        Restore
      </h2>
      <p className={styles.text}>
        Replace all data with an export zip, for example after moving to a new machine. The file is checked
        first and nothing changes until you confirm. API tokens and this browser's session stay.
      </p>

      {(state.step === "idle" || state.step === "problems") && (
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- drop target of the file input it labels; the input works by keyboard
        <label
          className={styles.drop}
          data-dragging={dragging || undefined}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <input
            ref={input}
            type="file"
            accept=".zip,application/zip"
            className="visually-hidden"
            aria-label="Export zip to restore"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void check(file);
            }}
          />
          <span className={styles.dropTitle}>Choose an export zip</span>
          <span className={styles.dropNote}>or drop it here</span>
        </label>
      )}

      {state.step === "checking" && (
        <div className={styles.checking} role="status">
          <Loading label="Checking the file" />
          <span>Checking the file {state.fileName}...</span>
        </div>
      )}

      {state.step === "problems" && (
        <div className={styles.problems} role="alert">
          <p className={styles.problemTitle}>
            {state.fileName} cannot be restored. {state.message}
          </p>
          {state.problems.length > 0 && (
            <ul className={styles.problemList}>
              {state.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}
          <p className={styles.note}>Nothing was changed.</p>
        </div>
      )}

      {state.step === "preview" && (
        <Preview
          preview={state.preview}
          onReplace={() => setConfirming(true)}
          onCancel={() => {
            void cancelRestore(state.preview.uploadId).catch(() => undefined);
            reset();
          }}
        />
      )}

      {state.step === "preview" && (
        <ConfirmDialog open={confirming} onOpenChange={setConfirming} preview={state.preview} />
      )}

      <Backups />
    </section>
  );
}

function Preview({
  preview,
  onReplace,
  onCancel,
}: {
  preview: RestorePreview;
  onReplace: () => void;
  onCancel: () => void;
}) {
  return (
    <div className={styles.preview} aria-label="Restore preview" role="group">
      <dl className={styles.previewMeta}>
        <div>
          <dt>File</dt>
          <dd>{preview.fileName}</dd>
        </div>
        <div>
          <dt>Exported</dt>
          <dd>
            <time dateTime={preview.exportedAt}>{absoluteTime(preview.exportedAt)}</time>,{" "}
            {relativeTime(preview.exportedAt)}
          </dd>
        </div>
        <div>
          <dt>From</dt>
          <dd>
            organizer {preview.appVersion}, export format {preview.format}
          </dd>
        </div>
      </dl>
      <table className={styles.compare}>
        <thead>
          <tr>
            <th scope="col">Data</th>
            <th scope="col">In the file</th>
            <th scope="col">Now</th>
          </tr>
        </thead>
        <tbody>
          {RESTORE_TABLES.map(([table, name]) => (
            <tr key={table}>
              <th scope="row">{name}</th>
              <td>{preview.inFile[table] ?? 0}</td>
              <td>{preview.now[table] ?? 0}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {preview.attachments.count > 0 && (
        <p className={styles.note}>
          {preview.attachments.count} {preview.attachments.count === 1 ? "file" : "files"},{" "}
          {formatBytes(preview.attachments.bytes)}.
        </p>
      )}
      {preview.warnings.length > 0 && (
        <ul className={styles.warnings} aria-label="Warnings">
          {preview.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
      <div className={styles.previewActions}>
        <Button variant="danger" onClick={onReplace}>
          Replace all data
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function ConfirmDialog({
  open,
  onOpenChange,
  preview,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preview: RestorePreview;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Replace all data?"
      description="This replaces all todos, notes, people and files with the ones from the file. A safety copy of your current data is saved first."
      width={480}
    >
      {open && <ConfirmForm preview={preview} onCancel={() => onOpenChange(false)} />}
    </Dialog>
  );
}

function ConfirmForm({ preview, onCancel }: { preview: RestorePreview; onCancel: () => void }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = typed.trim().toLowerCase() === "replace";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setPending(true);
    setError(null);
    try {
      const result = await applyRestore(preview.uploadId);
      // Every cached answer belongs to the old data.
      client.clear();
      void navigate({ to: "/" });
      toast.show({
        message: `${restoredSummary(result)} Safety copy: ${result.safetyCopy.fileName}`,
        durationMs: 15_000,
      });
    } catch (failure) {
      const details = failure instanceof ApiError ? RestoreProblemDetails.safeParse(failure.details) : null;
      setError([errorMessage(failure), ...(details?.success ? details.data.problems : [])].join(" "));
      setPending(false);
    }
  };

  return (
    <form className={styles.confirm} onSubmit={submit}>
      <Field label='Type "replace" to confirm'>
        {/* oxlint-disable-next-line jsx-a11y/no-autofocus -- the dialog opens to type the word */}
        <TextInput value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus autoComplete="off" />
      </Field>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {pending && <p className={styles.note}>Saving a safety copy and replacing the data...</p>}
      <div className={styles.confirmActions}>
        <Button onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" variant="danger" disabled={!ready || pending}>
          Replace all data
        </Button>
      </div>
    </form>
  );
}

function Backups() {
  const backups = useBackups();
  const list = backups.data ?? [];
  if (list.length === 0) return null;
  return (
    <div className={styles.block}>
      <h3 className={styles.subheading}>Safety copies</h3>
      <p className={styles.note}>Saved before each restore. The newest 5 are kept.</p>
      <ul className={styles.files} aria-label="Safety copies">
        {list.map((file) => (
          <li key={file.fileName} className={styles.file}>
            <a
              className={styles.fileName}
              href={`${API_PREFIX}/restore/backups/${encodeURIComponent(file.fileName)}`}
              download={file.fileName}
            >
              {file.fileName}
            </a>
            <span className={styles.fileMeta}>
              <time dateTime={file.createdAt}>{absoluteTime(file.createdAt)}</time>,{" "}
              {relativeTime(file.createdAt)}
            </span>
            <span className={styles.fileSize}>{formatBytes(file.bytes)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
