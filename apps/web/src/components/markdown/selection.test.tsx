import { EditorView } from "@codemirror/view";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderWithApp } from "../../test/render.tsx";
import { MarkdownEditor } from "./MarkdownEditor.tsx";
import { readTextSelection } from "./selection.ts";

afterEach(() => document.getSelection()?.removeAllRanges());

/** Selects the DOM text of `node` from `start` to `end`. */
function selectText(node: Node, start: number, end: number) {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const selection = document.getSelection() as Selection;
  selection.removeAllRanges();
  selection.addRange(range);
}

describe("readTextSelection", () => {
  it("reads selected rendered text inside the container only", () => {
    const { container } = render(
      <div>
        <p data-testid="inside">Renew the certs</p>
        <p data-testid="outside">Elsewhere</p>
      </div>,
    );
    const inside = screen.getByTestId("inside");
    selectText(inside.firstChild as Node, 6, 15);
    expect(readTextSelection(inside)?.text).toBe("the certs");
    selectText(screen.getByTestId("outside").firstChild as Node, 0, 9);
    expect(readTextSelection(inside)).toBeNull();
    expect(readTextSelection(container)?.text).toBe("Elsewhere");
  });

  it("ignores an empty or blank selection", () => {
    render(<p data-testid="text">Two words</p>);
    const text = screen.getByTestId("text");
    selectText(text.firstChild as Node, 3, 3);
    expect(readTextSelection(text)).toBeNull();
    selectText(text.firstChild as Node, 3, 4);
    expect(readTextSelection(text)).toBeNull();
  });

  it("takes the editor's text from its document, Markdown and line breaks included", async () => {
    const { container } = renderWithApp(
      <MarkdownEditor label="Text" value={"# Plan\nCall **Anna**\nthen the VPN"} onChange={() => {}} />,
    );
    const view = EditorView.findFromDOM(await screen.findByLabelText("Text")) as EditorView;
    // The DOM selection says "something in the editor is selected"; the editor's state says what.
    act(() => view.dispatch({ selection: { anchor: 7, head: 29 } }));
    const line = container.querySelector(".cm-line") as Element;
    selectText(line.firstChild as Node, 0, 2);
    expect(readTextSelection(container)?.text).toBe("Call **Anna**\nthen the");
  });

  it("reads a preview selection across markup as the rendered text, without the markdown", () => {
    render(
      <div data-testid="preview">
        <p>
          Call <strong>Anna</strong> about
        </p>
        <ul>
          <li>the VPN</li>
        </ul>
      </div>,
    );
    const preview = screen.getByTestId("preview");
    const first = preview.querySelector("p")?.firstChild as Node;
    const last = preview.querySelector("li")?.firstChild as Node;
    const range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(last, 7);
    const selection = document.getSelection() as Selection;
    selection.removeAllRanges();
    selection.addRange(range);
    const text = readTextSelection(preview)?.text ?? "";
    expect(text).toContain("Call Anna about");
    expect(text).toContain("the VPN");
    expect(text).not.toMatch(/[*#]/);
  });

  it("ignores a selection that starts inside the container and ends outside it", () => {
    render(
      <div>
        <p data-testid="inside">Inside text</p>
        <p data-testid="outside">Outside text</p>
      </div>,
    );
    const range = document.createRange();
    range.setStart(screen.getByTestId("inside").firstChild as Node, 2);
    range.setEnd(screen.getByTestId("outside").firstChild as Node, 4);
    const selection = document.getSelection() as Selection;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(readTextSelection(screen.getByTestId("inside"))).toBeNull();
  });

  it("ignores a blank selection in the editor, taking the document's text", async () => {
    const { container } = renderWithApp(
      <MarkdownEditor label="Text" value={"Call\n\n   \nAnna"} onChange={() => {}} />,
    );
    const view = EditorView.findFromDOM(await screen.findByLabelText("Text")) as EditorView;
    act(() => view.dispatch({ selection: { anchor: 4, head: 9 } }));
    const line = container.querySelector(".cm-line") as Element;
    selectText(line.firstChild as Node, 0, 2);
    expect(readTextSelection(container)).toBeNull();
  });
});
