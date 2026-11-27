import { DRAW_TOKEN } from "@organizer/shared";
import { useEffect, useState } from "react";
import { Button } from "../../components/ui.tsx";
import { ApiError, errorMessage } from "../../lib/api.ts";
import { checkPhoneLink, sendFromPhone } from "./api.ts";
import { DrawingBoard } from "./DrawingBoard.tsx";
import styles from "./Drawings.module.css";
import { pagePng } from "./files.ts";
import { useDrawing } from "./history.ts";
import { isBlank, newPage } from "./model.ts";

type State =
  | { kind: "checking" }
  | { kind: "ready" }
  | { kind: "sending" }
  | { kind: "sent" }
  | { kind: "gone"; message: string };

/** The token from the address's fragment (`/draw#<token>`): fragments never reach a server or its logs. */
export const tokenFromHash = (hash: string): string | null => {
  const token = hash.replace(/^#/, "");
  return DRAW_TOKEN.test(token) ? token : null;
};

const NO_LINK = "This page needs the code from the computer. Scan it again with your camera.";

/**
 * The phone's side of "Draw on your phone": opened from the QR code without signing in. The whole screen
 * is the canvas; Send stores the drawing on the computer's side, once.
 */
export default function PhoneDrawPage({ hash }: { hash: string }) {
  const token = tokenFromHash(hash);
  // The page takes the screen's shape (less the bars), portrait or landscape.
  const drawing = useDrawing(newPage(window.innerWidth / Math.max(1, window.innerHeight - 120)));
  const [state, setState] = useState<State>(
    token ? { kind: "checking" } : { kind: "gone", message: NO_LINK },
  );

  useEffect(() => {
    document.title = "Draw: Sloppanizer";
    if (!token) return;
    let alive = true;
    checkPhoneLink(token).then(
      () => alive && setState({ kind: "ready" }),
      (error: unknown) => alive && setState({ kind: "gone", message: errorMessage(error) }),
    );
    return () => {
      alive = false;
    };
  }, [token]);

  const [failure, setFailure] = useState<string | null>(null);

  const send = async () => {
    if (!token) return;
    setFailure(null);
    setState({ kind: "sending" });
    try {
      await sendFromPhone(token, await pagePng(drawing.page));
      setState({ kind: "sent" });
    } catch (error) {
      // Used or expired meanwhile: nothing more to do here. Anything else: the drawing stays, try again.
      if (error instanceof ApiError && error.status === 404) {
        setState({ kind: "gone", message: errorMessage(error) });
      } else {
        setState({ kind: "ready" });
        setFailure(errorMessage(error));
      }
    }
  };

  if (state.kind === "sent") {
    return (
      <main className={styles.phonePage} data-centered>
        <h1 className={styles.phoneTitle}>Sent</h1>
        <p>Your drawing is on the computer now. Insert it there. You can close this page.</p>
      </main>
    );
  }
  if (state.kind === "gone") {
    return (
      <main className={styles.phonePage} data-centered>
        <h1 className={styles.phoneTitle}>This link does not work</h1>
        <p role="alert">{state.message}</p>
      </main>
    );
  }
  return (
    <main className={styles.phonePage}>
      <DrawingBoard drawing={drawing} fullScreen label="Draw here" />
      <div className={styles.phoneBar}>
        {failure && (
          <span className={styles.error} role="alert">
            Could not send. {failure}
          </span>
        )}
        <Button
          variant="primary"
          disabled={state.kind !== "ready" || isBlank(drawing.page)}
          onClick={() => void send()}
        >
          {state.kind === "sending" ? "Sending" : "Send"}
        </Button>
      </div>
    </main>
  );
}
