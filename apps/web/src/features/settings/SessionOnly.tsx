import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { EmptyState, Loading, PageHeader } from "../../components/ui.tsx";
import { useMe } from "../../lib/queries.ts";

/** True when the caller signed in through the browser session (tokens cannot use session-only pages). */
export function useIsSession(): boolean {
  return useMe().data?.via === "session";
}

/**
 * Pages only the browser session can use (tokens, restore). Anyone else gets the normal "not found" view,
 * so they do not learn the page exists; the server refuses these routes for tokens anyway.
 */
export function SessionOnly({ children }: { children: ReactNode }) {
  const me = useMe();
  if (me.isPending) return <Loading />;
  if (me.data?.via === "session") return children;
  return (
    <>
      <PageHeader title="Page not found" />
      <EmptyState>
        This address does not exist. <Link to="/">Go to Next up</Link> or press ctrl+k to search.
      </EmptyState>
    </>
  );
}
