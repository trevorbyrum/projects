"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ReactNode, useState } from "react";
import { theme } from "@/lib/theme";
import { Logo } from "@/components/brand/Logo";
import { Badge, Dot } from "@/components/ui/primitives";

type NavItem = {
  href?: string;
  label: string;
  icon: ReactNode;
  badge?: string;
  children?: { href: string; label: string }[];
};

const t = theme;

function Icon({ d, size = 16 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

const ICONS = {
  dashboard: <Icon d="M3 12L12 3l9 9M5 10v10h14V10" />,
  connect: <Icon d="M9 12h6m-3-3v6M5 5h4v4H5zm10 10h4v4h-4z" />,
  services: <Icon d="M4 6h16M4 12h16M4 18h16" />,
  connectors: <Icon d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />,
  tools: <Icon d="M14.7 6.3a4 4 0 0 1-5.6 5.6l-6.4 6.4a2 2 0 0 0 2.8 2.8l6.4-6.4a4 4 0 0 1 5.6-5.6l-2.6 2.6 2.4 2.4 2.6-2.6a4 4 0 0 0-5.2-5.2z" />,
  proxy: <Icon d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />,
  access: <Icon d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />,
  users: <Icon d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M10 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" />,
  profiles: <Icon d="M20 21v-2a4 4 0 0 0-3-3.87M4 21v-2a4 4 0 0 1 3-3.87M16 3.13a4 4 0 0 1 0 7.75M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" />,
  permissions: <Icon d="M9 12l2 2 4-4m6 2a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" />,
  security: <Icon d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
  vault: <Icon d="M5 11h14a2 2 0 0 1 2 2v7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-7a2 2 0 0 1 2-2zM7 11V7a5 5 0 0 1 10 0v4" />,
  audit: <Icon d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h6M10 9H8" />,
  settings: <Icon d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />,
  chevron: <Icon d="M9 6l6 6-6 6" size={12} />,
};

const NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: ICONS.dashboard },
  {
    label: "Connect",
    icon: ICONS.connect,
    children: [
      { href: "/connect/services", label: "Services" },
      { href: "/connect/connectors", label: "Connectors" },
      { href: "/connect/tools", label: "Tools" },
      { href: "/connect/proxy", label: "Proxy / Connection" },
    ],
  },
  {
    label: "Access",
    icon: ICONS.access,
    children: [
      { href: "/access/users", label: "Users" },
      { href: "/access/profiles", label: "Role Profiles" },
      { href: "/access/permissions", label: "Permissions" },
    ],
  },
  {
    label: "Security",
    icon: ICONS.security,
    children: [
      { href: "/security/vault", label: "Vault" },
      { href: "/security/audit", label: "Audit Log" },
    ],
  },
  { href: "/settings", label: "Settings", icon: ICONS.settings },
];

export function Sidebar() {
  const pathname = usePathname();
  const initiallyOpen = NAV.filter((n) => n.children?.some((c) => pathname.startsWith(c.href))).map((n) => n.label);
  const [open, setOpen] = useState<string[]>(initiallyOpen.length ? initiallyOpen : ["Connect"]);

  const toggle = (label: string) =>
    setOpen((cur) => (cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]));

  return (
    <aside
      style={{
        width: 240,
        flexShrink: 0,
        background: `oklch(0.09 0.003 ${t.hue})`,
        borderRight: `1px solid ${t.border}`,
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        position: "sticky",
        top: 0,
      }}
    >
      {/* logo */}
      <div
        style={{
          padding: "16px 18px",
          borderBottom: `1px solid ${t.border}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <Logo size={20} />
        <Badge variant="default" style={{ fontSize: 9 }}>
          BETA
        </Badge>
      </div>

      {/* connection status mini */}
      <div
        style={{
          padding: "12px 18px",
          borderBottom: `1px solid ${t.border}`,
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 12,
          color: t.fg2,
        }}
      >
        <Dot variant="success" />
        <span style={{ flex: 1 }}>Gateway online</span>
        <span style={{ color: t.fg3, fontSize: 11, fontVariantNumeric: "tabular-nums" }}>14d</span>
      </div>

      {/* nav */}
      <nav style={{ flex: 1, padding: "10px 8px", overflowY: "auto" }}>
        {NAV.map((item) => {
          const isOpen = open.includes(item.label);
          const isActive = item.href
            ? pathname === item.href
            : item.children?.some((c) => pathname.startsWith(c.href));

          if (item.children) {
            return (
              <div key={item.label} style={{ marginBottom: 2 }}>
                <button
                  onClick={() => toggle(item.label)}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "7px 10px",
                    borderRadius: t.radius,
                    background: "transparent",
                    border: "none",
                    color: isActive ? t.fg1 : t.fg2,
                    fontSize: 13,
                    fontWeight: isActive ? 500 : 400,
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  <span style={{ color: isActive ? t.accentSolid : t.fg3 }}>{item.icon}</span>
                  <span style={{ flex: 1 }}>{item.label}</span>
                  <span
                    style={{
                      color: t.fg3,
                      transition: "transform 150ms",
                      transform: isOpen ? "rotate(90deg)" : "rotate(0deg)",
                      display: "inline-flex",
                    }}
                  >
                    {ICONS.chevron}
                  </span>
                </button>
                {isOpen && (
                  <div style={{ marginLeft: 22, marginTop: 2, paddingLeft: 10, borderLeft: `1px solid ${t.border}` }}>
                    {item.children.map((c) => {
                      const childActive = pathname === c.href || pathname.startsWith(c.href + "/");
                      return (
                        <Link
                          key={c.href}
                          href={c.href}
                          style={{
                            display: "block",
                            padding: "6px 10px",
                            fontSize: 12.5,
                            color: childActive ? t.accentText : t.fg2,
                            fontWeight: childActive ? 500 : 400,
                            background: childActive ? t.accentSubtle : "transparent",
                            borderRadius: t.radius,
                            margin: "1px 0",
                          }}
                        >
                          {c.label}
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          }

          return (
            <Link
              key={item.href}
              href={item.href!}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "7px 10px",
                borderRadius: t.radius,
                color: isActive ? t.fg1 : t.fg2,
                background: isActive ? t.accentSubtle : "transparent",
                fontSize: 13,
                fontWeight: isActive ? 500 : 400,
                marginBottom: 2,
              }}
            >
              <span style={{ color: isActive ? t.accentSolid : t.fg3 }}>{item.icon}</span>
              <span style={{ flex: 1 }}>{item.label}</span>
              {item.badge && <Badge variant="accent">{item.badge}</Badge>}
            </Link>
          );
        })}
      </nav>

      {/* footer */}
      <div
        style={{
          padding: "12px 18px",
          borderTop: `1px solid ${t.border}`,
          fontSize: 11,
          color: t.fg3,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span>v0.4.2</span>
        <a href="#" style={{ color: t.fg3 }}>
          Docs
        </a>
      </div>
    </aside>
  );
}
