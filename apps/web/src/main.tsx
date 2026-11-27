// oxlint-disable-next-line import/no-unassigned-import -- global styles and fonts
import "./styles/index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { AccountProvider } from "./app/account.tsx";
import { CommandsProvider } from "./app/commands.tsx";
import { ReauthProvider } from "./app/ReauthDialog.tsx";
import { makeRouter } from "./app/router.tsx";
import { ToastProvider } from "./components/toast/ToastProvider.tsx";
import { AuthApp } from "./features/auth/AuthApp.tsx";
import { KeyboardProvider } from "./keyboard/KeyboardProvider.tsx";
import { readAccounts, setLastUsed } from "./lib/accounts.ts";
import { ApiError, setSpace } from "./lib/api.ts";
import { loginFor, resolveEntry } from "./lib/entry.ts";
import { FormatPrefsProvider } from "./lib/formatPrefs.tsx";
import { startTabSession } from "./lib/session.ts";
import { applyTheme, initialTheme } from "./lib/theme.ts";

applyTheme(initialTheme());

const entry = resolveEntry(location.pathname, location.search, readAccounts());
const root = document.getElementById("root");
// Leaving the page: a full load, so the next account starts with a clean cache and memory.
const go = (to: string) => location.assign(to);

if (entry.kind === "redirect") {
  location.replace(entry.to);
} else if (root && entry.kind === "auth") {
  createRoot(root).render(
    <StrictMode>
      <AuthApp page={entry.page} search={new URLSearchParams(location.search)} go={go} />
    </StrictMode>,
  );
} else if (root && entry.kind === "draw") {
  // The phone's drawing page: no account, loaded on its own.
  const PhoneDrawPage = lazy(() => import("./features/drawings/PhoneDrawPage.tsx"));
  // A new code scanned into the same tab: start over with it.
  window.addEventListener("hashchange", () => location.reload());
  createRoot(root).render(
    <StrictMode>
      <Suspense fallback={null}>
        <PhoneDrawPage hash={location.hash} />
      </Suspense>
    </StrictMode>,
  );
} else if (root && entry.kind === "app") {
  const { account } = entry;
  setLastUsed(account.username);
  setSpace(entry.spaceId);
  startTabSession(account, () =>
    location.replace(loginFor(account.username, location.pathname + location.search)),
  );
  // One query cache per page load and account: nothing of another account can show here.
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        // Client errors (404, 422) will not get better by asking again.
        retry: (count, error) =>
          count < 2 && !(error instanceof ApiError && error.status >= 400 && error.status < 500),
      },
    },
  });
  const router = makeRouter(entry.basepath);
  createRoot(root).render(
    <StrictMode>
      <AccountProvider account={account}>
        <QueryClientProvider client={queryClient}>
          <KeyboardProvider>
            <ToastProvider>
              <ReauthProvider>
                <CommandsProvider>
                  <FormatPrefsProvider accountId={account.accountId}>
                    <RouterProvider router={router} />
                  </FormatPrefsProvider>
                </CommandsProvider>
              </ReauthProvider>
            </ToastProvider>
          </KeyboardProvider>
        </QueryClientProvider>
      </AccountProvider>
    </StrictMode>,
  );
}
