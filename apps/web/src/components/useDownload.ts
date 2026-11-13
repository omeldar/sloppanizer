import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { errorMessage } from "../lib/api.ts";
import { downloadFile } from "../lib/download.ts";
import { downloadExport } from "../lib/export.ts";
import { useToast } from "./toast/ToastProvider.tsx";

/** Downloads through fetch (with the tab's token); a failure shows as a toast. */
export function useDownload() {
  const toast = useToast();
  return useCallback(
    (path: string, fallbackName: string) => {
      downloadFile(path, fallbackName).catch((error: unknown) =>
        toast.show({ tone: "error", message: `Could not download ${fallbackName}. ${errorMessage(error)}` }),
      );
    },
    [toast],
  );
}

/** The export zip download, for buttons and the palette. */
export function useDownloadExport() {
  const toast = useToast();
  const client = useQueryClient();
  return useCallback(() => {
    downloadExport(client).catch((error: unknown) =>
      toast.show({ tone: "error", message: `Could not download the export. ${errorMessage(error)}` }),
    );
  }, [client, toast]);
}
