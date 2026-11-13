import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearAttachmentCache } from "../../lib/attachmentCache.ts";
import { renderWithApp } from "../../test/render.tsx";
import { MarkdownPreview } from "./MarkdownPreview.tsx";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearAttachmentCache();
});

/** A fake API that serves image bytes; blob URLs are counted like the browser makes them. */
function mockBlobApi(status = 200) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      calls.push(input);
      return status === 200
        ? new Response(new Blob(["png"], { type: "image/png" }))
        : new Response(JSON.stringify({ error: { code: "not_found", message: "No such file." } }), {
            status,
          });
    }),
  );
  let made = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:test/${++made}`);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  return calls;
}

function preview(source: string) {
  const view = renderWithApp(<MarkdownPreview source={source} />);
  return { ...view, root: () => view.container.querySelector("div") as HTMLElement };
}

describe("todo references", () => {
  it("turns #123 into a link inside the app", async () => {
    preview("Follows up on #123, see there.");
    const link = await screen.findByRole("link", { name: "#123" });
    expect(link.getAttribute("href")).toBe("/todos/123");
    expect(link.getAttribute("target")).toBeNull();
  });

  it("leaves #123 in code spans and code blocks alone", async () => {
    preview("Run `git show #12` first.\n\n```\nissue #34\n```\n\nThen #56.");
    await screen.findByRole("link", { name: "#56" });
    expect(screen.queryByRole("link", { name: "#12" })).toBeNull();
    expect(screen.queryByRole("link", { name: "#34" })).toBeNull();
    expect(screen.getByText("git show #12")).toBeTruthy();
  });

  it("does not link inside an existing link or glued to a word or URL", async () => {
    preview("[ticket #7](https://example.com/t/7) and abc#8 and https://example.com/page#9 and #10.");
    await screen.findByRole("link", { name: "#10" });
    const external = screen.getByRole("link", { name: "ticket #7" });
    expect(external.getAttribute("href")).toBe("https://example.com/t/7");
    expect(external.getAttribute("target")).toBe("_blank");
    expect(screen.queryByRole("link", { name: "#8" })).toBeNull();
    expect(screen.queryByRole("link", { name: "#9" })).toBeNull();
  });
});

describe("images", () => {
  it("loads the app's own attachments through fetch and shows them from a blob URL", async () => {
    const calls = mockBlobApi();
    const view = preview("![diagram](/api/v1/attachments/4/diagram.png)");
    const image = await screen.findByRole("img", { name: "diagram" });
    expect(image.getAttribute("src")).toBe("blob:test/1");
    expect(image.closest("a")?.getAttribute("href")).toBe("blob:test/1");
    expect(image.closest("a")?.getAttribute("target")).toBe("_blank");
    expect(calls).toEqual(["/api/v1/attachments/4/diagram.png"]);
    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test/1");
  });

  it("asks the server once per attachment while the page is open", async () => {
    const calls = mockBlobApi();
    const first = preview("![a](/api/v1/attachments/5/a.png)");
    await screen.findByRole("img", { name: "a" });
    first.unmount();
    preview("![a again](/api/v1/attachments/5/a.png)");
    expect((await screen.findByRole("img", { name: "a again" })).getAttribute("src")).toBe("blob:test/2");
    expect(calls).toEqual(["/api/v1/attachments/5/a.png"]);
  });

  it("says so when an image cannot be loaded", async () => {
    mockBlobApi(404);
    preview("![gone](/api/v1/attachments/6/gone.png)");
    expect(await screen.findByText("gone (could not load)")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("shows outside images as a link with the alt text, never an img", async () => {
    preview("![tracking pixel](https://evil.example/p.png)");
    const link = await screen.findByRole("link", { name: "tracking pixel" });
    expect(link.getAttribute("href")).toBe("https://evil.example/p.png");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("does not trust paths that only start like an attachment", async () => {
    preview("![x](/api/v1/attachments/../todos/1)");
    await screen.findByRole("link", { name: "x" });
    expect(screen.queryByRole("img")).toBeNull();
  });
});
