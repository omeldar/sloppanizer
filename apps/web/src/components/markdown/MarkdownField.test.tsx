import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderWithApp } from "../../test/render.tsx";
import { MarkdownField } from "./MarkdownField.tsx";

/** The field and a button that changes its value, like a refetch after an edit in another tab. */
function Harness({ outside, save }: { outside: string; save: (text: string) => Promise<boolean> }) {
  const [value, setValue] = useState("");
  return (
    <>
      <button type="button" onClick={() => setValue(outside)}>
        Change elsewhere
      </button>
      <MarkdownField title="Notes" value={value} save={save} emptyText="Nothing yet." />
    </>
  );
}

const changeElsewhere = () => fireEvent.click(screen.getByRole("button", { name: "Change elsewhere" }));

async function editor() {
  const content = await screen.findByLabelText("Notes");
  const view = EditorView.findFromDOM(content);
  if (!view) throw new Error("no editor");
  return view;
}

function typeAtEnd(view: EditorView, text: string) {
  act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: text } }));
}

describe("MarkdownField with an open editor", () => {
  it("shows text changed elsewhere and saves the next edit on top of it", async () => {
    const save = vi.fn<(text: string) => Promise<boolean>>(async () => true);
    renderWithApp(<Harness outside="Written by MCP" save={save} />);
    const view = await editor();

    changeElsewhere();
    expect(view.state.doc.toString()).toBe("Written by MCP");
    expect(save).not.toHaveBeenCalled();

    typeAtEnd(view, ", then me");
    await waitFor(() => expect(save).toHaveBeenCalledOnce(), { timeout: 3000 });
    expect(save).toHaveBeenCalledWith("Written by MCP, then me");
  });

  it("keeps unsaved typing when a change from elsewhere arrives", async () => {
    const save = vi.fn<(text: string) => Promise<boolean>>(async () => true);
    renderWithApp(<Harness outside="Theirs" save={save} />);
    const view = await editor();

    typeAtEnd(view, "Mine");
    changeElsewhere();
    expect(view.state.doc.toString()).toBe("Mine");
    await waitFor(() => expect(save).toHaveBeenCalledWith("Mine"), { timeout: 3000 });
  });

  it("does not offer the outside change for undo", async () => {
    const save = vi.fn<(text: string) => Promise<boolean>>(async () => true);
    renderWithApp(<Harness outside="New text" save={save} />);
    const view = await editor();
    changeElsewhere();
    act(() => {
      undo(view);
    });
    expect(view.state.doc.toString()).toBe("New text");
  });
});
