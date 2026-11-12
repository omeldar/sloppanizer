/** WCAG relative luminance of a #RRGGBB color. */
export function luminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  const channel = (shift: number) => {
    const c = ((value >> shift) & 0xff) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].toSorted((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const DARK_INK = "#12161C";
const LIGHT_INK = "#FFFFFF";

/** The ink (near black or white) that reads best on the given fill. */
export function inkOn(fill: string): string {
  return contrast(fill, DARK_INK) >= contrast(fill, LIGHT_INK) ? DARK_INK : LIGHT_INK;
}

/** Colors offered for projects and person tags. */
export const PROJECT_COLORS = [
  "#8B95A5",
  "#4C9AFF",
  "#36B37E",
  "#FFB224",
  "#F2555A",
  "#A77BF3",
  "#2EC5CE",
  "#E5739F",
];
