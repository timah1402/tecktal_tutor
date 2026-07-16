"use client";

import { usePathname } from "next/navigation";
import AppSidebar from "@/components/sidebar/AppSidebar";
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
    <div className="flex h-screen overflow-hidden">
      <AppSidebar />
      <main className="flex-1 overflow-hidden bg-[var(--background)]">
        <FeatureGate>
          <CapabilityGate>{children}</CapabilityGate>
        </FeatureGate>
      </main>
    </div>
  );
}
