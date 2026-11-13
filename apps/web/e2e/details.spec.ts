import { type APIRequestContext, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { API, focusPage as focusIn, getJson, watchProblems } from "./support.ts";

// Details found in the final browser check, each in the real browser: the topic filter takes the
// matching topic on Enter, the person page lists keep status and date apart, the people dialogs are
// padded, several attached files show one per line, a refused restore file says why once and in view,
// the board cursor is an amber ring in both themes, "m" right after opening a todo still works, and the
// last name can be edited on its own. Everything it creates is deleted again in afterAll, so it can also
// run against a real instance (E2E_BASE_URL); the restore step only checks a bad file, nothing changes.

// The steps drive one browser page, so they run one after the other on purpose.
/* oxlint-disable no-await-in-loop */

test.describe.configure({ mode: "serial" });

const stamp = Date.now().toString(36);
const word = `zd${stamp}`;
const topic = `${word} Firewall rules`;

let context: BrowserContext;
let page: Page;
let api: APIRequestContext;
let projectId = 0;
let projectSlug = "";
const made = { todos: [] as number[], notes: [] as number[], people: [] as number[] };
const problems: string[] = [];

const focusPage = () => focusIn(page);

async function create<T extends { id: number }>(path: string, data: Record<string, unknown>): Promise<T> {
  const res = await api.post(`${API}${path}`, { data });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as T;
}

async function createTodo(title: string, extra: Record<string, unknown> = {}): Promise<number> {
  const { id } = await create("/todos", { title, projectId, ...extra });
  made.todos.push(id);
  return id;
}

async function createPerson(firstName: string, lastName: string, topics: string[] = []): Promise<number> {
  const { id } = await create("/people", { firstName, lastName, topics });
  made.people.push(id);
  return id;
}

async function setTheme(theme: "dark" | "light"): Promise<void> {
  await page.evaluate((t) => localStorage.setItem("organizer.theme", t), theme);
  await page.reload();
}

/** How far each edge of `inner` sits inside `outer`, in pixels. */
async function insets(outer: ReturnType<Page["locator"]>, inner: ReturnType<Page["locator"]>) {
  const a = await outer.boundingBox();
  const b = await inner.boundingBox();
  if (!a || !b) throw new Error("insets: not visible");
  return {
    left: b.x - a.x,
    right: a.x + a.width - (b.x + b.width),
    bottom: a.y + a.height - (b.y + b.height),
  };
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
  api = context.request;
  watchProblems(page, problems);
  // Loading the app sets the session cookie that the API calls below share.
  await page.goto("/");
  const project = await create<{ id: number; slug: string }>("/projects", { name: `E2E details ${stamp}` });
  projectId = project.id;
  projectSlug = project.slug;
});

test.afterAll(async () => {
  for (const id of made.todos)
    expect([204, 404]).toContain((await api.delete(`${API}/todos/${id}`)).status());
  for (const id of made.notes)
    expect([204, 404]).toContain((await api.delete(`${API}/notes/${id}`)).status());
  for (const id of made.people)
    expect([204, 404]).toContain((await api.delete(`${API}/people/${id}`)).status());
  if (projectId) expect((await api.delete(`${API}/projects/${projectId}`)).status()).toBe(204);
  await page.evaluate(() => localStorage.removeItem("organizer.theme"));
  await context.close();
});

test("the people topic filter takes the matching topic on Enter and says when nothing matches", async () => {
  await createPerson("Luca", `Brunner${stamp}`, [topic]);
  await page.goto("/people");
  const input = page.getByRole("combobox", { name: "Add a topic" });
  // Part of the name, in another case: Enter takes the highlighted suggestion, not the typed text.
  await input.fill(`${word} firewall`);
  await expect(page.getByRole("option", { name: topic })).toHaveAttribute("aria-selected", "true");
  await input.press("Enter");
  await expect(page).toHaveURL(
    new RegExp(`topic=${encodeURIComponent(topic).replaceAll("%20", "(%20|\\+)")}`),
  );
  await expect(page.getByRole("list", { name: "People" })).toContainText(`Luca Brunner${stamp}`);

  await input.fill(`${word}nothing`);
  await expect(page.getByRole("status").filter({ hasText: "No topic matches" })).toHaveText(
    `No topic matches "${word}nothing". Check the spelling, or search by name above.`,
  );
  await input.press("Enter");
  await expect(input).toHaveValue(`${word}nothing`);
  await expect(page.getByRole("list", { name: "People" })).toContainText(`Luca Brunner${stamp}`);

  // The palette and the search page find them by part of the topic too.
  await focusPage();
  await page.keyboard.press("Control+k");
  await page.keyboard.type(`${word} firew`);
  await expect(page.getByRole("option", { name: new RegExp(`Luca Brunner${stamp}`) })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.goto(`/search?q=${encodeURIComponent(`${word} wall rul`)}`);
  await expect(page.getByRole("main")).toContainText(`Luca Brunner${stamp}`);
});

test("person page: the status In progress keeps clear of the date, the last name is edited on its own", async () => {
  const id = await createPerson("Dana", `Ärzte${stamp}`);
  await createTodo(`Renew certs ${word}`, { status: "in_progress", requestedBy: [{ personId: id }] });
  await page.goto(`/people/${id}`);
  const row = page.getByRole("region", { name: "Requested" }).getByRole("listitem").first();
  const status = row.getByText("In progress", { exact: true });
  await expect(status).toBeVisible();
  const date = status.locator("xpath=following-sibling::span[1]");
  const [s, d] = [await status.boundingBox(), await date.boundingBox()];
  expect(s && d && s.x + s.width <= d.x).toBe(true);
  // Nothing clipped inside the status cell either.
  expect(await status.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

  await focusPage();
  await page.keyboard.press("e");
  await expect(page.getByText("Last name", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Last name" }).fill(`Ärztin${stamp}`);
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Dana Ärztin${stamp}`);
  const saved = await getJson<{ firstName: string; lastName: string }>(api, `/people/${id}`);
  expect(saved).toMatchObject({ firstName: "Dana", lastName: `Ärztin${stamp}` });
});

test("the New person and Delete person dialogs keep their content off the border", async () => {
  await page.goto("/people");
  await page.getByRole("button", { name: "New person" }).click();
  const dialog = page.getByRole("dialog", { name: "New person" });
  for (const part of [
    dialog.getByRole("textbox", { name: "First name" }),
    dialog.getByRole("button", { name: "Add person" }),
  ]) {
    const gap = await insets(dialog, part);
    expect(Math.min(gap.left, gap.right)).toBeGreaterThanOrEqual(12);
  }
  expect(
    (await insets(dialog, dialog.getByRole("button", { name: "Add person" }))).bottom,
  ).toBeGreaterThanOrEqual(12);
  await page.keyboard.press("Escape");

  const id = await createPerson("Linked", `Person${stamp}`);
  await createTodo(`Linked todo ${word}`, { requestedBy: [{ personId: id }] });
  await page.goto(`/people/${id}`);
  await page.getByRole("button", { name: "Delete person" }).click();
  const confirm = page.getByRole("dialog", { name: `Delete Linked Person${stamp}?` });
  await confirm.getByRole("button", { name: "Delete person" }).click();
  const message = confirm.getByRole("alert");
  await expect(message).toHaveText(/^Linked to 1 todo\./);
  expect((await insets(confirm, message)).left).toBeGreaterThanOrEqual(12);
  expect(
    (await insets(confirm, confirm.getByRole("button", { name: "Keep" }))).bottom,
  ).toBeGreaterThanOrEqual(12);
  await confirm.getByRole("button", { name: "Keep" }).click();
});

test("several files attached at once show one per line", async () => {
  const note = await create<{ id: number }>("/notes", { title: `Attach ${word}`, projectId });
  made.notes.push(note.id);
  await page.goto(`/notes/${note.id}`);
  await page.locator(".cm-content").first().click();
  await page.keyboard.type("Body text äöü");
  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles([
      { name: "report.xyz", mimeType: "application/octet-stream", buffer: Buffer.from("report") },
      { name: "notes.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4") },
    ]);
  await expect
    .poll(async () => (await getJson<{ bodyMd: string }>(api, `/notes/${note.id}`)).bodyMd, {
      timeout: 10_000,
    })
    .toMatch(/^Body text äöü\n\n\[report\.xyz\]\([^)]+\)\n\n\[notes\.pdf\]\([^)]+\)$/);
  await page.getByRole("button", { name: "Preview" }).first().click();
  const links = page.locator("main a[href*='/attachments/']");
  await expect(links).toHaveCount(2);
  const [a, b] = [await links.nth(0).boundingBox(), await links.nth(1).boundingBox()];
  expect(a && b && b.y > a.y + a.height - 1).toBe(true);
});

test("a refused restore file says why once, in view and focused", async () => {
  await page.goto("/settings");
  await page
    .getByLabel("Export zip to restore")
    .setInputFiles({ name: "bad.zip", mimeType: "application/zip", buffer: Buffer.from("not a zip") });
  const alert = page.getByRole("alert").filter({ hasText: "bad.zip cannot be restored." });
  await expect(alert).toBeInViewport();
  await expect(alert).toBeFocused();
  const text = (await alert.textContent()) ?? "";
  expect(text.match(/cannot be restored/g)).toHaveLength(1);
  const reason = /restored\. (.+?)Nothing was changed\./.exec(text)?.[1] ?? "";
  expect(reason.length).toBeGreaterThan(0);
  expect(text.split(reason)).toHaveLength(2);
});

test("the board cursor is an amber ring in both themes", async () => {
  await createTodo(`Board cursor ${word}`);
  const ring = { dark: "rgb(255, 178, 36)", light: "rgb(176, 111, 0)" };
  for (const theme of ["dark", "light"] as const) {
    await page.goto(`/board?project=${projectSlug}`);
    await setTheme(theme);
    const card = page.locator("[data-selected]");
    await expect(page.getByText(`Board cursor ${word}`)).toBeVisible();
    await focusPage();
    await page.keyboard.press("j");
    await expect(card).toHaveCount(1);
    await expect(card).toHaveCSS("border-top-color", ring[theme]);
  }
  await setTheme("dark");
});

test("m right after opening a todo goes to the comment box once the page is there", async () => {
  const id = await createTodo(`Comment fast ${word}`);
  await page.goto(`/board?project=${projectSlug}`);
  // A slow answer for the todo, so the key comes while the page still loads.
  await page.route(`**${API}/todos/${id}`, async (route) => {
    await new Promise((done) => setTimeout(done, 800));
    await route.continue();
  });
  await page.getByRole("link", { name: `Comment fast ${word}` }).click();
  await page.keyboard.press("m");
  await expect(page.getByRole("textbox", { name: "New comment" })).toBeFocused();
  await page.unroute(`**${API}/todos/${id}`);
});

test("no console errors on the way, except the refused restore file and the linked person", () => {
  const expected = [/status of 422/, /status of 409/];
  expect(problems.filter((p) => !expected.some((e) => e.test(p)))).toEqual([]);
});
