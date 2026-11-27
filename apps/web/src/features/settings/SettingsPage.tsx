import { Link } from "@tanstack/react-router";
import { PageHeader } from "../../components/ui.tsx";
import { Button } from "../../components/ui.tsx";
import { useDownloadExport } from "../../components/useDownload.ts";
import type { ProjectView } from "@organizer/shared";
import { useProjectView, useUpdateProfile } from "../../lib/accountQueries.ts";
import { absoluteTime, formatBytes, relativeTime } from "../../lib/format.ts";
import { useMe, useSettings, useStats } from "../../lib/queries.ts";
import { setTheme, type Theme, useTheme } from "../../lib/theme.ts";
import { AiAssistantSection } from "./AiAssistant.tsx";
import { CalendarFeedSection } from "./CalendarFeed.tsx";
import { RestoreSection } from "./Restore.tsx";
import listStyles from "../lists/Lists.module.css";
import styles from "./Settings.module.css";

const THEMES: { value: Theme; name: string; note: string }[] = [
  { value: "dark", name: "Dark", note: "Graphite, for long sessions" },
  { value: "light", name: "Light", note: "Cool daylight grey" },
];

export function SettingsPage() {
  const theme = useTheme();
  const stats = useStats();
  const me = useMe();
  const downloadExport = useDownloadExport();
  const lastExport = stats.data?.lastExportAt ?? null;
  const session = me.data?.via === "session";

  return (
    <div className={styles.page}>
      <PageHeader title="Settings" />

      <section className={styles.section}>
        <h2 className={styles.heading}>Theme</h2>
        <p className={styles.text}>Saved in this browser. The first start follows the system setting.</p>
        <div className={styles.themes} role="radiogroup" aria-label="Theme">
          {THEMES.map((option) => (
            <label key={option.value} className={styles.theme} data-on={theme === option.value || undefined}>
              <input
                type="radio"
                name="theme"
                value={option.value}
                checked={theme === option.value}
                onChange={() => setTheme(option.value)}
                className="visually-hidden"
              />
              <span className={styles.swatches} data-theme-preview={option.value} aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              <span className={styles.themeName}>{option.name}</span>
              <span className={styles.themeNote}>{option.note}</span>
            </label>
          ))}
        </div>
      </section>

      {session && <ProjectViewSection />}

      <section className={styles.section}>
        <h2 className={styles.heading}>Export</h2>
        <p className={styles.text}>
          A zip with every todo, project, label and person: data.json to restore from, plus one Markdown file
          per todo. Keep a copy on another drive.
        </p>
        <div className={styles.exportRow}>
          <Button variant="primary" onClick={downloadExport}>
            Download export
          </Button>
          <span className={styles.lastExport} data-stale={!lastExport || undefined}>
            {lastExport
              ? `Last export ${absoluteTime(lastExport)}, ${relativeTime(lastExport)}`
              : "Not exported yet"}
          </span>
        </div>
      </section>

      {session && <FilesSection />}

      {session && <RestoreSection />}

      {session && <AiAssistantSection />}

      {session && <CalendarFeedSection />}

      {session && (
        <section className={styles.section}>
          <h2 className={styles.heading}>API tokens</h2>
          <p className={styles.text}>
            Programs like the MCP server sign in with a token.{" "}
            <Link to="/settings/tokens">Manage API tokens</Link>
          </p>
        </section>
      )}

      {me.data && (
        <section className={styles.section}>
          <h2 className={styles.heading}>Session</h2>
          <p className={styles.text}>
            Signed in as <span className={styles.mono}>{me.data.actor}</span> through the browser session,
            with {me.data.scope} access.
          </p>
        </section>
      )}
    </div>
  );
}

const PROJECT_VIEW_NAMES: Record<ProjectView, string> = { list: "List", board: "Board" };

/** How project pages open (S5#3): saved to the account, so every device and shared project follows it. */
function ProjectViewSection() {
  const { view, pending } = useProjectView();
  const update = useUpdateProfile();
  const shown = update.isPending && update.variables.projectView ? update.variables.projectView : view;
  return (
    <section className={styles.section} aria-labelledby="project-view-heading">
      <h2 className={styles.heading} id="project-view-heading">
        Projects
      </h2>
      <p className={styles.text}>
        Open projects as a list or as a board. Saved to your account, on every device. The List and Board
        switch on a project still changes it for that visit.
      </p>
      <div className={listStyles.modes} role="group" aria-label="Open projects as">
        {(["list", "board"] as const).map((option) => (
          <button
            key={option}
            type="button"
            className={listStyles.mode}
            aria-pressed={shown === option}
            disabled={pending || update.isPending}
            onClick={() => option !== view && update.mutate({ projectView: option })}
          >
            {PROJECT_VIEW_NAMES[option]}
          </button>
        ))}
      </div>
      {update.isError && (
        <p className={styles.error} role="alert">
          {update.error.message}
        </p>
      )}
    </section>
  );
}

/** Attachments of this account against its limit; the admin can raise it. */
function FilesSection() {
  const settings = useSettings();
  const data = settings.data;
  return (
    <section className={styles.section} aria-labelledby="files-heading">
      <h2 className={styles.heading} id="files-heading">
        Files
      </h2>
      <p className={styles.text}>
        {data
          ? `Pasted images and attached files use ${formatBytes(data.filesBytes)} of this account's ${formatBytes(data.filesLimitBytes)}.`
          : "Pasted images and attached files count against this account's limit."}
      </p>
    </section>
  );
}
