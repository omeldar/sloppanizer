import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(cleanup);

// findBy and waitFor give up after 1 s by default, which suits one component. Most page tests render
// the whole app with its router and queries; the first render in a file runs cold and on a busy
// machine takes longer than that. A wait still ends as soon as its condition holds.
configure({ asyncUtilTimeout: 3000 });

// jsdom has no layout; CodeMirror measures text ranges when it scrolls the cursor into view.
if (typeof Range !== "undefined" && !Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
}
