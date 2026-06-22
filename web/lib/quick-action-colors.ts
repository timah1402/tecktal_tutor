/**
 * Rotating accent colors for the Quick Actions panel's tile icons, sampled
 * from the product logo (amber, orange-red, navy alongside the brand-green
 * --primary). Only defined under .theme-brand in globals.css — other themes
 * fall back to the existing neutral --accent pair via the `tint` default.
 */

export interface QuickActionAccent {
  icon: string;
  tint: string;
}

const ACCENT_CYCLE: QuickActionAccent[] = [
  { icon: "var(--accent-amber, var(--primary))", tint: "var(--accent-amber-tint, var(--accent))" },
  { icon: "var(--accent-orange, var(--primary))", tint: "var(--accent-orange-tint, var(--accent))" },
  { icon: "var(--accent-navy, var(--primary))", tint: "var(--accent-navy-tint, var(--accent))" },
];

export function getAccentForIndex(index: number): QuickActionAccent {
  return ACCENT_CYCLE[((index % ACCENT_CYCLE.length) + ACCENT_CYCLE.length) % ACCENT_CYCLE.length];
}
