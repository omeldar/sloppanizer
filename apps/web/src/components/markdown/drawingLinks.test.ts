import { describe, expect, it } from "vitest";
import { drawingMarkdown, isDrawingSrc, replaceLinkTarget } from "./drawingLinks.ts";

describe("drawing links", () => {
  it("knows a drawing by its attachment file name", () => {
    expect(isDrawingSrc("/api/v1/attachments/12/drawing-2026-11-27-1032.png")).toBe(true);
    expect(isDrawingSrc("/api/v1/attachments/12/photo.png")).toBe(false);
    expect(isDrawingSrc("/api/v1/attachments/12/drawing-a.jpg")).toBe(false);
    expect(isDrawingSrc("https://example.com/api/v1/attachments/12/drawing-a.png")).toBe(false);
    expect(isDrawingSrc("/api/v1/attachments/12/../drawing-a.png")).toBe(false);
    expect(isDrawingSrc(undefined)).toBe(false);
  });

  it("swaps only whole link targets", () => {
    const old = "/api/v1/attachments/1/drawing-a.png";
    const text = `${drawingMarkdown(old)} and again ${drawingMarkdown(old)}; the text ${old} stays`;
    expect(replaceLinkTarget(text, old, "/api/v1/attachments/2/drawing-b.png")).toBe(
      "![Drawing](/api/v1/attachments/2/drawing-b.png) and again ![Drawing](/api/v1/attachments/2/drawing-b.png); the text /api/v1/attachments/1/drawing-a.png stays",
    );
  });
});
