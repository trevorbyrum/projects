"use client";

import { useState } from "react";
import { theme } from "@/lib/theme";
import {
  Badge,
  Button,
  Card,
  Dot,
  Input,
  Modal,
  PageHeader,
  Select,
} from "@/components/ui/primitives";
import { connectors as initial, Connector } from "@/lib/mock-data";

const t = theme;

const directoryOptions = [
  "GitHub",
  "Linear",
  "Slack",
  "Notion",
  "Figma",
  "Jira Cloud",
  "Asana",
  "Sentry",
  "PagerDuty",
  "Stripe",
];

export default function ConnectorsPage() {
  const [list, setList] = useState<Connector[]>(initial);
  const [modalOpen, setModalOpen] = useState(false);

  const remove = (id: string) => {
    if (typeof window !== "undefined" && !window.confirm("Remove this connector? Role profiles bound to it will lose access.")) return;
    setList((cur) => cur.filter((c) => c.id !== id));
  };

  return (
    <>
      <PageHeader
        title="Connectors"
        description="Third-party MCP servers and OpenAPI specs routed through the platform."
        actions={<Button variant="accent" onClick={() => setModalOpen(true)}>+ Add connector</Button>}
      />

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {list.map((c) => (
          <ConnectorRow key={c.id} c={c} onRemove={() => remove(c.id)} />
        ))}
      </div>

      {modalOpen && (
        <AddConnectorModal
          onClose={() => setModalOpen(false)}
          onAdd={(c) => setList((cur) => [c, ...cur])}
        />
      )}
    </>
  );
}

function ConnectorRow({ c, onRemove }: { c: Connector; onRemove: () => void }) {
  const sourceLabel: Record<string, string> = {
    directory: "Directory",
    custom: "Custom URL",
    openapi: "OpenAPI spec",
  };
  const authLabel: Record<string, string> = {
    oauth: "OAuth",
    "api-key": "API key",
    none: "No auth",
  };
  return (
    <Card padding={18}>
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: 10,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: c.status === "connected" ? `oklch(0.18 0.04 ${t.hue})` : t.subtleBg,
            border: `1px solid ${t.borderSoft}`,
            flexShrink: 0,
            fontSize: 16,
            fontWeight: 600,
            color: c.status === "connected" ? t.accentSolid : t.fg3,
            fontFamily: t.font,
          }}
        >
          {c.name.charAt(0).toUpperCase()}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: t.fg1 }}>{c.name}</span>
            <Badge variant={c.status === "connected" ? "success" : "error"}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                <Dot variant={c.status === "connected" ? "success" : "error"} size={6} />
                {c.status}
              </span>
            </Badge>
            <Badge>{sourceLabel[c.source]}</Badge>
            <Badge>{authLabel[c.auth]}</Badge>
          </div>
          <div style={{ fontSize: 12, color: t.fg3 }}>
            {c.url ? <span style={{ fontFamily: t.fontMono, color: t.fg2 }}>{c.url}</span> : <>Directory-listed</>}
            <span style={{ margin: "0 6px" }}>•</span>
            <span style={{ color: t.fg2 }}>{c.toolCount}</span> tools
            <span style={{ margin: "0 6px" }}>•</span>
            last activity {c.lastActivity}
          </div>
        </div>

        <div style={{ display: "flex", gap: 6 }}>
          <Button variant="ghost">Configure</Button>
          {c.status === "disconnected" && <Button variant="secondary">Reconnect</Button>}
          <Button variant="ghost" onClick={onRemove} style={{ color: t.error }}>Remove</Button>
        </div>
      </div>
    </Card>
  );
}

function AddConnectorModal({ onClose, onAdd }: { onClose: () => void; onAdd: (c: Connector) => void }) {
  const [type, setType] = useState<"directory" | "custom" | "openapi">("directory");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [auth, setAuth] = useState<"oauth" | "api-key" | "none">("oauth");

  const canSubmit = type === "directory" ? !!name : !!name && !!url;

  const handleAdd = () => {
    onAdd({
      id: `con-${Date.now()}`,
      name,
      source: type,
      url: url || undefined,
      status: "connected",
      toolCount: Math.floor(Math.random() * 8) + 3,
      lastActivity: "Just now",
      auth,
    });
    onClose();
  };

  return (
    <Modal title="Add connector" onClose={onClose} width={520}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 500, color: t.fg2, marginBottom: 6 }}>Source</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
            <SourceOption active={type === "directory"} onClick={() => setType("directory")} title="Directory" desc="Browse the Arbytr catalog" />
            <SourceOption active={type === "custom"} onClick={() => setType("custom")} title="Custom URL" desc="Connect a hosted MCP server" />
            <SourceOption active={type === "openapi"} onClick={() => setType("openapi")} title="OpenAPI" desc="Auto-wrap a REST API spec" />
          </div>
        </div>

        {type === "directory" ? (
          <Select
            label="Connector"
            options={[{ label: "Choose a connector…", value: "" }, ...directoryOptions.map((o) => ({ label: o, value: o }))]}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        ) : (
          <>
            <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder={type === "openapi" ? "e.g. Acme CRM" : "e.g. Internal Tools MCP"} />
            <Input
              label={type === "openapi" ? "OpenAPI URL" : "MCP server URL"}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={type === "openapi" ? "https://api.acme.internal/openapi.json" : "wss://mcp.example.com/sse"}
              monospace
            />
          </>
        )}

        <Select
          label="Authentication"
          options={[
            { label: "OAuth 2.0", value: "oauth" },
            { label: "API key", value: "api-key" },
            { label: "No auth", value: "none" },
          ]}
          value={auth}
          onChange={(e) => setAuth(e.target.value as typeof auth)}
        />

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="accent" onClick={handleAdd} disabled={!canSubmit}>Connect</Button>
        </div>
      </div>
    </Modal>
  );
}

function SourceOption({ active, onClick, title, desc }: { active: boolean; onClick: () => void; title: string; desc: string }) {
  return (
    <div
      onClick={onClick}
      style={{
        padding: 10,
        borderRadius: t.radius,
        border: `1.5px solid ${active ? t.accentSolid : t.borderSoft}`,
        background: active ? t.accentSubtle : `oklch(0.10 0.003 ${t.hue})`,
        cursor: "pointer",
        transition: "all 150ms",
      }}
    >
      <div style={{ fontSize: 12.5, fontWeight: 500, color: active ? t.accentText : t.fg1, marginBottom: 2 }}>{title}</div>
      <div style={{ fontSize: 11, color: t.fg3, lineHeight: 1.4 }}>{desc}</div>
    </div>
  );
}
