import type { ReactNode } from "react";

/** Line icons for the sidebar and the tab bar (20 by 20, stroke in the text color). */
export const ICONS = {
  next: <path d="M4 10l4 4 8-9" />,
  inbox: <path d="M3 11h4l1.5 2.5h3L13 11h4M3 11l2-7h10l2 7v5H3z" />,
  board: <path d="M3 4h4v12H3zM8 4h4v8H8zM13 4h4v10h-4z" />,
  planner: <path d="M3 5h14v12H3zM3 9h14M7 3v4M13 3v4M7 12.5h3v2.5H7z" />,
  week: <path d="M3 5h14v12H3zM3 9h14M7 3v4M13 3v4" />,
  notes: <path d="M5 3h7l3 3v11H5zM12 3v3h3M8 10h5M8 13h5" />,
  labels: <path d="M3 3h7l7 7-7 7-7-7zM7 7h.01" />,
  people: (
    <path d="M7.5 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM2.5 16c0-2.8 2.2-4.5 5-4.5s5 1.7 5 4.5M13 4.5a2.3 2.3 0 0 1 0 4.4M14.5 11.6c1.8.5 3 1.9 3 4.4" />
  ),
  settings: (
    <path d="M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" />
  ),
  admin: <path d="M10 2.5l6 2.5v4.5c0 3.8-2.6 6.6-6 8-3.4-1.4-6-4.2-6-8V5z" />,
  more: <path d="M4 6h12M4 10h12M4 14h12" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICONS[name]}
    </svg>
  );
}
