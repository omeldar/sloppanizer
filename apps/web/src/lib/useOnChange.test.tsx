import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useOnChange } from "./useOnChange.ts";

describe("useOnChange", () => {
  it("calls back once per new value, not on the first render or a repeat of the same value", () => {
    const onChange = vi.fn<(value: number) => void>();
    const { rerender } = renderHook(({ value }) => useOnChange(value, onChange), {
      initialProps: { value: 1 },
    });
    expect(onChange).not.toHaveBeenCalled();
    rerender({ value: 1 });
    expect(onChange).not.toHaveBeenCalled();
    rerender({ value: 2 });
    rerender({ value: 2 });
    expect(onChange.mock.calls).toEqual([[2]]);
  });
});
