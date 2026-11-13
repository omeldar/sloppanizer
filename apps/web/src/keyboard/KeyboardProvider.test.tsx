import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type KeyBinding, KeyboardProvider, useKeyHold, useKeyMode, useKeys } from "./KeyboardProvider.tsx";

function Keys({
  bindings,
  modal = false,
  enabled = true,
}: {
  bindings: KeyBinding[];
  modal?: boolean;
  enabled?: boolean;
}) {
  useKeys(bindings, { modal, enabled });
  return null;
}

function Mode() {
  const { mode, pending } = useKeyMode();
  return (
    <output aria-label="mode">
      {mode}
      {pending && ` ${pending}`}
    </output>
  );
}

function setup(children: React.ReactNode) {
  return render(
    <KeyboardProvider>
      <Mode />
      <input aria-label="title" />
      <textarea aria-label="notes" />
      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- stands in for a contentEditable editor */}
      <div aria-label="editable" contentEditable suppressContentEditableWarning tabIndex={0} />
      <div className="cm-editor">
        {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- stands in for the focusable CodeMirror content */}
        <div aria-label="code" tabIndex={0} />
      </div>
      <input type="checkbox" aria-label="done" />
      {children}
    </KeyboardProvider>,
  );
}

afterEach(() => vi.useRealTimers());

describe("keyboard system", () => {
  it("runs a single key shortcut in normal mode", async () => {
    const run = vi.fn<(...args: unknown[]) => void>();
    setup(<Keys bindings={[{ keys: "x", run }]} />);
    await userEvent.keyboard("x");
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("mode").textContent).toBe("normal");
  });

  it.each(["title", "notes", "editable", "code"])(
    "ignores single keys while typing in %s (insert mode)",
    async (field) => {
      const run = vi.fn<(...args: unknown[]) => void>();
      setup(
        <Keys
          bindings={[
            { keys: "x", run },
            { keys: "g n", run },
          ]}
        />,
      );
      await userEvent.click(screen.getByLabelText(field));
      expect(screen.getByLabelText("mode").textContent).toBe("insert");
      await userEvent.keyboard("xgn");
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("keeps shortcuts on for a focused checkbox", async () => {
    const run = vi.fn<(...args: unknown[]) => void>();
    setup(<Keys bindings={[{ keys: "j", run }]} />);
    await userEvent.click(screen.getByLabelText("done"));
    expect(screen.getByLabelText("mode").textContent).toBe("normal");
    await userEvent.keyboard("j");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs bindings marked whileTyping inside a text field, and Ctrl+K with caps lock", async () => {
    const palette = vi.fn<(...args: unknown[]) => void>();
    setup(<Keys bindings={[{ keys: "mod+k", run: palette, whileTyping: true }]} />);
    await userEvent.click(screen.getByLabelText("title"));
    await userEvent.keyboard("{Control>}k{/Control}");
    fireEvent.keyDown(screen.getByLabelText("title"), { key: "K", ctrlKey: true });
    expect(palette).toHaveBeenCalledTimes(2);
  });

  it("does not run a plain key binding when a modifier is held", async () => {
    const run = vi.fn<(...args: unknown[]) => void>();
    setup(<Keys bindings={[{ keys: "c", run }]} />);
    await userEvent.keyboard("{Control>}c{/Control}");
    expect(run).not.toHaveBeenCalled();
  });

  it("runs a two key sequence and shows the pending key meanwhile", async () => {
    const goNext = vi.fn<(...args: unknown[]) => void>();
    const lone = vi.fn<(...args: unknown[]) => void>();
    setup(
      <Keys
        bindings={[
          { keys: "g n", run: goNext },
          { keys: "n", run: lone },
        ]}
      />,
    );
    await userEvent.keyboard("g");
    expect(screen.getByLabelText("mode").textContent).toBe("normal g");
    await userEvent.keyboard("n");
    expect(goNext).toHaveBeenCalledTimes(1);
    expect(lone).not.toHaveBeenCalled();
    expect(screen.getByLabelText("mode").textContent).toBe("normal");
  });

  it("falls back to the single key when the second key does not continue a sequence", async () => {
    const goNext = vi.fn<(...args: unknown[]) => void>();
    const done = vi.fn<(...args: unknown[]) => void>();
    setup(
      <Keys
        bindings={[
          { keys: "g n", run: goNext },
          { keys: "x", run: done },
        ]}
      />,
    );
    await userEvent.keyboard("gx");
    expect(goNext).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("forgets an unfinished sequence after a pause", () => {
    vi.useFakeTimers();
    const goNext = vi.fn<(...args: unknown[]) => void>();
    setup(<Keys bindings={[{ keys: "g n", run: goNext }]} />);
    fireEvent.keyDown(window, { key: "g" });
    act(() => vi.advanceTimersByTime(2000));
    fireEvent.keyDown(window, { key: "n" });
    expect(goNext).not.toHaveBeenCalled();
  });

  it("switches off the layers below an open modal layer", async () => {
    const page = vi.fn<(...args: unknown[]) => void>();
    const dialog = vi.fn<(...args: unknown[]) => void>();
    const { rerender } = setup(<Keys bindings={[{ keys: "j", run: page }]} />);
    rerender(
      <KeyboardProvider>
        <Keys bindings={[{ keys: "j", run: page }]} />
        <Keys bindings={[{ keys: "Enter", run: dialog }]} modal />
      </KeyboardProvider>,
    );
    await userEvent.keyboard("j{Enter}");
    expect(page).not.toHaveBeenCalled();
    expect(dialog).toHaveBeenCalledTimes(1);
  });

  it("skips a disabled layer", async () => {
    const run = vi.fn<(...args: unknown[]) => void>();
    setup(<Keys bindings={[{ keys: "j", run }]} enabled={false} />);
    await userEvent.keyboard("j");
    expect(run).not.toHaveBeenCalled();
  });

  it("lets the newest layer win when two layers bind the same key", async () => {
    const outer = vi.fn<(...args: unknown[]) => void>();
    const inner = vi.fn<(...args: unknown[]) => void>();
    setup(
      <>
        <Keys bindings={[{ keys: "e", run: outer }]} />
        <Keys bindings={[{ keys: "e", run: inner }]} />
      </>,
    );
    await userEvent.keyboard("e");
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });

  it("leaves keys alone that a component already handled", () => {
    const run = vi.fn<(...args: unknown[]) => void>();
    setup(<Keys bindings={[{ keys: "Escape", run, whileTyping: true }]} />);
    const input = screen.getByLabelText("title");
    input.addEventListener("keydown", (event) => event.preventDefault());
    fireEvent.keyDown(input, { key: "Escape" });
    expect(run).not.toHaveBeenCalled();
  });
});

function Hold({ active }: { active: boolean }) {
  useKeyHold(active);
  return null;
}

/** A page that is still loading (hold on), then shows with its shortcuts. */
function LoadingPage({ ready, bindings }: { ready: boolean; bindings: KeyBinding[] }) {
  return ready ? <Keys bindings={bindings} /> : <Hold active />;
}

describe("keys pressed while a page loads", () => {
  it("runs a key the loading page binds once it is there", async () => {
    const comment = vi.fn<(...args: unknown[]) => void>();
    const bindings = [{ keys: "m", run: comment }];
    const { rerender } = setup(<LoadingPage ready={false} bindings={bindings} />);
    await userEvent.keyboard("m");
    expect(comment).not.toHaveBeenCalled();
    rerender(
      <KeyboardProvider>
        <LoadingPage ready bindings={bindings} />
      </KeyboardProvider>,
    );
    expect(comment).toHaveBeenCalledTimes(1);
  });

  it("drops a held key the new page does not bind, and never replays it later", async () => {
    const later = vi.fn<(...args: unknown[]) => void>();
    const { rerender } = setup(<LoadingPage ready={false} bindings={[]} />);
    await userEvent.keyboard("m");
    rerender(
      <KeyboardProvider>
        <LoadingPage ready bindings={[{ keys: "x", run: vi.fn<(...args: unknown[]) => void>() }]} />
      </KeyboardProvider>,
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 5000);
    rerender(
      <KeyboardProvider>
        <LoadingPage ready bindings={[{ keys: "x", run: vi.fn<(...args: unknown[]) => void>() }]} />
        <Keys bindings={[{ keys: "m", run: later }]} />
      </KeyboardProvider>,
    );
    expect(later).not.toHaveBeenCalled();
  });

  it("does not hold keys when no page is loading", async () => {
    const run = vi.fn<(...args: unknown[]) => void>();
    const { rerender } = setup(<Hold active={false} />);
    await userEvent.keyboard("m");
    rerender(
      <KeyboardProvider>
        <Keys bindings={[{ keys: "m", run }]} />
      </KeyboardProvider>,
    );
    expect(run).not.toHaveBeenCalled();
  });
});
