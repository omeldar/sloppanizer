/** Three stacked strips, the newest one with the amber band. */
export function BrandMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" style={{ color: "var(--text-2)" }}>
      <rect x="1" y="2" width="16" height="3.6" rx="0.6" fill="currentColor" opacity="0.35" />
      <rect x="1" y="7.2" width="16" height="3.6" rx="0.6" fill="currentColor" opacity="0.6" />
      <rect x="1" y="12.4" width="16" height="3.6" rx="0.6" fill="currentColor" />
      <rect x="1" y="12.4" width="2.4" height="3.6" fill="var(--amber)" />
    </svg>
  );
}
