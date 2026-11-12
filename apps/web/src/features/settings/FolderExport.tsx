import { useToast } from "../../components/toast/ToastProvider.tsx";
import { Button, ErrorState } from "../../components/ui.tsx";
import { errorMessage } from "../../lib/api.ts";
import { absoluteTime, formatBytes, relativeTime } from "../../lib/format.ts";
import { useFolderExports, useSettings, useWriteFolderExport } from "../../lib/queries.ts";
import styles from "./Settings.module.css";

/** "Write to folder": a zip in the fixed export folder inside WSL; the folder keeps the newest few. */
export function FolderExportBlock() {
  const settings = useSettings();
  const zips = useFolderExports();
  const write = useWriteFolderExport();
  const toast = useToast();

  const run = async () => {
    try {
      const written = await write.mutateAsync();
      toast.show({ message: `Wrote ${written.fileName} (${formatBytes(written.bytes)})` });
    } catch (error) {
      toast.show({ tone: "error", message: `Could not write the export. ${errorMessage(error)}` });
    }
  };

  const copyPath = (path: string) =>
    void navigator.clipboard
      .writeText(path)
      .then(() => toast.show({ message: "Copied the folder path" }))
      .catch(() =>
        toast.show({ tone: "error", message: "Could not copy. Select the path and copy it by hand." }),
      );

  if (settings.isError) return <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />;
  const data = settings.data;
  const list = zips.data ?? [];

  return (
    <div className={styles.block} aria-label="Export folder" role="group">
      <div className={styles.exportRow}>
        <Button onClick={() => void run()} disabled={write.isPending}>
          {write.isPending ? "Writing..." : "Write to folder"}
        </Button>
        {data && (
          <span className={styles.note}>
            Saves the zip in the folder below and keeps the newest {data.folderExportKeep}.
          </span>
        )}
      </div>
      {data && (
        <div className={styles.pathRow}>
          <span className={styles.pathLabel}>Folder</span>
          <input
            className={styles.path}
            value={data.exportDir}
            readOnly
            aria-label="Export folder"
            onFocus={(e) => e.currentTarget.select()}
          />
          <Button size="sm" variant="ghost" onClick={() => copyPath(data.exportDir)}>
            Copy
          </Button>
        </div>
      )}
      {zips.isError && <ErrorState error={zips.error} onRetry={() => void zips.refetch()} />}
      {zips.data &&
        (list.length === 0 ? (
          <p className={styles.note}>No zips in the folder yet.</p>
        ) : (
          <ul className={styles.files} aria-label="Zips in the export folder">
            {list.map((zip) => (
              <li key={zip.fileName} className={styles.file}>
                <span className={styles.fileName}>{zip.fileName}</span>
                <span className={styles.fileMeta}>
                  <time dateTime={zip.at}>{absoluteTime(zip.at)}</time>, {relativeTime(zip.at)}
                </span>
                <span className={styles.fileSize}>{formatBytes(zip.bytes)}</span>
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}
