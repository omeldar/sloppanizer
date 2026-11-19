import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import {
  fetchServerVersion,
  setServerVersion,
  setVersionCheck,
  useVersionGap,
} from "../lib/serverVersion.ts";
import styles from "./Layout.module.css";

/** While the versions differ the check runs every minute, otherwise now and then and on returning to the tab. */
const DIFFER_MS = 60_000;
const SAME_MS = 15 * 60_000;

/**
 * A small line under the top bar (never over the tab bar): "updating" while the server is still on the
 * previous release, "a new version is ready" when this page is older than the server. It goes away by
 * itself once the versions match; failed views then load again.
 */
export function UpdateBanner() {
  const gap = useVersionGap();
  const client = useQueryClient();
  const differ = gap === "server-older" || gap === "web-older";
  const health = useQuery({
    queryKey: ["serverVersion"],
    queryFn: fetchServerVersion,
    refetchInterval: differ ? DIFFER_MS : SAME_MS,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
    retry: false,
  });
  const { refetch } = health;

  useEffect(() => {
    if (health.data) setServerVersion(health.data);
  }, [health.data]);

  useEffect(() => {
    setVersionCheck(() => void refetch());
    return () => setVersionCheck(null);
  }, [refetch]);

  // Once the server caught up, what failed during the update loads again.
  const was = useRef(gap);
  useEffect(() => {
    if (was.current === "server-older" && gap !== "server-older") {
      void client.invalidateQueries({ predicate: (query) => query.state.status === "error" });
    }
    was.current = gap;
  }, [gap, client]);

  if (gap === "server-older") {
    return (
      <div className={styles.banner} role="status" data-tone="amber">
        <span>
          <span className={styles.bannerDot} aria-hidden="true" />
          Sloppanizer is updating. Some things may not work for a few minutes.
        </span>
      </div>
    );
  }
  if (gap === "web-older") {
    return (
      <div className={styles.banner} role="status">
        <span>A new version of Sloppanizer is ready.</span>
        <button type="button" className={styles.bannerAction} onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
  return null;
}
