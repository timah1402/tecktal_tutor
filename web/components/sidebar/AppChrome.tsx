"use client";

import { usePathname } from "next/navigation";
import AppSidebar from "@/components/sidebar/AppSidebar";
import MobileBottomNav from "@/components/sidebar/MobileBottomNav";
import CapabilityGate from "@/components/access/CapabilityGate";
import FeatureGate from "@/components/access/FeatureGate";

const BARE_PREFIXES = ["/login", "/register"];

export default function AppChrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
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
    // h-dvh, not h-screen: on mobile Safari 100vh includes the area behind
    // the browser's own toolbar, which pushed the composer under it.
    <div className="flex h-dvh overflow-hidden">
      <AppSidebar />
      {/* max-md:pb-14 keeps page content clear of the fixed bottom nav. */}
      <main className="flex-1 overflow-hidden bg-[var(--background)] max-md:pb-14">
        <FeatureGate>
          <CapabilityGate>{children}</CapabilityGate>
        </FeatureGate>
      </main>
      <MobileBottomNav />
    </div>
  );
}
