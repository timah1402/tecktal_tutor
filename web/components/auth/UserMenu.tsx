"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, LogOut, ShieldCheck, User } from "lucide-react";
import { useTranslation } from "react-i18next";
import { fetchAuthStatus, logout, type AuthStatus } from "@/lib/auth";
import { UserAvatar } from "@/components/UserAvatar";

interface UserMenuProps {
  collapsed?: boolean;
}

/**
 * Single sidebar-footer entry point for account actions — avatar + username
 * button that opens a small menu (profile / admin / sign out) instead of
 * three separate always-visible rows (ProfileLink/AdminLink/LogoutButton).
 */
export function UserMenu({ collapsed = false }: UserMenuProps) {
  const router = useRouter();
  const { t } = useTranslation();
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchAuthStatus().then((next) => {
      // Only surface the menu when auth is on AND the user is signed in.
      if (next?.enabled && next?.authenticated) setStatus(next);
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current && !rootRef.current.contains(target)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  if (!status?.username) return null;

  const isAdmin = status.role === "admin";

  const handleLogout = async () => {
    setOpen(false);
    await logout();
    router.replace("/login");
  };

  const avatar = (
    <UserAvatar
      username={status.username}
      userId={status.user_id}
      avatar={status.avatar}
      role={status.role}
      size={collapsed ? 18 : 16}
    />
  );

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-label={t("Account menu")}
        aria-expanded={open}
        title={status.username}
        className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[13.5px] transition-colors ${
          open
            ? "bg-[var(--muted)]/70 text-[var(--foreground)]"
            : "text-[var(--muted-foreground)] hover:bg-[var(--background)]/50 hover:text-[var(--foreground)]"
        }`}
      >
        {avatar}
        {!collapsed && (
          <span className="min-w-0 flex-1 truncate text-left">
            {status.username}
          </span>
        )}
        {!collapsed && (
          <ChevronDown
            size={13}
            className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          />
        )}
      </button>

      {open && (
        <div className="dt-popup-up absolute inset-x-0 bottom-full z-50 mb-1.5 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--popover)] shadow-lg backdrop-blur-md">
          <Link
            href="/profile"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 px-3 py-2 text-[13px] text-[var(--foreground)] transition-colors hover:bg-[var(--muted)]/55"
          >
            <User size={15} strokeWidth={1.7} />
            <span>{t("My profile")}</span>
          </Link>
          {isAdmin && (
            <Link
              href="/admin/users"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2.5 px-3 py-2 text-[13px] text-[var(--foreground)] transition-colors hover:bg-[var(--muted)]/55"
            >
              <ShieldCheck size={15} strokeWidth={1.7} />
              <span>{t("Admin")}</span>
            </Link>
          )}
          <button
            type="button"
            onClick={handleLogout}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)]/55 hover:text-red-500"
          >
            <LogOut size={15} strokeWidth={1.7} />
            <span>{t("Sign out")}</span>
          </button>
        </div>
      )}
    </div>
  );
}
