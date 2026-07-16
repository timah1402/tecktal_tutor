/**
 * Global v1 feature flags — features not ready to ship yet. Flip a flag to
 * `true` to bring the feature back into the nav and unlock direct-URL
 * access; no other code needs to change.
 */
export const FEATURE_FLAGS = {
  partners: false,
  agents: false,
  coWriter: false,
  book: false,
  memory: false,
} as const;

export type FeatureFlag = keyof typeof FEATURE_FLAGS;

/**
 * Route prefix -> feature flag it depends on. Single source of truth read by
 * both the sidebar (to hide nav tiles) and FeatureGate (to block direct-URL
 * access to the route), so a hidden feature only has to be declared once.
 */
export const ROUTE_FEATURES: ReadonlyArray<{
  prefix: string;
  feature: FeatureFlag;
}> = [
  { prefix: "/partners", feature: "partners" },
  { prefix: "/agents", feature: "agents" },
  { prefix: "/co-writer", feature: "coWriter" },
  { prefix: "/book", feature: "book" },
  { prefix: "/memory", feature: "memory" },
];

/**
 * Matches on a path-segment boundary (exact, or prefix followed by "/") so a
 * sibling route can never be swallowed by a shorter prefix.
 */
export function featureForPath(pathname: string): FeatureFlag | null {
  const match = ROUTE_FEATURES.find(
    (r) => pathname === r.prefix || pathname.startsWith(`${r.prefix}/`),
  );
  return match ? match.feature : null;
}

export function isRouteEnabled(pathname: string): boolean {
  const feature = featureForPath(pathname);
  return feature ? FEATURE_FLAGS[feature] : true;
}
