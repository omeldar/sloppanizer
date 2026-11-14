/** A touch screen without a keyboard to speak of: hints name buttons, not keys. */
export const touchOnly =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(hover: none) and (pointer: coarse)").matches;

/** The keyboard hint, or on touch screens the one that names the button. */
export const hint = (keys: string, touch: string): string => (touchOnly ? touch : keys);
