import { mkdirSync, readFileSync } from "node:fs";
import { type APIRequestContext, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { strFromU8, unzipSync } from "fflate";
import { API, focusPage as focusIn, localDate, toast as toastIn, watchProblems } from "./support.ts";

// The step 1 core flow in one browser session: quick add, Next up, detail edit, done with undo, theme,
// palette, export. Everything it creates is deleted again in afterAll, so it can also run against a
// real instance (E2E_BASE_URL). E2E_SCREENS_DIR set: screenshots of every page in both themes go there.

// The steps drive one browser page, so they run one after the other on purpose.
/* oxlint-disable no-await-in-loop */

test.describe.configure({ mode: "serial" });

const stamp = Date.now().toString(36);
const title = `Review the release notes ${stamp}`;
const projectName = `E2E project ${stamp}`;

let context: BrowserContext;
let page: Page;
let api: APIRequestContext;
const problems: string[] = [];
let todoId = 0;
let projectSlug = "";
let projectId = 0;
// A real instance may already know Anna Meier; then the test links to her and never deletes her.
let personExisted = false;

async function findPeople(): Promise<Array<{ id: number; firstName: string; lastName: string }>> {
  const res = await api.get(`${API}/people`, { params: { q: "Anna Meier" } });
  expect(res.status()).toBe(200);
  const people = (await res.json()) as Array<{ id: number; firstName: string; lastName: string }>;
  return people.filter((p) => p.firstName.toLowerCase() === "anna" && p.lastName.toLowerCase() === "meier");
}

const focusPage = () => focusIn(page);

const statusBar = () => page.locator("footer[aria-label=Status]");
const toast = (text: string) => toastIn(page, text);
const ranked = () => page.getByRole("list", { name: "Ranked todos" });

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
  api = context.request;
  watchProblems(page, problems);
  // Loading the app sets the session cookie that the API calls below share.
  await page.goto("/");
  personExisted = (await findPeople()).length > 0;
  const created = await api.post(`${API}/projects`, { data: { name: projectName } });
  expect(created.status()).toBe(201);
  const project = (await created.json()) as { id: number; slug: string };
  projectId = project.id;
  projectSlug = project.slug;
});

test.afterAll(async () => {
  if (todoId) expect([204, 404]).toContain((await api.delete(`${API}/todos/${todoId}`)).status());
  if (!personExisted) {
    for (const person of await findPeople()) {
      expect((await api.delete(`${API}/people/${person.id}`)).status()).toBe(204);
    }
  }
  if (projectId) expect((await api.delete(`${API}/projects/${projectId}`)).status()).toBe(204);
  await context.close();
});

test("Next up loads", async () => {
  await page.goto("/");
  await expect(page.getByRole("group", { name: "Ranking" })).toBeVisible();
  await expect(statusBar()).toContainText("normal");
});

test("quick add with a priority token, a requester and a due date", async () => {
  await focusPage();
  await page.keyboard.press("c");
  await expect(statusBar()).toContainText("insert");
  await page.getByRole("textbox", { name: "Title" }).fill(`${title} ~priority::high`);
  await page.getByRole("button", { name: "Nobody" }).click();
  await page.keyboard.type("Anna Meier");
  const option = personExisted
    ? page.getByRole("option", { name: /Anna Meier/ }).first()
    : page.getByRole("option", { name: "Add Anna Meier as a new person" });
  await option.click();
  await page.keyboard.press("Escape");
  await page.getByLabel("Due date", { exact: true }).fill(localDate(2));
  await page.getByRole("textbox", { name: "Title" }).press("Enter");

  const added = toast("Added #");
  await expect(added).toBeVisible();
  todoId = Number(/#(\d+)/.exec((await added.textContent()) ?? "")?.[1]);
  expect(todoId).toBeGreaterThan(0);

  const res = await api.get(`${API}/todos/${todoId}`);
  const todo = (await res.json()) as {
    title: string;
    labels: Array<{ name: string }>;
    requestedBy: Array<{ displayName: string }>;
    dueOn: string;
  };
  expect(todo.title).toBe(title);
  expect(todo.labels.map((l) => l.name)).toEqual(["priority::high"]);
  expect(todo.requestedBy.map((p) => p.displayName)).toEqual(["Anna Meier"]);
  expect(todo.dueOn).toBe(localDate(2));
});

test("the new todo shows on Next up with reason chips", async () => {
  const strip = ranked()
    .getByRole("listitem")
    .filter({ hasText: `#${todoId}` });
  await expect(strip).toContainText(title);
  await expect(strip).toContainText("from Anna Meier");
  await expect(strip.getByTitle("priority::high")).toBeVisible();
  await expect(strip.locator("[data-kind=due_soon]")).toHaveText("due in 2d");
});

test("the detail page saves a description with a link", async () => {
  await ranked().getByRole("link", { name: title }).click();
  await expect(page).toHaveURL(new RegExp(`/todos/${todoId}$`));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);

  await page.getByRole("textbox", { name: "Description" }).click();
  await page.keyboard.type("Read [the changelog](https://example.com/changelog) before the release.");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 5000 });

  // After a reload the saved description opens as the sanitized preview.
  await page.reload();
  const link = page.getByRole("region", { name: "Description" }).getByRole("link", { name: "the changelog" });
  await expect(link).toHaveAttribute("href", "https://example.com/changelog");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", /noreferrer/);
});

test("mark done from the list, undo, mark done again, the done row shows took", async () => {
  await page.goto("/");
  const strip = () =>
    ranked()
      .getByRole("listitem")
      .filter({ hasText: `#${todoId}` });
  await strip()
    .getByRole("checkbox", { name: `Mark #${todoId} done` })
    .check();
  await expect(toast(`Marked #${todoId} done`)).toBeVisible();
  await expect(strip()).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(strip()).toHaveCount(1);
  expect(((await (await api.get(`${API}/todos/${todoId}`)).json()) as { status: string }).status).toBe(
    "open",
  );

  await strip()
    .getByRole("checkbox", { name: `Mark #${todoId} done` })
    .check();
  await expect(strip()).toHaveCount(0);
  await expect
    .poll(async () => ((await (await api.get(`${API}/todos/${todoId}`)).json()) as { status: string }).status)
    .toBe("done");

  await page.goto("/inbox");
  await page.getByRole("button", { name: "Show recently done" }).click();
  const doneRow = page
    .getByRole("list", { name: "Recently done" })
    .getByRole("listitem")
    .filter({
      hasText: `#${todoId}`,
    });
  await expect(doneRow).toContainText(/took \d+m/);
});

test("the theme switch sticks after a reload", async () => {
  await page.goto("/settings");
  await page.getByText("Light", { exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByText("Dark", { exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("ctrl+k finds the todo by #id", async () => {
  await page.goto("/");
  await focusPage();
  await page.keyboard.press("Control+k");
  await page.keyboard.type(`#${todoId}`);
  await expect(page.getByRole("option", { name: new RegExp(`#${todoId}`) })).toContainText(title);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/todos/${todoId}$`));
});

test("the export zip downloads and its data.json holds the todo", async () => {
  await page.goto("/settings");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download export" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^organizer-export-\d{8}-\d{6}\.zip$/);
  const files = unzipSync(readFileSync(await download.path()));
  const manifest = JSON.parse(strFromU8(files["manifest.json"]!)) as { app: string; format: number };
  expect(manifest).toMatchObject({ app: "organizer", format: 3 });

  const data = JSON.parse(strFromU8(files["data.json"]!)) as Record<string, Array<Record<string, unknown>>>;
  const todo = data.todos?.find((row) => row.id === todoId);
  expect(todo).toMatchObject({ title, status: "done" });
  expect(data.todo_people?.some((row) => Object.values(row).includes(todoId))).toBe(true);
  expect(Object.keys(files).some((name) => name.startsWith("todos/") && name.endsWith(".md"))).toBe(true);
});

test("every page renders in dark and light", async () => {
  const dir = process.env.E2E_SCREENS_DIR;
  if (dir) mkdirSync(dir, { recursive: true });
  // Open again, so Next up and the lists show a strip instead of their empty state.
  const reopened = await api.patch(`${API}/todos/${todoId}`, { data: { status: "open", projectId } });
  expect(reopened.status()).toBe(200);
  const pages: Array<[string, string, ((p: Page) => Promise<void>)?]> = [
    ["next", "/"],
    ["inbox", "/inbox"],
    ["project", `/projects/${projectSlug}`],
    ["todo", `/todos/${todoId}`],
    ["labels", "/labels"],
    ["people", "/people"],
    ["settings", "/settings"],
    ["palette", "/", async (p) => p.keyboard.press("Control+k")],
    ["quickadd", "/inbox", async (p) => p.keyboard.press("c")],
    ["help", "/", async (p) => p.keyboard.press("?")],
  ];
  for (const theme of ["dark", "light"] as const) {
    await page.evaluate((t) => localStorage.setItem("organizer.theme", t), theme);
    for (const [name, path, act] of pages) {
      await page.goto(path);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await page.waitForLoadState("networkidle");
      if (act) {
        await focusPage();
        await act(page);
        await expect(page.getByRole("dialog")).toBeVisible();
      }
      if (dir) await page.screenshot({ path: `${dir}/${name}-${theme}.png` });
    }
  }
  await page.evaluate(() => localStorage.setItem("organizer.theme", "dark"));
});

test("no console errors on the way", () => {
  expect(problems).toEqual([]);
});
