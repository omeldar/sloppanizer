import type { Attachment, DrawHandoff } from "@organizer/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Dialog, DialogActions, DialogBody } from "../../components/Dialog.tsx";
import type { Upload } from "../../components/markdown/uploads.ts";
import { Button } from "../../components/ui.tsx";
import { errorMessage } from "../../lib/api.ts";
import { attachmentBlob } from "../../lib/attachmentCache.ts";
import { uploadAttachment } from "../../lib/attachments.ts";
import { formatTime } from "../../lib/format.ts";
import { QrCode } from "../auth/parts.tsx";
import { endHandoff, handoffStatus, phoneLink, recentDrawings, startHandoff } from "./api.ts";
import { BlobImage } from "./BlobImage.tsx";
import { DrawingBoard } from "./DrawingBoard.tsx";
import styles from "./Drawings.module.css";
import { pageFromPng, pagePng } from "./files.ts";
import { useDrawing } from "./history.ts";
import { drawingFileName, isBlank, newPage, two } from "./model.ts";

export interface DrawDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Edits this stored drawing (its attachment URL) instead of making a new one. */
  editing?: string;
  /** Stores the PNG (default: the attachments API). */
  upload?: Upload;
  /** The drawing is stored: link this attachment. */
  onDone: (file: { url: string }) => void;
  /** How often the phone hand-off asks whether the drawing arrived. */
  pollMs?: number;
}

type Mode = "here" | "phone";

/** A new page that suits the screen: landscape on computers, portrait on a phone held upright. */
const pageForScreen = () =>
  newPage(typeof window !== "undefined" && window.innerWidth < window.innerHeight ? 1 / 1.4 : 1.6);

/**
 * Draw: a canvas to draw on here, or a QR code to draw on a phone. The finished drawing is stored as a
 * PNG attachment (with its strokes inside, so it can be edited or copied later) and linked where the
 * cursor was. With `editing`, the stored drawing opens to change it; saving makes a new file.
 */
export default function DrawDialog({
  open,
  onOpenChange,
  editing,
  upload = uploadAttachment,
  onDone,
  pollMs = 1500,
}: DrawDialogProps) {
  const drawing = useDrawing(pageForScreen());
  const [mode, setMode] = useState<Mode>("here");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(editing !== undefined);
  const [askDiscard, setAskDiscard] = useState(false);
  const [received, setReceived] = useState<Attachment | null>(null);
  const { reset } = drawing;

  useEffect(() => {
    if (!editing) return;
    let alive = true;
    const loadDrawing = async () => {
      try {
        const page = await pageFromPng(await attachmentBlob(editing));
        if (alive) reset(page);
      } catch (failure) {
        if (alive) setError(`Could not open the drawing. ${errorMessage(failure)}`);
      }
      if (alive) setLoading(false);
    };
    void loadDrawing();
    return () => {
      alive = false;
    };
  }, [editing, reset]);

  const dirty = (drawing.changed && !isBlank(drawing.page)) || received !== null;
  const close = () => {
    setAskDiscard(false);
    onOpenChange(false);
  };
  const requestClose = (next: boolean) => {
    if (next) return onOpenChange(true);
    if (dirty && !busy) setAskDiscard(true);
    else close();
  };

  const insert = async () => {
    if (mode === "phone") {
      if (!received) return;
      onDone({ url: received.url });
      return close();
    }
    setBusy(true);
    setError(null);
    try {
      const png = await pagePng(drawing.page);
      const stored = await upload(new File([png], drawingFileName(), { type: "image/png" }));
      onDone({ url: stored.url });
      close();
    } catch (failure) {
      setError(`Could not store the drawing. ${errorMessage(failure)}`);
    } finally {
      setBusy(false);
    }
  };

  const copyFrom = async (file: Attachment) => {
    setError(null);
    try {
      drawing.load(await pageFromPng(await attachmentBlob(file.url)));
      setMode("here");
    } catch (failure) {
      setError(`Could not open that drawing. ${errorMessage(failure)}`);
    }
  };

  const canInsert =
    mode === "phone"
      ? received !== null
      : !loading && !isBlank(drawing.page) && (!editing || drawing.changed);

  return (
    <Dialog
      open={open}
      onOpenChange={requestClose}
      title={editing ? "Edit drawing" : "New drawing"}
      width={900}
    >
      <DialogBody>
        {!editing && (
          <div className={styles.modes} role="group" aria-label="Where to draw">
            <button type="button" aria-pressed={mode === "here"} onClick={() => setMode("here")}>
              Draw here
            </button>
            <button type="button" aria-pressed={mode === "phone"} onClick={() => setMode("phone")}>
              Draw on your phone
            </button>
          </div>
        )}
        {mode === "here" ? (
          loading ? (
            <p className={styles.note}>Opening the drawing</p>
          ) : (
            <DrawingBoard drawing={drawing} />
          )
        ) : (
          <PhoneHandoff pollMs={pollMs} received={received} onReceived={setReceived} />
        )}
        {!editing && mode === "here" && <RecentDrawings onPick={(file) => void copyFrom(file)} />}
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        {askDiscard ? (
          <div className={styles.discard} role="alert">
            <span>Discard this drawing?</span>
            <Button onClick={() => setAskDiscard(false)}>Keep drawing</Button>
            <Button variant="danger" onClick={close}>
              Discard
            </Button>
          </div>
        ) : (
          <DialogActions>
            <Button onClick={() => requestClose(false)}>Cancel</Button>
            <Button variant="primary" disabled={!canInsert || busy} onClick={() => void insert()}>
              {busy ? "Saving" : editing ? "Save drawing" : "Insert"}
            </Button>
          </DialogActions>
        )}
      </DialogBody>
    </Dialog>
  );
}

/** Up to 12 recent drawings to start from a copy (the copy is a new file; the old one stays). */
function RecentDrawings({ onPick }: { onPick: (file: Attachment) => void }) {
  // Asked again at every open: the last drawing may have been made a moment ago.
  const recent = useQuery({ queryKey: ["drawings", "recent"], queryFn: recentDrawings, staleTime: 0 });
  const items = recent.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <section className={styles.recent} aria-label="Recent drawings">
      <h3 className={styles.recentTitle}>Start from a copy</h3>
      <ul className={styles.recentList}>
        {items.map((file) => (
          <li key={file.id}>
            <button
              type="button"
              className={styles.recentItem}
              onClick={() => onPick(file)}
              aria-label={`Copy ${file.name}`}
            >
              <BlobImage src={file.url} alt="" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|.+\.localhost)$/;

/** "10:42" in the user's time format. */
const clock = (instant: string) => {
  const at = new Date(instant);
  return formatTime(`${two(at.getHours())}:${two(at.getMinutes())}`);
};

/**
 * The QR code for the phone and the wait for its drawing. The link is ended when the dialog closes, so
 * a code someone photographed stops working too.
 */
function PhoneHandoff({
  pollMs,
  received,
  onReceived,
}: {
  pollMs: number;
  received: Attachment | null;
  onReceived: (file: Attachment) => void;
}) {
  const [handoff, setHandoff] = useState<{ id: number; token: string; expiresAt: string } | null>(null);
  const [status, setStatus] = useState<DrawHandoff["status"] | "starting" | "failed">("starting");
  const [problem, setProblem] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const latest = useRef(onReceived);
  useEffect(() => {
    latest.current = onReceived;
  });

  useEffect(() => {
    if (received) return;
    let alive = true;
    let id: number | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const poll = async () => {
      if (!alive || id === null) return;
      try {
        const state = await handoffStatus(id);
        if (!alive) return;
        setStatus(state.status);
        if (state.status === "received" && state.attachment) {
          done = true;
          latest.current(state.attachment);
          return;
        }
        if (state.status === "expired") return;
      } catch (failure) {
        if (!alive) return;
        setStatus("expired");
        setProblem(errorMessage(failure));
        return;
      }
      timer = setTimeout(() => void poll(), pollMs);
    };
    setStatus("starting");
    setProblem(null);
    const start = async () => {
      try {
        const created = await startHandoff();
        if (!alive) {
          await endHandoff(created.id).catch(() => undefined);
          return;
        }
        id = created.id;
        setHandoff(created);
        setStatus("waiting");
        timer = setTimeout(() => void poll(), pollMs);
      } catch (failure) {
        if (!alive) return;
        setStatus("failed");
        setProblem(errorMessage(failure));
      }
    };
    void start();
    return () => {
      alive = false;
      clearTimeout(timer);
      if (id !== null && !done) void endHandoff(id).catch(() => undefined);
    };
    // A new round (New code) starts a new link; `received` only stops the polling.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [round, pollMs]);

  if (received) {
    return (
      <div className={styles.phone}>
        <div className={styles.receivedImage}>
          <BlobImage src={received.url} alt="The drawing from your phone" />
        </div>
        <p className={styles.note}>Your drawing arrived. Insert it, or close to leave it out.</p>
      </div>
    );
  }
  if (status === "failed") {
    return (
      <div className={styles.phone}>
        <p className={styles.error} role="alert">
          Could not make a code for your phone. {problem}
        </p>
        <Button onClick={() => setRound((r) => r + 1)}>Try again</Button>
      </div>
    );
  }
  if (status === "expired") {
    return (
      <div className={styles.phone}>
        <p className={styles.note}>The code expired. {problem}</p>
        <Button onClick={() => setRound((r) => r + 1)}>New code</Button>
      </div>
    );
  }
  if (!handoff) return <p className={styles.note}>Making a code for your phone</p>;
  const link = phoneLink(handoff.token);
  return (
    <div className={styles.phone}>
      <div className={styles.qr}>
        <QrCode text={link} label="QR code to draw on your phone" />
      </div>
      <div className={styles.phoneText}>
        <p>Scan the code with your phone or tablet camera, draw, and tap Send. No sign-in needed.</p>
        <p className={styles.note} aria-live="polite">
          Waiting for your phone. The code works once, until {clock(handoff.expiresAt)}.
        </p>
        {LOCAL_HOST.test(location.hostname) && (
          <p className={styles.note}>
            This address only works on this computer, so a phone cannot open it. Use the app at its public
            address to draw on your phone.
          </p>
        )}
      </div>
    </div>
  );
}
