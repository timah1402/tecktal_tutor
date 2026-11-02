"use client";

import { usePathname } from "next/navigation";
import AppSidebar from "@/components/sidebar/AppSidebar";
import MobileBottomNav from "@/components/sidebar/MobileBottomNav";
import CapabilityGate from "@/components/access/CapabilityGate";
import FeatureGate from "@/components/access/FeatureGate";
import { useKeyboardAwareViewport } from "@/hooks/useKeyboardAwareViewport";

const BARE_PREFIXES = ["/login", "/register"];

export default function AppChrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  useKeyboardAwareViewport();
  const isBare = BARE_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );

  if (isBare) {
    return (
      <main className="flex-1 overflow-hidden bg-[var(--background)]">
        {children}
      </main>
    );
  }

  return (
    // dvh, not h-screen: on mobile Safari 100vh includes the area behind
    // the browser's own toolbar, which pushed the composer under it. While the
    // keyboard is up, --app-height narrows it to what's visible above it.
    <div className="flex h-[var(--app-height,100dvh)] overflow-hidden">
      <AppSidebar />
      {/* max-md:pb-14 keeps page content clear of the fixed bottom nav
          (hidden, so no padding, while the keyboard is open). */}
      <main className="flex-1 overflow-hidden bg-[var(--background)] max-md:pb-14 [html[data-keyboard=open]_&]:pb-0">
        <FeatureGate>
          <CapabilityGate>{children}</CapabilityGate>
        </FeatureGate>
      </main>
      <MobileBottomNav />
    </div>
  );
}
