"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { theme } from "@/lib/theme";
import { Avatar, Badge, Input } from "@/components/ui/primitives";
import { Session, signOut } from "@/lib/auth";

const t = theme;

export function Topbar({ session }: { session: Session }) {
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const handleSignOut = () => {
    signOut();
    router.push("/login");
  };

  return (
    <header
      style={{
        height: 56,
        flexShrink: 0,
        borderBottom: `1px solid ${t.border}`,
        background: `oklch(0.08 0.002 ${t.hue})`,
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "0 22px",
        position: "sticky",
        top: 0,
        zIndex: 10,
      }}
    >
      {/* search */}
      <div style={{ flex: 1, maxWidth: 380, position: "relative" }}>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke={t.fg3}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }}
        >
          <circle cx="11" cy="11" r="8" />
          <path d="M21 21l-4.35-4.35" />
        </svg>
        <Input placeholder="Search tools, users, audit events…" style={{ paddingLeft: 30, fontSize: 12.5 }} />
      </div>

      <div style={{ flex: 1 }} />

      {/* env switcher */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 12,
          color: t.fg2,
          padding: "5px 10px",
          borderRadius: t.radius,
          border: `1px solid ${t.borderSoft}`,
          background: `oklch(0.10 0.003 ${t.hue})`,
        }}
      >
        <span style={{ color: t.fg3 }}>Tenant</span>
        <span style={{ color: t.fg1, fontWeight: 500 }}>{session.org}</span>
      </div>

      {/* plan badge */}
      <Badge variant="accent">Team plan</Badge>

      {/* notifications */}
      <button
        style={{
          background: "transparent",
          border: "none",
          color: t.fg2,
          cursor: "pointer",
          padding: 6,
          position: "relative",
        }}
        title="Notifications"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        <span
          style={{
            position: "absolute",
            top: 4,
            right: 4,
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: t.accentSolid,
          }}
        />
      </button>

      {/* user menu */}
      <div ref={ref} style={{ position: "relative" }}>
        <button
          onClick={() => setMenuOpen((o) => !o)}
          style={{
            background: "transparent",
            border: "none",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: 4,
            borderRadius: t.radius,
          }}
        >
          <Avatar initials={session.initials} size={28} />
          <div style={{ textAlign: "left", lineHeight: 1.2 }}>
            <div style={{ fontSize: 12, fontWeight: 500, color: t.fg1 }}>{session.name}</div>
            <div style={{ fontSize: 10.5, color: t.fg3 }}>Admin</div>
          </div>
        </button>
        {menuOpen && (
          <div
            style={{
              position: "absolute",
              top: "100%",
              right: 0,
              marginTop: 6,
              width: 200,
              borderRadius: t.radiusLg,
              padding: 4,
              background: `oklch(0.11 0.004 ${t.hue})`,
              border: `1px solid ${t.border}`,
              boxShadow: `0 8px 24px rgba(0,0,0,0.5)`,
              zIndex: 50,
            }}
          >
            <div style={{ padding: "8px 10px", borderBottom: `1px solid ${t.border}`, marginBottom: 4 }}>
              <div style={{ fontSize: 12, fontWeight: 500, color: t.fg1 }}>{session.name}</div>
              <div style={{ fontSize: 11, color: t.fg3 }}>{session.email}</div>
            </div>
            <MenuItem label="Account settings" />
            <MenuItem label="API keys" />
            <MenuItem label="Switch organization" />
            <div style={{ height: 1, background: t.border, margin: "4px 0" }} />
            <MenuItem label="Sign out" onClick={handleSignOut} danger />
          </div>
        )}
      </div>
    </header>
  );
}

function MenuItem({ label, onClick, danger }: { label: string; onClick?: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: "100%",
        textAlign: "left",
        padding: "7px 10px",
        fontSize: 13,
        color: danger ? t.error : t.fg1,
        background: "transparent",
        border: "none",
        cursor: "pointer",
        borderRadius: t.radius,
        fontWeight: danger ? 500 : 400,
        fontFamily: t.font,
      }}
    >
      {label}
    </button>
  );
}
