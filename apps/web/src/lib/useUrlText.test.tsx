import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUrlText } from "./useUrlText.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(url: string) {
  const write = vi.fn<(value: string) => void>();
  const hook = renderHook(({ url: current }) => useUrlText(current, write, 150), { initialProps: { url } });
  return { ...hook, write };
}

describe("useUrlText", () => {
  it("writes the trimmed text to the URL once typing pauses, not on every key", () => {
    const { result, write } = setup("");
    act(() => result.current.setText("a"));
    act(() => vi.advanceTimersByTime(100));
    act(() => result.current.setText("an "));
    act(() => vi.advanceTimersByTime(149));
    expect(write).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(write.mock.calls).toEqual([["an"]]);
    expect(result.current.settled).toBe("an");
  });

  it("keeps the typed space when its own write comes back through the URL", () => {
    const { result, rerender, write } = setup("");
    act(() => result.current.setText("foo "));
    act(() => vi.advanceTimersByTime(150));
    expect(write).toHaveBeenCalledWith("foo");
    rerender({ url: "foo" });
    expect(result.current.text).toBe("foo ");
  });

  it("shows a URL change from elsewhere and does not write the old text back", () => {
    const { result, rerender, write } = setup("old");
    rerender({ url: "new" });
    expect(result.current.text).toBe("new");
    act(() => vi.advanceTimersByTime(500));
    expect(write).not.toHaveBeenCalled();
    expect(result.current.settled).toBe("new");
  });
});
