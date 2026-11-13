import type { AccountBrief, Label, Me, Person, PersonBrief, Todo } from "@organizer/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { vi } from "vitest";
import { ToastProvider } from "../components/toast/ToastProvider.tsx";
import { KeyboardProvider } from "../keyboard/KeyboardProvider.tsx";

/** Renders UI inside the app's providers and a memory router (todo links resolve to a stub page). */
export function renderWithApp(ui: ReactNode) {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        {ui}
        <Outlet />
      </>
    ),
  });
  const routeTree = rootRoute.addChildren([
    createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => null }),
    createRoute({ getParentRoute: () => rootRoute, path: "/todos/$id", component: () => <p>todo page</p> }),
  ]);
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ["/"] }) });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    router,
    client,
    ...render(
      <QueryClientProvider client={client}>
        <KeyboardProvider>
          <ToastProvider>
            <RouterProvider router={router} />
          </ToastProvider>
        </KeyboardProvider>
      </QueryClientProvider>,
    ),
  };
}

const T = "2026-11-01T09:00:00.000Z";

export const TEST_ACCOUNT: AccountBrief = {
  id: 1,
  username: "anna",
  displayName: "Anna Private",
  color: "#2EC5CE",
  role: "user",
};

/** GET /me of the test account: the browser session with write access unless overridden. */
export function makeMe(overrides: Partial<Me> = {}): Me {
  return { actor: "you", via: "session", scope: "write", account: TEST_ACCOUNT, ...overrides };
}

export function makeLabel(name: string, overrides: Partial<Label> = {}): Label {
  const index = name.lastIndexOf("::");
  return {
    id: Math.abs([...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)) + 1,
    name,
    scope: index === -1 ? null : name.slice(0, index),
    value: index === -1 ? name : name.slice(index + 2),
    color: "#FFB224",
    description: "",
    rank: null,
    createdAt: T,
    updatedAt: T,
    ...overrides,
  };
}

export function makePerson(
  firstName: string,
  lastName: string,
  id = 1,
  overrides: Partial<Person> = {},
): Person {
  return {
    id,
    firstName,
    lastName,
    note: "",
    displayName: `${firstName} ${lastName}`,
    team: "",
    email: "",
    notesMd: "",
    topics: [],
    tags: [],
    counts: { requested: 0, requestedOpen: 0, requestedDone: 0, contact: 0, contactOpen: 0 },
    createdAt: T,
    updatedAt: T,
    ...overrides,
  };
}

/** The short person form inside todos. */
export function makeBrief(firstName: string, lastName: string, id = 1, overrides: Partial<PersonBrief> = {}) {
  return {
    id,
    firstName,
    lastName,
    displayName: `${firstName} ${lastName}`,
    note: "",
    team: "",
    email: "",
    ...overrides,
  } satisfies PersonBrief;
}

export function makeTodo(overrides: Partial<Todo> = {}): Todo {
  return {
    id: 1,
    projectId: null,
    parentId: null,
    title: "Renew SSL certs",
    descriptionMd: "",
    status: "open",
    dueOn: null,
    plannedOn: null,
    position: 0,
    createdAt: T,
    updatedAt: T,
    doneAt: null,
    lastActivityAt: T,
    durationMs: null,
    labels: [],
    requestedBy: [],
    contacts: [],
    commentCount: 0,
    project: null,
    parent: null,
    progress: { subtasks: { total: 0, done: 0 }, checklist: { total: 0, done: 0 } },
    links: { blocks: [], blockedBy: [], relatesTo: [] },
    recurrence: null,
    previousOccurrenceId: null,
    nextOccurrence: null,
    ...overrides,
  };
}

export interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

/** Replaces fetch with a handler; returns the calls made, in order. */
export function mockApi(handler: (call: RecordedCall) => { status?: number; body?: unknown }) {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(async (input, init) => {
      const call = {
        method: init?.method ?? "GET",
        path: input,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const { status = 200, body } = handler(call);
      return new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}

/**
 * Types the texts into a field one after the other, `gapMs` apart, then waits out `pauseMs`, all on a
 * fake clock. Real sleeps between keys stretch past the typing pause on a busy machine, and the page
 * then rightly asks the server for a half-typed word. The real clock is back when this returns.
 */
export async function typeOnFakeClock(field: HTMLElement, texts: string[], gapMs: number, pauseMs: number) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    for (const value of texts) {
      fireEvent.change(field, { target: { value } });
      // oxlint-disable-next-line no-await-in-loop -- typing, one key after the other
      await act(() => vi.advanceTimersByTimeAsync(gapMs));
    }
    await act(() => vi.advanceTimersByTimeAsync(pauseMs));
  } finally {
    vi.useRealTimers();
  }
}
