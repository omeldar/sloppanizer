import { useState } from "react";

/**
 * Calls `onChange` during render when `value` differs from the previous render's, for state that has to
 * follow a prop (a cursor that resets when the list changes). React's "adjust state while rendering":
 * no effect, so there is no extra render with stale state. `onChange` may only set state.
 */
export function useOnChange<T>(value: T, onChange: (value: T) => void): void {
  const [seen, setSeen] = useState(value);
  if (!Object.is(seen, value)) {
    setSeen(value);
    onChange(value);
  }
}
