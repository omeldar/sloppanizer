import { Link } from "@tanstack/react-router";
import { useKeyMode } from "../keyboard/KeyboardProvider.tsx";
import { relativeTime } from "../lib/format.ts";
import { useStats } from "../lib/queries.ts";
import pkg from "../../package.json" with { type: "json" };
import styles from "./Layout.module.css";

const EXPORT_STALE_MS = 7 * 24 * 3_600_000;

/** Segments like vim or tmux: mode, overdue, open, planned today, last export, version. */
export function StatusBar() {
  const { mode, pending } = useKeyMode();
  const stats = useStats();
  const s = stats.data;
  const exportAt = s?.lastExportAt ?? null;
  const exportStale =
    s !== undefined && (exportAt === null || Date.now() - Date.parse(exportAt) > EXPORT_STALE_MS);

  return (
    <footer className={styles.statusbar} aria-label="Status">
      <span className={styles.segMode} data-mode={mode}>
        {mode}
        {pending && <span className={styles.pending}>{pending}</span>}
      </span>
      {stats.isError ? (
        <span className={styles.seg} data-tone="red">
          server not reachable
        </span>
      ) : (
        <>
          <span className={styles.seg} data-tone={s && s.overdue > 0 ? "red" : undefined}>
            <b>{s?.overdue ?? "-"}</b> overdue
          </span>
          <span className={styles.seg}>
            <b>{s?.open ?? "-"}</b> open
          </span>
          <span className={styles.seg}>
            <b>{s?.plannedToday ?? "-"}</b> planned today
          </span>
        </>
      )}
      <span className={styles.spacer} />
      <Link
        to="/settings"
        className={styles.seg}
        data-tone={exportStale ? "amber" : undefined}
        title="Export settings"
      >
        {exportAt ? `exported ${relativeTime(exportAt)}` : "never exported"}
      </Link>
      <span className={styles.seg}>v{pkg.version}</span>
    </footer>
  );
}
