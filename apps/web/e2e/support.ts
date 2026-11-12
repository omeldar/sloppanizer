import { type APIRequestContext, expect, type Locator, type Page } from "@playwright/test";

// Helpers shared by the e2e specs.

export const API = "/api/v1";

const pad = (n: number) => String(n).padStart(2, "0");

/** Today plus `days` as YYYY-MM-DD in the local time zone (server and browser run on this machine). */
export function localDate(days: number, from = new Date()): string {
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A 4x4 amber PNG: small, but a real image the browser can decode (naturalWidth > 0). */
export const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEUlEQVR4nGP4v0kFjhiI4wAACDEdUeVPX7EAAAAASUVORK5CYII=";
export const pngBytes = (): Buffer => Buffer.from(PNG_BASE64, "base64");

/** Clicks into an empty part of the page so global shortcuts are not swallowed by a focused field. */
export async function focusPage(page: Page): Promise<void> {
  await page.locator("main").click({ position: { x: 700, y: 820 } });
}

export const toast = (page: Page, text: string | RegExp): Locator =>
  page.getByRole("status").filter({ hasText: text });

/**
 * Pastes a PNG into an editable element the way a browser does on ctrl+v with an image in the clipboard
 * (Playwright cannot put files on the real clipboard).
 */
export async function pastePng(target: Locator, fileName: string): Promise<void> {
  await target.click();
  await target.evaluate(
    (el, { b64, name }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], name, { type: "image/png" }));
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    },
    { b64: PNG_BASE64, name: fileName },
  );
}

/**
 * Drags with the mouse in small steps, so drag and drop libraries that wait for a few pixels of movement
 * (and pointer sensors with an activation distance) see a real drag.
 */
export async function drag(page: Page, from: Locator, to: Locator): Promise<void> {
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  if (!a || !b) throw new Error("drag: source or target is not visible");
  const start = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  const end = { x: b.x + b.width / 2, y: b.y + Math.min(b.height / 2, 60) };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 8, start.y + 8, { steps: 4 });
  await page.mouse.move(end.x, end.y, { steps: 20 });
  await page.mouse.move(end.x + 2, end.y + 2, { steps: 2 });
  await page.mouse.up();
}

/** GET a JSON resource and fail loudly on anything but 200. */
export async function getJson<T>(
  api: APIRequestContext,
  path: string,
  params?: Record<string, string>,
): Promise<T> {
  const res = await api.get(`${API}${path}`, params ? { params } : undefined);
  expect(res.status(), `GET ${path}`).toBe(200);
  return (await res.json()) as T;
}

/** Collects console errors and page errors; the last test of a spec expects none. */
export function watchProblems(page: Page, problems: string[]): void {
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(String(e)));
}
