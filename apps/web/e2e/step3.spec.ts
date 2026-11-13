import { mkdirSync, readFileSync } from "node:fs";
import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Page,
  request,
  test,
} from "@playwright/test";
import { strFromU8, unzipSync } from "fflate";
import { API, focusPage as focusIn, getJson, localDate, toast as toastIn } from "./support.ts";

// Step 3 flows in one browser session: subtasks and checklists, links and Next up, a weekly repeat with
// undo, API tokens, people statistics, the label rename conflict, writing the export to the folder and
// a restore from an export zip. Everything it creates is deleted again in afterAll, so it can also run
// against a real instance (E2E_BASE_URL); the restore step only runs on the throwaway e2e server, since
// it replaces all data. E2E_SCREENS_DIR set: screenshots of every new page in both themes go there.

// The steps drive one browser page, so they run one after the other on purpose.
/* oxlint-disable no-await-in-loop */

test.describe.configure({ mode: "serial" });

const stamp = Date.now().toString(36);
const word = `zr${stamp}`;
const realInstance = Boolean(process.env.E2E_BASE_URL);

let context: BrowserContext;
let page: Page;
let api: APIRequestContext;
let baseURL = "";
let projectId = 0;
const made = { todos: [] as number[], people: [] as number[], labels: [] as number[] };
let parentTodo = 0;

/** Console errors and page errors, with the URL they came from. */
const problems: Array<{ text: string; url: string }> = [];

// The two answers a user can cause on purpose here: the label rename conflict and a checklist click on an
// old text. Chromium logs both as failed loads; nothing else may show up.
const EXPECTED_409 = [/\/api\/v1\/labels\/\d+$/, /\/api\/v1\/todos\/\d+\/checklist$/];
const isExpected = (p: { text: string; url: string }) =>
  p.text.includes("status of 409") && EXPECTED_409.some((pattern) => pattern.test(new URL(p.url).pathname));

interface TodoJson {
  id: number;
  status: string;
  dueOn: string | null;
  labels: Array<{ name: string }>;
  progress: { subtasks: { total: number; done: number }; checklist: { total: number; done: number } };
  recurrence: unknown;
  nextOccurrence: { id: number } | null;
}

const focusPage = () => focusIn(page);
const toast = (text: string | RegExp) => toastIn(page, text);
const getTodo = (id: number) => getJson<TodoJson>(api, `/todos/${id}`);

async function createTodo(title: string, extra: Record<string, unknown> = {}): Promise<number> {
  const res = await api.post(`${API}/todos`, { data: { title, projectId, ...extra } });
  expect(res.status(), await res.text()).toBe(201);
  const { id } = (await res.json()) as { id: number };
  made.todos.push(id);
  return id;
}

async function createPerson(firstName: string, lastName: string, topics: string[] = []): Promise<number> {
  const res = await api.post(`${API}/people`, { data: { firstName, lastName, topics } });
  expect(res.status(), await res.text()).toBe(201);
  const { id } = (await res.json()) as { id: number };
  made.people.push(id);
  return id;
}

async function createLabel(name: string): Promise<number> {
  const res = await api.post(`${API}/labels`, { data: { name } });
  expect(res.status(), await res.text()).toBe(201);
  const { id } = (await res.json()) as { id: number };
  made.labels.push(id);
  return id;
}

/** data.json without the one value every export changes: settings.lastExportAt. */
function comparable(data: Record<string, unknown>): Record<string, unknown> {
  const settings = (data.settings as Array<{ key: string }>).filter((row) => row.key !== "lastExportAt");
  return { ...data, settings };
}

/** data.json of an export downloaded from the Settings page. */
async function downloadExport(): Promise<{ path: string; data: Record<string, unknown> }> {
  await page.goto("/settings");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download export" }).click(),
  ]);
  const path = await download.path();
  const files = unzipSync(readFileSync(path));
  return { path, data: JSON.parse(strFromU8(files["data.json"] as Uint8Array)) as Record<string, unknown> };
}

test.beforeAll(async ({ browser }, info) => {
  baseURL = String(info.project.use.baseURL);
  context = await browser.newContext();
  page = await context.newPage();
  api = context.request;
  page.on("console", (m) => {
    if (m.type() === "error") problems.push({ text: m.text(), url: m.location().url });
  });
  page.on("pageerror", (e) => problems.push({ text: String(e), url: page.url() }));
  // Loading the app sets the session cookie that the API calls below share.
  await page.goto("/");
  const created = await api.post(`${API}/projects`, { data: { name: `E2E step 3 ${stamp}` } });
  expect(created.status()).toBe(201);
  projectId = ((await created.json()) as { id: number }).id;
});

test.afterAll(async () => {
  // Children first would not matter (deleting a parent detaches them), but keep the order simple.
  for (const id of made.todos.toReversed())
    expect([204, 404]).toContain((await api.delete(`${API}/todos/${id}`)).status());
  for (const id of made.people)
    expect([204, 404]).toContain((await api.delete(`${API}/people/${id}`)).status());
  for (const id of made.labels)
    expect([204, 404]).toContain((await api.delete(`${API}/labels/${id}`)).status());
  if (projectId) expect([204, 404]).toContain((await api.delete(`${API}/projects/${projectId}`)).status());
  await context.close();
});

test("subtasks: add two, tick one off; a checklist click is saved and a stale one is refused", async () => {
  parentTodo = await createTodo(`Rack ${word}`, {
    descriptionMd: "Shopping:\n\n- [ ] Order cables\n- [ ] Order rails\n",
  });
  await page.goto(`/todos/${parentTodo}`);
  const subtasks = page.getByRole("region", { name: "Subtasks" });
  const input = subtasks.getByRole("textbox", { name: "Add subtask" });
  await input.fill("Mount rails");
  await input.press("Enter");
  await expect(subtasks.getByRole("list", { name: "Subtasks in order" }).getByRole("listitem")).toHaveCount(
    1,
  );
  await input.fill("Patch cables");
  await input.press("Enter");
  const rows = subtasks.getByRole("list", { name: "Subtasks in order" }).getByRole("listitem");
  await expect(rows).toHaveCount(2);
  await expect(subtasks).toContainText("0 of 2 done");

  const children = await getJson<{ items: Array<{ id: number; title: string }> }>(api, "/todos", {
    parentId: String(parentTodo),
    sort: "position",
    order: "asc",
  });
  expect(children.items.map((c) => c.title)).toEqual(["Mount rails", "Patch cables"]);
  made.todos.push(...children.items.map((c) => c.id));
  const first = children.items[0]?.id ?? 0;

  await subtasks.getByRole("checkbox", { name: `Mark #${first} done` }).click();
  await expect(subtasks).toContainText("1 of 2 done");
  await expect.poll(async () => (await getTodo(parentTodo)).progress.subtasks).toEqual({ total: 2, done: 1 });

  const description = page.getByRole("region", { name: "Description" });
  await description.getByRole("checkbox", { name: "Order cables" }).click();
  await expect(description).toContainText("Checklist 1 of 2");
  await page.reload();
  await expect(description.getByRole("checkbox", { name: "Order cables" })).toBeChecked();
  await expect(description.getByRole("checkbox", { name: "Order rails" })).not.toBeChecked();
  await expect(description).toContainText("Checklist 1 of 2");
  expect((await getTodo(parentTodo)).progress.checklist).toEqual({ total: 2, done: 1 });

  // Someone else edits the list meanwhile. The page keeps showing what it loaded before (the app may
  // refetch at any time, so pin the old answer to make the timing certain): the click on the old text is
  // refused and nothing changes.
  const seen = await getTodo(parentTodo);
  await page.route(`**${API}/todos/${parentTodo}`, (route) =>
    route.request().method() === "GET" ? route.fulfill({ json: seen }) : route.continue(),
  );
  const edit = await api.patch(`${API}/todos/${parentTodo}`, {
    data: { descriptionMd: "Shopping:\n\n- [x] Order cables\n- [ ] Order screws\n- [ ] Order rails\n" },
  });
  expect(edit.status()).toBe(200);
  await description.getByRole("checkbox", { name: "Order rails" }).click();
  // Error toasts are alerts.
  await expect(
    page.getByRole("alert").filter({ hasText: "The checklist changed. Try again." }),
  ).toBeVisible();
  await page.unroute(`**${API}/todos/${parentTodo}`);
  await page.reload();
  await expect(description.getByRole("checkbox", { name: "Order screws" })).toBeVisible();
  await expect(description.getByRole("checkbox", { name: "Order rails" })).not.toBeChecked();
  expect((await getTodo(parentTodo)).progress.checklist).toEqual({ total: 3, done: 1 });
});

test("a link: B blocks A, Next up shows A waiting on B, B done puts A back in the ranking", async () => {
  const a = await createTodo(`Install server ${word}`);
  const b = await createTodo(`Buy rack ${word}`);
  await page.goto(`/todos/${a}`);
  await page
    .getByRole("region", { name: "Links" })
    .getByRole("button", { name: /^Add link/ })
    .click();
  const dialog = page.getByRole("dialog", { name: `Link #${a} to another todo` });
  await expect(dialog.getByRole("radio", { name: /Blocked by/ })).toBeChecked();
  await dialog.getByPlaceholder("#id or words from the title").fill(`#${b}`);
  await dialog.getByRole("option", { name: new RegExp(`#${b}`) }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("note")).toContainText(`Waiting on #${b} Buy rack ${word}`);

  await page.goto("/");
  const ranked = page.getByRole("list", { name: "Ranked todos" });
  const blocked = page.getByRole("region", { name: "Blocked" });
  await expect(blocked.getByRole("listitem").filter({ hasText: `Install server ${word}` })).toContainText(
    `waiting on #${b}`,
  );
  await expect(ranked.getByRole("listitem").filter({ hasText: `Install server ${word}` })).toHaveCount(0);
  const blocker = ranked.getByRole("listitem").filter({ hasText: `Buy rack ${word}` });
  await expect(blocker).toContainText("blocks 1");

  await blocker.getByRole("checkbox", { name: `Mark #${b} done` }).click();
  await expect(ranked.getByRole("listitem").filter({ hasText: `Install server ${word}` })).toHaveCount(1);
  await expect(page.getByRole("region", { name: "Blocked" }).filter({ hasText: word })).toHaveCount(0);
});

test("a weekly repeat due today: done creates the next one due in 7 days, undo removes it", async () => {
  const id = await createTodo(`Water plants ${word}`, { dueOn: localDate(0) });
  await page.goto(`/todos/${id}`);
  await page.getByRole("button", { name: "Repeat" }).click();
  await page
    .getByRole("group", { name: "Repeat" })
    .getByRole("button", { name: /^Every week on / })
    .click();
  await expect.poll(async () => (await getTodo(id)).recurrence).not.toBeNull();
  await expect(page.getByRole("button", { name: "Repeat" })).toContainText(/^every week on /);

  await focusPage();
  await page.getByRole("button", { name: /^Mark done/ }).click();
  const done = toast(new RegExp(`^Marked #${id} done\\. Next one: #\\d+`));
  await expect(done).toBeVisible();
  const nextId = (await getTodo(id)).nextOccurrence?.id ?? 0;
  expect(nextId).toBeGreaterThan(id);
  made.todos.push(nextId);
  expect((await getTodo(nextId)).dueOn).toBe(localDate(7));

  await done.getByRole("button", { name: "Undo" }).click();
  await expect.poll(async () => (await getTodo(id)).status).toBe("open");
  await expect.poll(async () => (await api.get(`${API}/todos/${nextId}`)).status()).toBe(404);
});

test("API tokens: a read token is shown once, reads, cannot write, and stops after revoke", async () => {
  const name = `e2e read ${stamp}`;
  await page.goto("/settings/tokens");
  await page.getByRole("button", { name: /^New token/ }).click();
  const dialog = page.getByRole("dialog", { name: "New token" });
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByRole("radio", { name: /^Read/ }).check();
  await dialog.getByRole("button", { name: "Create token" }).click();
  const created = page.getByRole("region", { name: `New token ${name}` });
  const raw = ((await created.locator("code").textContent()) ?? "").trim();
  expect(raw).toMatch(/^org_[0-9A-Za-z]{40}$/);

  const program = await request.newContext({ baseURL, extraHTTPHeaders: { authorization: `Bearer ${raw}` } });
  try {
    expect((await program.get(`${API}/todos`)).status()).toBe(200);
    const write = await program.patch(`${API}/todos/${parentTodo}`, { data: { title: "nope" } });
    expect(write.status()).toBe(403);
    // Token management stays with the browser session.
    expect((await program.get(`${API}/tokens`)).status()).toBe(403);

    await created.getByRole("button", { name: "Done" }).click();
    await expect(created).toBeHidden();
    await page.reload();
    await expect(page.getByRole("list", { name: "Active tokens" })).toContainText(name);
    expect(await page.content()).not.toContain(raw);

    const row = page
      .getByRole("list", { name: "Active tokens" })
      .getByRole("listitem")
      .filter({ hasText: name });
    await row.getByRole("button", { name: "Revoke" }).click();
    await page
      .getByRole("dialog", { name: `Revoke ${name}?` })
      .getByRole("button", { name: "Revoke" })
      .click();
    // Revoked tokens move to a collapsed group.
    await expect(page.getByRole("list", { name: "Active tokens" }).filter({ hasText: name })).toHaveCount(0);
    expect((await program.get(`${API}/todos`)).status()).toBe(401);
  } finally {
    await program.dispose();
  }
});

test("people statistics with a topic filter list only the people with that topic", async () => {
  const topic = `${word} stats`;
  const anna = await createPerson("Anna", `Stat${stamp}`, [topic]);
  await createPerson("Otto", `Other${stamp}`);
  const asked = await createTodo(`Asked by Anna ${word}`, { requestedBy: [{ personId: anna }] });
  await createTodo(`Asked by Otto ${word}`, {
    requestedBy: [{ firstName: "Otto", lastName: `Other${stamp}` }],
  });
  expect((await api.patch(`${API}/todos/${asked}`, { data: { status: "done" } })).status()).toBe(200);

  await page.goto("/people/stats?period=all");
  const table = page.getByRole("table");
  await expect(table).toContainText(`Otto Other${stamp}`);
  const input = page.getByPlaceholder("Only people with these topics");
  await input.fill(topic);
  await page.getByRole("option", { name: topic }).click();
  await expect(page).toHaveURL(/topic=/);
  await expect(table).not.toContainText(`Otto Other${stamp}`);
  const row = table.getByRole("row").filter({ hasText: `Anna Stat${stamp}` });
  await expect(row).toHaveCount(1);
  await expect(row.getByRole("img", { name: "0 open, 1 done" })).toBeVisible();
});

test("renaming a label into a scope another label of the todo has shows the conflict, keep replaces", async () => {
  const plain = `${word}-waiting`;
  const scope = `${word}st`;
  const id = await createLabel(plain);
  await createLabel(`${scope}::open`);
  const todo = await createTodo(`Label clash ${word}`, { labels: [plain, `${scope}::open`] });

  await page.goto("/labels");
  await page.getByRole("listitem").filter({ hasText: plain }).getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog", { name: `Edit ${plain}` });
  await dialog.getByLabel("Name").fill(`${scope}::waiting`);
  await dialog.getByRole("button", { name: "Save label" }).click();
  const conflict = dialog.getByRole("region", { name: "Scope conflict" });
  await expect(conflict).toContainText("Nothing changed yet.");
  await expect(conflict.getByRole("list", { name: "Affected todos" })).toContainText(`#${todo}`);
  expect((await getTodo(todo)).labels.map((l) => l.name).toSorted()).toEqual(
    [plain, `${scope}::open`].toSorted(),
  );

  await conflict.getByRole("button", { name: "Keep the renamed label on them" }).click();
  await expect(dialog).toBeHidden();
  await expect
    .poll(async () => (await getTodo(todo)).labels.map((l) => l.name))
    .toEqual([`${scope}::waiting`]);
  const labels = await getJson<Array<{ id: number; name: string }>>(api, "/labels");
  expect(labels.find((l) => l.id === id)?.name).toBe(`${scope}::waiting`);
});

test("write to folder adds a zip to the export folder list", async () => {
  await page.goto("/settings");
  const block = page.getByRole("group", { name: "Export folder" });
  const before = (await getJson<unknown[]>(api, "/export/folder")).length;
  await block.getByRole("button", { name: "Write to folder" }).click();
  await expect
    .poll(async () => (await getJson<unknown[]>(api, "/export/folder")).length)
    .toBe(Math.min(before + 1, 4));
  await expect(
    block.getByRole("list", { name: "Zips in the export folder" }).getByRole("listitem"),
  ).toHaveCount(Math.min(before + 1, 4));
  await expect(block.getByRole("textbox", { name: "Export folder" })).toHaveValue(/\/exports$/);
});

test("restore: an export zip brings the data back after a typed confirm, with a safety copy", async () => {
  test.skip(realInstance, "A restore replaces all data; it only runs on the throwaway e2e server.");
  const kept = await createTodo(`Kept by restore ${word}`);
  const first = await downloadExport();

  // Change the data after the export: one todo deleted, one added.
  expect((await api.delete(`${API}/todos/${kept}`)).status()).toBe(204);
  const extra = await createTodo(`Gone after restore ${word}`);

  await page.goto("/settings#restore");
  await page.getByLabel("Export zip to restore").setInputFiles(first.path);
  const preview = page.getByRole("group", { name: "Restore preview" });
  await expect(preview).toContainText("export format 3");
  await preview.getByRole("button", { name: "Replace all data" }).click();
  const confirm = page.getByRole("dialog", { name: "Replace all data?" });
  const replace = confirm.getByRole("button", { name: "Replace all data" });
  await expect(replace).toBeDisabled();
  await confirm.getByLabel('Type "replace" to confirm').fill("replace");
  await replace.click();
  await expect(toast(/Safety copy: /)).toBeVisible();

  expect((await api.get(`${API}/todos/${kept}`)).status()).toBe(200);
  expect((await api.get(`${API}/todos/${extra}`)).status()).toBe(404);
  await page.goto("/settings");
  await expect(page.getByRole("list", { name: "Safety copies" }).getByRole("listitem")).not.toHaveCount(0);

  // A new export holds the same data; only the time of the last export differs.
  const second = await downloadExport();
  expect(comparable(second.data)).toEqual(comparable(first.data));
});

test("every new page renders in dark and light", async () => {
  const dir = process.env.E2E_SCREENS_DIR;
  if (dir) mkdirSync(dir, { recursive: true });
  const pages: Array<[string, string]> = [
    ["todo-subtasks", `/todos/${parentTodo}`],
    ["tokens", "/settings/tokens"],
    ["settings-step3", "/settings"],
    ["people-stats", "/people/stats?period=all"],
    ["labels-step3", "/labels"],
  ];
  for (const theme of ["dark", "light"] as const) {
    await page.evaluate((t) => localStorage.setItem("organizer.theme", t), theme);
    for (const [name, path] of pages) {
      await page.goto(path);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
      await page.waitForLoadState("networkidle");
      if (dir) await page.screenshot({ path: `${dir}/${name}-${theme}.png`, fullPage: true });
    }
  }
  await page.evaluate(() => localStorage.setItem("organizer.theme", "dark"));
});

test("no console errors on the way, except the two conflicts the steps cause on purpose", () => {
  expect(problems.filter((p) => !isExpected(p))).toEqual([]);
  expect(problems.filter(isExpected)).toHaveLength(2);
});
