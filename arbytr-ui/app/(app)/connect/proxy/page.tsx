"use client";

import { theme } from "@/lib/theme";
import { Badge, Card, Dot, PageHeader, Stat } from "@/components/ui/primitives";

const t = theme;

export default function ProxyPage() {
  const events: { ts: string; type: "connected" | "disconnected" | "rotation"; detail: string }[] = [
    { ts: "May 11 01:18", type: "rotation", detail: "Certificate auto-rotated. New fingerprint: a7:f3:9c:21:…" },
    { ts: "May 10 01:17", type: "rotation", detail: "Certificate auto-rotated. New fingerprint: 4b:e8:12:fd:…" },
    { ts: "Apr 27 18:42", type: "connected", detail: "Client reconnected after restart (planned)" },
    { ts: "Apr 27 18:41", type: "disconnected", detail: "Connection closed cleanly by client" },
    { ts: "Apr 14 09:03", type: "connected", detail: "Initial WSS handshake established" },
  ];

  return (
    <>
      <PageHeader
        title="Proxy / Connection"
        description="Status of the persistent connection between the Arbytr Client and the Platform."
      />

      {/* Hero status */}
      <Card padding={24} style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
          <div
            style={{
              width: 72,
              height: 72,
              borderRadius: "50%",
              background: `radial-gradient(circle, oklch(0.50 0.20 ${t.hue} / 0.4), transparent 70%)`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <div
              style={{
                width: 16,
                height: 16,
                borderRadius: "50%",
                background: t.accentSolid,
                boxShadow: `0 0 22px ${t.accentSolid}`,
              }}
            />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
              <span style={{ fontSize: 17, fontWeight: 600, color: t.fg1 }}>Connected</span>
              <Badge variant="success">WSS + mTLS</Badge>
              <Badge>Primary region: us-east-1</Badge>
            </div>
            <div style={{ fontSize: 13, color: t.fg3, lineHeight: 1.6 }}>
              Continuously online for <span style={{ color: t.fg1, fontWeight: 500 }}>14d 3h 42m</span>.<br />
              Next cert rotation in <span style={{ color: t.fg1, fontWeight: 500 }}>27h 14m</span>.
            </div>
          </div>
        </div>
      </Card>

      {/* Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 16 }}>
        <Card padding={18}><Stat label="Latency p50" value="38ms" /></Card>
        <Card padding={18}><Stat label="Latency p95" value="84ms" /></Card>
        <Card padding={18}><Stat label="Requests / min" value="142" sub="last 5 min" /></Card>
        <Card padding={18}><Stat label="Errors" value="0" sub="last 24h" /></Card>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 14 }}>
        {/* Certificate */}
        <Card padding={20}>
          <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0, marginBottom: 14, color: t.fg1 }}>
            Mutual TLS certificate
          </h3>
          <KV label="Issuer" value="Arbytr Internal CA" />
          <KV label="Subject" value="CN=acme.tenant.arbytr.com" />
          <KV label="Fingerprint" value="a7:f3:9c:21:48:e8:0b:14:6d:5a:c2:fb:7e:91:33:0f" mono />
          <KV label="Valid from" value="May 11, 2026 01:18 UTC" />
          <KV label="Valid until" value="May 12, 2026 01:18 UTC" />
          <KV label="Rotation interval" value="24 hours (auto)" />
        </Card>

        {/* Connection history */}
        <Card padding={20}>
          <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0, marginBottom: 14, color: t.fg1 }}>
            Connection history
          </h3>
          {events.map((ev, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                padding: "8px 0",
                borderBottom: i < events.length - 1 ? `1px solid ${t.border}` : "none",
              }}
            >
              <Dot
                variant={
                  ev.type === "connected" ? "success" : ev.type === "disconnected" ? "error" : "accent"
                }
                size={6}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, color: t.fg1, fontWeight: 500 }}>
                  {ev.type === "connected" ? "Connected" : ev.type === "disconnected" ? "Disconnected" : "Cert rotation"}
                </div>
                <div style={{ fontSize: 11.5, color: t.fg3, marginTop: 1, lineHeight: 1.4 }}>{ev.detail}</div>
              </div>
              <div style={{ fontSize: 11, color: t.fg3, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{ev.ts}</div>
            </div>
          ))}
        </Card>
      </div>

      {/* Fallback section */}
      <Card padding={20} style={{ marginTop: 14 }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0, marginBottom: 6, color: t.fg1 }}>Fallback transport</h3>
        <p style={{ fontSize: 12.5, color: t.fg3, margin: 0, marginBottom: 12, lineHeight: 1.5 }}>
          If the primary WebSocket connection cannot be established, Arbytr automatically negotiates a fallback.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
          <FallbackCard
            title="WSS + mTLS"
            badge="Active"
            badgeVariant="success"
            desc="Outbound persistent socket from the customer side. No inbound ports required."
          />
          <FallbackCard
            title="Webhook callback"
            badge="Available"
            desc="Platform calls a customer-published HTTPS endpoint with HMAC signatures."
          />
          <FallbackCard
            title="Long polling"
            badge="Available"
            desc="HTTPS-only polling for restrictive networks. Universal compatibility."
          />
        </div>
      </Card>
    </>
  );
}

function KV({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: "flex", gap: 16, padding: "7px 0", borderBottom: `1px solid ${t.border}` }}>
      <div style={{ width: 140, fontSize: 12, color: t.fg3 }}>{label}</div>
      <div style={{ flex: 1, fontSize: 12.5, color: t.fg1, fontFamily: mono ? t.fontMono : t.font, wordBreak: "break-all" }}>{value}</div>
    </div>
  );
}

function FallbackCard({ title, badge, badgeVariant, desc }: { title: string; badge: string; badgeVariant?: "success"; desc: string }) {
  return (
    <div
      style={{
        padding: 14,
        borderRadius: t.radius,
        border: `1px solid ${t.borderSoft}`,
        background: `oklch(0.10 0.003 ${t.hue})`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 500, color: t.fg1 }}>{title}</span>
        <Badge variant={badgeVariant || "default"}>{badge}</Badge>
      </div>
      <div style={{ fontSize: 11.5, color: t.fg3, lineHeight: 1.5 }}>{desc}</div>
    </div>
  );
}
