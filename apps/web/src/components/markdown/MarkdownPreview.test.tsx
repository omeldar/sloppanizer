import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithApp } from "../../test/render.tsx";
import { MarkdownPreview } from "./MarkdownPreview.tsx";

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
  it("shows the app's own attachments as lazy images that open the file", async () => {
    preview("![diagram](/api/v1/attachments/4/diagram.png)");
    const image = await screen.findByRole("img", { name: "diagram" });
    expect(image.getAttribute("loading")).toBe("lazy");
    expect(image.closest("a")?.getAttribute("href")).toBe("/api/v1/attachments/4/diagram.png");
    expect(image.closest("a")?.getAttribute("target")).toBe("_blank");
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
