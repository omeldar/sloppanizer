import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { vi } from "vitest";
import { CommandsProvider } from "../app/commands.tsx";
import { routeTree } from "../app/router.tsx";
import { ToastProvider } from "../components/toast/ToastProvider.tsx";
import { KeyboardProvider } from "../keyboard/KeyboardProvider.tsx";
import { mockApi, type RecordedCall } from "./render.tsx";

/**
 * Renders the real app routes at `path` with a fake API (unstub globals after each test). Kept apart from
 * render.tsx, so tests of single components do not load every page.
 */
export function renderAppAt(
  path: string,
  handler: (call: RecordedCall) => { status?: number; body?: unknown },
) {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const calls = mockApi(handler);
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <KeyboardProvider>
        <ToastProvider>
          <CommandsProvider>
            <RouterProvider router={router} />
          </CommandsProvider>
        </ToastProvider>
      </KeyboardProvider>
    </QueryClientProvider>,
  );
  return { router, client, calls };
}
