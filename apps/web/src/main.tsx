// oxlint-disable-next-line import/no-unassigned-import -- global styles and fonts
import "./styles/index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CommandsProvider } from "./app/commands.tsx";
import { makeRouter } from "./app/router.tsx";
import { ToastProvider } from "./components/toast/ToastProvider.tsx";
import { KeyboardProvider } from "./keyboard/KeyboardProvider.tsx";
import { ApiError } from "./lib/api.ts";
import { applyTheme, initialTheme } from "./lib/theme.ts";

applyTheme(initialTheme());

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
const router = makeRouter();

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <KeyboardProvider>
          <ToastProvider>
            <CommandsProvider>
              <RouterProvider router={router} />
            </CommandsProvider>
          </ToastProvider>
        </KeyboardProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}
