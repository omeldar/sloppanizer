/**
 * Build checks for the HTML pages. The CSP forbids inline scripts, so a page with one would break in
 * production only; the build fails here instead. The landing page must stay static: no app bundle.
 */

/** Problems in one HTML page; empty when it is fine. */
export function htmlProblems(html: string, options: { staticPage?: boolean } = {}): string[] {
  const problems: string[] = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attributes = match[1] ?? "";
    const body = match[2] ?? "";
    if (!/\bsrc\s*=/i.test(attributes)) problems.push("inline script (the CSP blocks it)");
    else if (body.trim() !== "") problems.push("script with both src and a body");
    if (options.staticPage && /\btype\s*=\s*["']?module/i.test(attributes)) {
      problems.push("module script on a static page (it would load the app bundle)");
    }
  }
  if (options.staticPage && /<link\b[^>]*rel\s*=\s*["']?modulepreload/i.test(html)) {
    problems.push("modulepreload link on a static page (it would load the app bundle)");
  }
  for (const match of html.matchAll(/<[a-z][^>]*\s(on[a-z]+)\s*=/gi)) {
    problems.push(`inline event handler ${match[1]} (the CSP blocks it)`);
  }
  if (/\b(?:href|src|action)\s*=\s*["']?\s*javascript:/i.test(html)) problems.push("javascript: URL");
  return problems;
}

/** Pages that must not load the app's JavaScript. */
export const STATIC_PAGES = new Set(["index.html", "404.html"]);
