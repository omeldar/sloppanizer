import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SAVE_DELAY_MS, useAutosave } from "./useAutosave.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** A save whose answers the test hands out one by one. */
function controlledSave() {
  const answers: ((ok: boolean) => void)[] = [];
  const save = vi.fn<(text: string) => Promise<boolean>>(
    () => new Promise<boolean>((resolve) => answers.push(resolve)),
  );
  const answer = async (ok = true) => {
    await act(async () => {
      answers.shift()?.(ok);
    });
  };
  return { save, answer };
}

function setup(value: string, save: (text: string) => Promise<boolean>) {
  return renderHook(({ value: current }) => useAutosave(current, save), { initialProps: { value } });
}

describe("useAutosave", () => {
  it("saves once after the pause, with the newest text", async () => {
    const save = vi.fn<(text: string) => Promise<boolean>>(async () => true);
    const { result } = setup("", save);
    act(() => result.current.change("a"));
    act(() => result.current.change("ab"));
    expect(result.current.state).toBe("pending");
    await act(async () => vi.advanceTimersByTime(SAVE_DELAY_MS));
    expect(save.mock.calls).toEqual([["ab"]]);
    expect(result.current.state).toBe("saved");
  });

  it("keeps one save in flight and sends only the newest text after it, in order", async () => {
    const { save, answer } = controlledSave();
    const { result } = setup("", save);
    act(() => result.current.change("a"));
    act(() => result.current.flush());
    act(() => result.current.change("ab"));
    act(() => result.current.flush());
    act(() => result.current.change("abc"));
    act(() => result.current.flush());
    expect(save.mock.calls).toEqual([["a"]]);

    await answer();
    expect(save.mock.calls).toEqual([["a"], ["abc"]]);
    expect(result.current.state).toBe("saving");
    await answer();
    expect(save).toHaveBeenCalledTimes(2);
    expect(result.current.state).toBe("saved");
  });

  it("stays not saved when the save fails", async () => {
    const { save, answer } = controlledSave();
    const { result } = setup("old", save);
    act(() => result.current.change("new"));
    act(() => result.current.flush());
    await answer(false);
    expect(result.current.state).toBe("pending");
    expect(result.current.draft).toBe("new");
  });

  it("saves the pending text when it goes away before the pause ended", () => {
    const save = vi.fn<(text: string) => Promise<boolean>>(async () => true);
    const { result, unmount } = setup("Hello", save);
    act(() => result.current.change("Hello world"));
    unmount();
    expect(save.mock.calls).toEqual([["Hello world"]]);
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    expect(save).toHaveBeenCalledOnce();
  });

  it("does not save on going away when nothing changed", () => {
    const save = vi.fn<(text: string) => Promise<boolean>>(async () => true);
    const { unmount } = setup("Hello", save);
    unmount();
    expect(save).not.toHaveBeenCalled();
  });

  it("takes a new value from outside when there are no unsaved edits, without saving it back", () => {
    const save = vi.fn<(text: string) => Promise<boolean>>(async () => true);
    const { result, rerender } = setup("Old", save);
    rerender({ value: "Changed in another tab" });
    expect(result.current.draft).toBe("Changed in another tab");
    expect(result.current.state).toBe("idle");
    act(() => result.current.flush());
    expect(save).not.toHaveBeenCalled();
  });

  it("keeps unsaved edits when a new value arrives from outside", async () => {
    const save = vi.fn<(text: string) => Promise<boolean>>(async () => true);
    const { result, rerender } = setup("Old", save);
    act(() => result.current.change("Old and mine"));
    rerender({ value: "Theirs" });
    expect(result.current.draft).toBe("Old and mine");
    await act(async () => vi.advanceTimersByTime(SAVE_DELAY_MS));
    expect(save.mock.calls).toEqual([["Old and mine"]]);
  });
});
