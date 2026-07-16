"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";

import { isRouteEnabled } from "@/lib/features";

/**
 * Route-level gate for features hidden in this release (lib/features.ts):
 * redirects away from a disabled feature's routes even on direct-URL
 * access. Mounted once per authed layout group, alongside CapabilityGate.
 */
export default function FeatureGate({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const enabled = isRouteEnabled(pathname);

  useEffect(() => {
    if (!enabled) {
      router.replace("/home");
    }
  }, [enabled, router]);

  if (!enabled) return null;
  return <>{children}</>;
}
