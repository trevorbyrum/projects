"use client";

import { useState } from "react";
import { theme } from "@/lib/theme";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Dot,
  Input,
  PageHeader,
  Select,
  Toggle,
} from "@/components/ui/primitives";

const t = theme;

export default function SettingsPage() {
  const [section, setSection] = useState<"team" | "ai" | "security" | "billing" | "notifications">("team");

  return (
    <>
      <PageHeader title="Settings" description="Platform-wide configuration for your tenant." />

      <div style={{ display: "grid", gridTemplateColumns: "200px 1fr", gap: 18 }}>
        <nav style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {(
            [
              ["team", "Team / Org"],
              ["ai", "AI Platforms"],
              ["security", "Security"],
              ["billing", "Billing"],
              ["notifications", "Notifications"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setSection(key)}
              style={{
                textAlign: "left",
                padding: "8px 12px",
                fontSize: 13,
                background: section === key ? t.accentSubtle : "transparent",
                color: section === key ? t.accentText : t.fg2,
                fontWeight: section === key ? 500 : 400,
                border: "none",
                borderRadius: t.radius,
                cursor: "pointer",
                fontFamily: t.font,
              }}
            >
              {label}
            </button>
          ))}
        </nav>

        <div>
          {section === "team" && <TeamSection />}
          {section === "ai" && <AiSection />}
          {section === "security" && <SecuritySection />}
          {section === "billing" && <BillingSection />}
          {section === "notifications" && <NotificationsSection />}
        </div>
      </div>
    </>
  );
}

function TeamSection() {
  return (
    <Card padding={20}>
      <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0, marginBottom: 16, color: t.fg1 }}>Team / Organization</h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Input label="Organization name" defaultValue="Acme Inc." />
        <Input label="Primary contact email" type="email" defaultValue="ops@acme.com" />
        <Input label="Tenant ID" defaultValue="acme-prod-7f3a" monospace />
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Button variant="accent">Save changes</Button>
        </div>
      </div>
    </Card>
  );
}

function AiSection() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Card padding={20}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 14 }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 10,
              background: `oklch(0.18 0.04 ${t.hue})`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 700,
              fontSize: 18,
              color: t.accentSolid,
            }}
          >
            C
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: t.fg1 }}>Claude</div>
            <div style={{ fontSize: 12, color: t.fg3 }}>Anthropic's MCP directory</div>
          </div>
          <Badge variant="success">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <Dot variant="success" size={6} /> Listed
            </span>
          </Badge>
        </div>
        <KV label="OAuth status" value="Authorized" />
        <KV label="Directory entry" value="claude.ai/directory/arbytr" />
        <KV label="Server URL" value="https://gateway.arbytr.com/mcp/acme" mono />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 12 }}>
          <Button variant="ghost">Disconnect</Button>
          <Button variant="secondary">Re-authorize</Button>
        </div>
      </Card>

      <Card padding={20}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 10,
              background: t.subtleBg,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 700,
              fontSize: 18,
              color: t.fg3,
            }}
          >
            G
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: t.fg1 }}>ChatGPT</div>
            <div style={{ fontSize: 12, color: t.fg3 }}>OpenAI's connector directory</div>
          </div>
          <Badge>Coming soon</Badge>
        </div>
      </Card>
    </div>
  );
}

function SecuritySection() {
  return (
    <Card padding={20}>
      <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0, marginBottom: 4, color: t.fg1 }}>Security configuration</h3>
      <p style={{ fontSize: 12, color: t.fg3, margin: 0, marginBottom: 16 }}>Changes take effect immediately on the platform side.</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Select
          label="Certificate rotation interval"
          options={["12 hours", "24 hours (recommended)", "48 hours"]}
          defaultValue="24 hours (recommended)"
        />
        <Input label="Rate limit (requests / min / user)" defaultValue="120" type="number" />
        <Input label="Rate limit (requests / min / tenant)" defaultValue="2000" type="number" />
        <Select
          label="Anomaly detection sensitivity"
          options={["Off", "Low", "Medium", "High"]}
          defaultValue="Medium"
        />
        <SettingRow
          label="Auto-suspend on anomaly"
          desc="Pause tool calls automatically if anomaly detection fires."
          control={<Toggle checked onChange={() => {}} />}
        />
        <SettingRow
          label="Require re-auth for destructive tools"
          desc="Prompt the user in chat to re-authenticate before write operations."
          control={<Toggle checked={false} onChange={() => {}} />}
        />
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Button variant="accent">Save changes</Button>
        </div>
      </div>
    </Card>
  );
}

function BillingSection() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Card padding={20}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 11, color: t.fg3, textTransform: "uppercase", letterSpacing: "0.04em" }}>Current plan</div>
            <div style={{ fontSize: 22, fontWeight: 600, color: t.fg1, marginTop: 2 }}>Team</div>
            <div style={{ fontSize: 12, color: t.fg3, marginTop: 4 }}>$499/month — 25 seats, unlimited connections</div>
          </div>
          <Button variant="accent">Upgrade to Enterprise</Button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14, paddingTop: 14, borderTop: `1px solid ${t.border}` }}>
          <Usage label="Seats" used={7} cap={25} />
          <Usage label="Tool calls / month" used={31847} cap={100000} />
          <Usage label="Connections" used={8} cap={9999} unlimited />
        </div>
      </Card>

      <Card padding={20}>
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0, marginBottom: 12, color: t.fg1 }}>Payment method</h3>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div
            style={{
              padding: "8px 12px",
              borderRadius: 6,
              background: `oklch(0.10 0.003 ${t.hue})`,
              border: `1px solid ${t.borderSoft}`,
              fontFamily: t.fontMono,
              fontSize: 13,
            }}
          >
            •••• •••• •••• 4242
          </div>
          <div style={{ flex: 1, fontSize: 12, color: t.fg3 }}>Expires 09/2028 • Visa</div>
          <Button variant="ghost">Update</Button>
        </div>
      </Card>
    </div>
  );
}

function NotificationsSection() {
  return (
    <Card padding={20}>
      <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0, marginBottom: 16, color: t.fg1 }}>Alerts & notifications</h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <SettingRow label="Connection loss" desc="Notify when the WSS connection drops for more than 60 seconds." control={<Toggle checked onChange={() => {}} />} />
        <SettingRow label="Certificate rotation" desc="Notify on every cert rotation event." control={<Toggle checked={false} onChange={() => {}} />} />
        <SettingRow label="Anomaly detection" desc="Notify when anomaly detection fires for any tenant action." control={<Toggle checked onChange={() => {}} />} />
        <SettingRow label="Audit sink failure" desc="Notify when audit writes start failing." control={<Toggle checked onChange={() => {}} />} />
      </div>

      <div style={{ marginTop: 18, paddingTop: 16, borderTop: `1px solid ${t.border}` }}>
        <h4 style={{ fontSize: 13, fontWeight: 600, margin: 0, marginBottom: 10, color: t.fg1 }}>Channels</h4>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Checkbox checked onChange={() => {}} />
            <span style={{ fontSize: 13, color: t.fg1, width: 80 }}>Email</span>
            <Input defaultValue="ops@acme.com,oncall@acme.com" style={{ flex: 1 }} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Checkbox checked onChange={() => {}} />
            <span style={{ fontSize: 13, color: t.fg1, width: 80 }}>Webhook</span>
            <Input defaultValue="https://hooks.acme.com/arbytr/alerts" style={{ flex: 1 }} monospace />
          </div>
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
        <Button variant="accent">Save</Button>
      </div>
    </Card>
  );
}

function SettingRow({ label, desc, control }: { label: string; desc: string; control: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: `1px solid ${t.border}` }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, color: t.fg1, fontWeight: 500 }}>{label}</div>
        <div style={{ fontSize: 12, color: t.fg3, marginTop: 2 }}>{desc}</div>
      </div>
      {control}
    </div>
  );
}

function KV({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: "flex", padding: "6px 0", borderBottom: `1px solid ${t.border}` }}>
      <div style={{ width: 130, fontSize: 12, color: t.fg3 }}>{label}</div>
      <div style={{ flex: 1, fontSize: 12.5, color: t.fg1, fontFamily: mono ? t.fontMono : t.font }}>{value}</div>
    </div>
  );
}

function Usage({ label, used, cap, unlimited }: { label: string; used: number; cap: number; unlimited?: boolean }) {
  const pct = unlimited ? 0 : Math.min(100, (used / cap) * 100);
  return (
    <div>
      <div style={{ fontSize: 11, color: t.fg3, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 600, color: t.fg1, fontVariantNumeric: "tabular-nums", marginBottom: 6 }}>
        {used.toLocaleString()} <span style={{ color: t.fg3, fontWeight: 400 }}>{unlimited ? "/ ∞" : `/ ${cap.toLocaleString()}`}</span>
      </div>
      {!unlimited && (
        <div style={{ height: 4, background: t.subtleBg, borderRadius: 2, overflow: "hidden" }}>
          <div style={{ width: `${pct}%`, height: "100%", background: t.accentSolid }} />
        </div>
      )}
    </div>
  );
}
