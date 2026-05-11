"use client";

import Link from "next/link";
import { theme } from "@/lib/theme";
import {
  Badge,
  Button,
  Card,
  Dot,
  PageHeader,
  Stat,
} from "@/components/ui/primitives";
import { auditEvents, dashboardStats } from "@/lib/mock-data";

const t = theme;

export default function DashboardPage() {
  const s = dashboardStats;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="At-a-glance health of your Atomic Gateway."
        actions={
          <>
            <Link href="/connect/services">
              <Button variant="secondary">Connect a service</Button>
            </Link>
            <Link href="/access/users">
              <Button variant="accent">Invite user</Button>
            </Link>
          </>
        }
      />

      {/* Connection status card */}
      <Card padding={20} style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 12,
              background: `radial-gradient(circle, oklch(0.50 0.20 ${t.hue} / 0.35), transparent 70%)`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <div
              style={{
                width: 12,
                height: 12,
                borderRadius: "50%",
                background: t.accentSolid,
                boxShadow: `0 0 16px ${t.accentSolid}`,
              }}
            />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
              <span style={{ fontSize: 15, fontWeight: 600, color: t.fg1 }}>Gateway connected</span>
              <Badge variant="success">{s.connectionType}</Badge>
            </div>
            <div style={{ fontSize: 12.5, color: t.fg3 }}>
              Uptime <span style={{ color: t.fg2, fontVariantNumeric: "tabular-nums" }}>{s.uptime}</span>
              <span style={{ margin: "0 8px" }}>•</span>
              Certificate rotates in <span style={{ color: t.fg2 }}>27h 14m</span>
              <span style={{ margin: "0 8px" }}>•</span>
              <span style={{ color: t.fg2 }}>3</span> regions
            </div>
          </div>
          <Link href="/connect/proxy">
            <Button variant="ghost">View details →</Button>
          </Link>
        </div>
      </Card>

      {/* Stats row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, marginBottom: 20 }}>
        <Card padding={18}>
          <Stat label="Services" value={`${s.servicesActive} / ${s.servicesTotal}`} sub="all online" />
        </Card>
        <Card padding={18}>
          <Stat
            label="Connectors"
            value={`${s.connectorsActive} / ${s.connectorsTotal}`}
            sub={s.connectorsActive < s.connectorsTotal ? "1 disconnected" : "all connected"}
          />
        </Card>
        <Card padding={18}>
          <Stat label="Users" value={s.usersActive} sub="active this week" />
        </Card>
        <Card padding={18}>
          <Stat label="Tools" value={`${s.toolsEnabled} / ${s.toolsTotal}`} sub="enabled / total" />
        </Card>
      </div>

      {/* Call volume + activity */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 20 }}>
        <Card padding={20}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0, color: t.fg1 }}>Tool call volume</h3>
            <span style={{ fontSize: 11, color: t.fg3 }}>last 30 days</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 18 }}>
            <Stat label="Today" value={s.callsToday.toLocaleString()} sub="+18% vs avg" />
            <Stat label="This week" value={s.callsWeek.toLocaleString()} />
            <Stat label="This month" value={s.callsMonth.toLocaleString()} />
          </div>
          <MiniChart />
        </Card>

        <Card padding={20}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0, color: t.fg1 }}>Recent activity</h3>
            <Link href="/security/audit" style={{ fontSize: 12, color: t.accentText }}>
              View audit log →
            </Link>
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {auditEvents.slice(0, 6).map((ev, i) => (
              <div
                key={ev.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 0",
                  borderBottom: i < 5 ? `1px solid ${t.border}` : "none",
                }}
              >
                <Dot variant={ev.status === "success" ? "success" : "error"} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, color: t.fg1, fontWeight: 500 }}>
                    {ev.userName} <span style={{ color: t.fg3, fontWeight: 400 }}>called</span>{" "}
                    <span style={{ fontFamily: t.fontMono, color: t.accentText }}>{ev.toolName}</span>
                  </div>
                  <div style={{ fontSize: 11, color: t.fg3, marginTop: 1 }}>{ev.source}</div>
                </div>
                <div style={{ fontSize: 11, color: t.fg3, fontVariantNumeric: "tabular-nums" }}>{ev.timestamp}</div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Quick actions */}
      <Card padding={20}>
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0, marginBottom: 14, color: t.fg1 }}>Quick actions</h3>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
          <QuickAction href="/connect/services" title="Connect a service" desc="Wrap infrastructure as MCP tools" />
          <QuickAction href="/connect/connectors" title="Add a connector" desc="Pull in a third-party MCP server" />
          <QuickAction href="/access/profiles" title="Create role profile" desc="Bundle tools into access packages" />
          <QuickAction href="/security/vault" title="Store credential" desc="Bind a secret to a tool tuple" />
        </div>
      </Card>
    </>
  );
}

function MiniChart() {
  // simple bar chart from deterministic mock values
  const bars = [42, 58, 51, 70, 64, 88, 74, 91, 80, 96, 85, 102, 110, 95, 130, 118, 124, 140, 132, 156, 145, 168, 152, 174, 165, 188, 195, 182, 210, 224];
  const max = Math.max(...bars);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 70 }}>
      {bars.map((v, i) => (
        <div
          key={i}
          style={{
            flex: 1,
            height: `${(v / max) * 100}%`,
            background:
              i === bars.length - 1
                ? t.accentSolid
                : i > bars.length - 4
                ? `oklch(0.50 0.18 ${t.hue} / 0.7)`
                : `oklch(0.35 0.08 ${t.hue} / 0.7)`,
            borderRadius: 1,
            minHeight: 2,
          }}
        />
      ))}
    </div>
  );
}

function QuickAction({ href, title, desc }: { href: string; title: string; desc: string }) {
  return (
    <Link href={href} style={{ textDecoration: "none" }}>
      <div
        style={{
          padding: 14,
          borderRadius: t.radius,
          border: `1px solid ${t.borderSoft}`,
          background: `oklch(0.10 0.003 ${t.hue})`,
          cursor: "pointer",
          transition: "all 150ms",
          height: "100%",
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 500, color: t.fg1, marginBottom: 4 }}>{title}</div>
        <div style={{ fontSize: 11.5, color: t.fg3, lineHeight: 1.4 }}>{desc}</div>
      </div>
    </Link>
  );
}
