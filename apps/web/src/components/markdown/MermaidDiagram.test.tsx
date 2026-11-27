import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setTheme } from "../../lib/theme.ts";
import { renderWithApp } from "../../test/render.tsx";
import { MarkdownPreview } from "./MarkdownPreview.tsx";
import { clearDiagramCache, errorLine, svgToImage } from "./mermaid.ts";

const mermaid = vi.hoisted(() => ({
  imported: 0,
  initialize: vi.fn<(config: Record<string, unknown>) => void>(),
  render: vi.fn<(id: string, text: string) => Promise<{ svg: string }>>(),
}));

vi.mock("mermaid", () => {
  mermaid.imported += 1;
  return { default: { initialize: mermaid.initialize, render: mermaid.render } };
});

const SVG = (label: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 120.5 80" style="max-width: 120.5px;">` +
  `<title>${label}</title><text>${label}</text></svg>`;

beforeEach(() => {
  mermaid.initialize.mockReset();
  mermaid.render.mockReset();
  mermaid.render.mockImplementation(async (_id: string, text: string) => ({
    svg: SVG(text.split("\n")[1]?.trim() ?? "x"),
  }));
});

afterEach(() => {
  // Unmount first: a theme change with a diagram on screen would draw it again.
  cleanup();
  setTheme("dark");
  clearDiagramCache();
});

const DIAGRAM = "```mermaid\nflowchart LR\n  A --> B\n```";

/** A preview whose text changes on a click, like editing it. */
function Editing({ next }: { next: string }) {
  const [source, setSource] = useState(DIAGRAM);
  return (
    <>
      <button type="button" onClick={() => setSource(next)}>
        Change
      </button>
      <MarkdownPreview source={source} />
    </>
  );
}

describe("mermaid blocks", () => {
  // First in the file: the module is imported at most once per file.
  it("does not load mermaid when the text has no mermaid block", async () => {
    renderWithApp(<MarkdownPreview source={"# Plan\n\n```ts\nconst a = 1;\n```\n\nAnd `mermaid` inline."} />);
    await screen.findByText("const a = 1;");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mermaid.imported).toBe(0);
    expect(mermaid.render).not.toHaveBeenCalled();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("draws a ```mermaid block as an image, strict and in the app's theme", async () => {
    renderWithApp(<MarkdownPreview source={`Before\n\n${DIAGRAM}\n\nAfter`} />);
    const image = await screen.findByRole("img", { name: "Diagram: A --> B" });
    expect(mermaid.imported).toBe(1);
    expect(image.getAttribute("src")).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    expect(image.getAttribute("width")).toBe("121");
    expect(image.getAttribute("height")).toBe("80");
    expect(mermaid.render).toHaveBeenCalledTimes(1);
    const [id, text] = mermaid.render.mock.calls[0] as [string, string];
    expect(id).toMatch(/^mermaid-[a-zA-Z0-9_-]+$/);
    expect(text).toBe("flowchart LR\n  A --> B");
    expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        securityLevel: "strict",
        htmlLabels: false,
        theme: "dark",
        startOnLoad: false,
      }),
    );
    expect(mermaid.initialize.mock.calls[0]?.[0].secure).toEqual(
      expect.arrayContaining(["securityLevel", "htmlLabels"]),
    );
    // The fence's text is no longer shown as code.
    expect(screen.queryByText(/flowchart LR/)).toBeNull();
    expect(screen.getByText("Before")).toBeTruthy();
  });

  it("shows the source and a short error line when the diagram does not parse", async () => {
    mermaid.render.mockRejectedValue(
      new Error("Parse error on line 2:\n...A --\n-----^\nExpecting 'SEMI', 'NEWLINE', got 'EOF'"),
    );
    renderWithApp(<MarkdownPreview source={"```mermaid\nflowchart LR\n  A --\n```"} />);
    const status = await screen.findByText(/Diagram could not be drawn/);
    expect(status.textContent).toBe(
      "Diagram could not be drawn: Parse error on line 2: Expecting 'SEMI', 'NEWLINE', got 'EOF'",
    );
    expect(screen.getByText(/flowchart LR/).closest("pre")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("draws again when the text changes, keeping the old picture until then", async () => {
    renderWithApp(<Editing next={"```mermaid\nflowchart LR\n  A --> C\n```"} />);
    await screen.findByRole("img", { name: "Diagram: A --> B" });
    let finish: ((value: { svg: string }) => void) | undefined;
    mermaid.render.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("img", { name: "Diagram: A --> B" })).toBeTruthy();
    await act(async () => finish?.({ svg: SVG("A --> C") }));
    await screen.findByRole("img", { name: "Diagram: A --> C" });
    expect(screen.getAllByRole("img")).toHaveLength(1);
  });

  it("follows the theme and shows a drawn diagram again at once", async () => {
    const view = renderWithApp(<MarkdownPreview source={DIAGRAM} />);
    await screen.findByRole("img");
    act(() => setTheme("light"));
    await waitFor(() =>
      expect(mermaid.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: "default" })),
    );
    expect(mermaid.render).toHaveBeenCalledTimes(2);
    view.unmount();
    // Back in preview (a new mount): from the cache, no new drawing.
    renderWithApp(<MarkdownPreview source={DIAGRAM} />);
    await screen.findByRole("img");
    expect(mermaid.render).toHaveBeenCalledTimes(2);
  });

  it("accepts ~~~ fences and any case, but not other languages", async () => {
    renderWithApp(
      <MarkdownPreview source={"~~~Mermaid\nflowchart LR\n  A --> B\n~~~\n\n```mermaidish\nno\n```"} />,
    );
    await screen.findByRole("img");
    expect(screen.getByText("no").closest("pre")).toBeTruthy();
    expect(mermaid.render).toHaveBeenCalledTimes(1);
  });
});

describe("svgToImage", () => {
  it("sizes the image from the viewBox and drops script-free markup into a data URL", () => {
    const image = svgToImage(SVG("Flow"));
    expect(image).toMatchObject({ alt: "Diagram: Flow", width: 121, height: 80 });
    const svg = decodeURIComponent(image.src.split(",")[1] as string);
    expect(svg).toContain('width="121"');
    expect(svg).not.toContain("max-width");
  });

  it("refuses output that is not an SVG", () => {
    expect(() => svgToImage("<div>nope</div>")).toThrow("The diagram came out empty.");
  });
});

describe("errorLine", () => {
  it("keeps one short line", () => {
    expect(
      errorLine(new Error("No diagram type detected matching given configuration for text: hello")),
    ).toBe("No diagram type detected matching given configuration for text: hello");
    expect(errorLine(new Error("x".repeat(500)))).toHaveLength(200);
    expect(errorLine(undefined)).toBe("The diagram has an error.");
    expect(
      errorLine(
        new Error("Parse error on line 4:\n...\n---^\nExpecting 'SQE', 'PE', 'PIPE', 'TEXT', got '1'"),
      ),
    ).toBe("Parse error on line 4: unexpected end of the diagram");
    expect(
      errorLine(new Error("Parse error on line 2:\nx\n^\nExpecting 'A', 'B', 'C', 'D', got 'NODE_STRING'")),
    ).toBe("Parse error on line 2: unexpected 'NODE_STRING'");
  });
});
