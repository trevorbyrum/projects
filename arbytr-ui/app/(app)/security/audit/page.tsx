"use client";

import { useMemo, useState } from "react";
import { theme } from "@/lib/theme";
import {
  Alert,
  Badge,
  Button,
  Card,
  Code,
  Dot,
  Input,
  Modal,
  PageHeader,
  Segmented,
  Select,
} from "@/components/ui/primitives";
import { AuditEvent, auditEvents, users } from "@/lib/mock-data";

const t = theme;

type RedactMode = "show" | "redact" | "hide";

export default function AuditPage() {
  const [search, setSearch] = useState("");
  const [userFilter, setUserFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState(0); // 0 all, 1 success, 2 failure
  const [redact, setRedact] = useState<RedactMode>("redact");
  const [expanded, setExpanded] = useState<AuditEvent | null>(null);
  const [sinkOpen, setSinkOpen] = useState(false);

  const sources = useMemo(() => Array.from(new Set(auditEvents.map((e) => e.source))), []);
  const [sourceFilter, setSourceFilter] = useState("all");

  const filtered = useMemo(() => {
    return auditEvents.filter((e) => {
      if (userFilter !== "all" && e.userId !== userFilter) return false;
      if (sourceFilter !== "all" && e.source !== sourceFilter) return false;
      if (statusFilter === 1 && e.status !== "success") return false;
      if (statusFilter === 2 && e.status !== "failure") return false;
      if (search) {
        const s = search.toLowerCase();
        if (
          !e.toolName.toLowerCase().includes(s) &&
          !e.userName.toLowerCase().includes(s) &&
          !e.source.toLowerCase().includes(s) &&
          !JSON.stringify(e.params).toLowerCase().includes(s)
        )
          return false;
      }
      return true;
    });
  }, [search, userFilter, sourceFilter, statusFilter]);

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every tool call, streamed to your customer-owned database. Arbytr stores nothing."
        actions={
          <>
            <Button variant="secondary">Export</Button>
            <Button variant="ghost" onClick={() => setSinkOpen(true)}>Audit sink</Button>
          </>
        }
      />

      {/* Sink status */}
      <Card padding={14} style={{ marginBottom: 14, display: "flex", alignItems: "center", gap: 12 }}>
        <Dot variant="success" />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, color: t.fg1 }}>
            Streaming to <span style={{ fontFamily: t.fontMono, color: t.accentText }}>postgres://audit.acme.internal/arbytr_audit</span>
          </div>
          <div style={{ fontSize: 11.5, color: t.fg3, marginTop: 2 }}>
            Last successful write: 4 seconds ago • Queue depth: 0
          </div>
        </div>
        <Button variant="ghost" onClick={() => setSinkOpen(true)}>Configure</Button>
      </Card>

      {/* Filters */}
      <Card padding={14} style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <Input
              placeholder="Search by tool, user, params…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Select
            label="User"
            options={[{ label: "All users", value: "all" }, ...users.map((u) => ({ label: u.name, value: u.id }))]}
            value={userFilter}
            onChange={(e) => setUserFilter(e.target.value)}
          />
          <Select
            label="Source"
            options={[{ label: "All sources", value: "all" }, ...sources.map((s) => ({ label: s, value: s }))]}
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
          />
          <div>
            <div style={{ fontSize: 12, color: t.fg2, marginBottom: 4, fontWeight: 500 }}>Status</div>
            <Segmented items={["All", "Success", "Failure"]} active={statusFilter} onChange={setStatusFilter} />
          </div>
          <div>
            <div style={{ fontSize: 12, color: t.fg2, marginBottom: 4, fontWeight: 500 }}>Params</div>
            <Segmented
              items={["Show", "Redact", "Hide"]}
              active={redact === "show" ? 0 : redact === "redact" ? 1 : 2}
              onChange={(i) => setRedact(i === 0 ? "show" : i === 1 ? "redact" : "hide")}
            />
          </div>
        </div>
      </Card>

      {/* Event stream */}
      <Card padding={0} style={{ overflow: "hidden" }}>
        {filtered.map((e, i) => (
          <div
            key={e.id}
            onClick={() => setExpanded(e)}
            style={{
              display: "grid",
              gridTemplateColumns: "180px 1fr 200px 120px 80px 80px",
              padding: "12px 16px",
              borderBottom: i < filtered.length - 1 ? `1px solid ${t.border}` : "none",
              alignItems: "center",
              gap: 10,
              cursor: "pointer",
            }}
          >
            <div style={{ fontSize: 11.5, color: t.fg3, fontVariantNumeric: "tabular-nums" }}>{e.timestamp}</div>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 500, color: t.fg1 }}>{e.userName}</span>
                <span style={{ fontSize: 12, color: t.fg3 }}>called</span>
                <span style={{ fontSize: 12.5, color: t.accentText, fontFamily: t.fontMono }}>{e.toolName}</span>
              </div>
              {redact !== "hide" && Object.keys(e.params).length > 0 && (
                <div
                  style={{
                    fontSize: 11.5,
                    color: t.fg3,
                    marginTop: 3,
                    fontFamily: t.fontMono,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    maxWidth: 520,
                  }}
                >
                  {renderParams(e.params, redact)}
                </div>
              )}
            </div>
            <div style={{ fontSize: 12, color: t.fg2 }}>{e.source}</div>
            <div>
              <Badge variant={e.status === "success" ? "success" : "error"}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                  <Dot variant={e.status === "success" ? "success" : "error"} size={6} />
                  {e.status}
                </span>
              </Badge>
            </div>
            <div style={{ fontSize: 12, color: t.fg3, fontVariantNumeric: "tabular-nums", textAlign: "right" }}>{e.duration}ms</div>
            <Button variant="ghost">Details →</Button>
          </div>
        ))}
        {filtered.length === 0 && (
          <div style={{ padding: 48, textAlign: "center", color: t.fg3, fontSize: 13 }}>
            No events match these filters.
          </div>
        )}
      </Card>

      <div style={{ fontSize: 11, color: t.fg3, marginTop: 12 }}>
        Showing {filtered.length} of {auditEvents.length} events •{" "}
        Audit data lives in your database, not ours.
      </div>

      {expanded && <EventModal event={expanded} onClose={() => setExpanded(null)} redact={redact} />}
      {sinkOpen && <SinkModal onClose={() => setSinkOpen(false)} />}
    </>
  );
}

function renderParams(p: Record<string, string>, mode: RedactMode): string {
  if (mode === "hide") return "";
  const entries = Object.entries(p);
  if (entries.length === 0) return "—";
  return entries
    .map(([k, v]) => `${k}=${mode === "redact" ? "•••••" : v}`)
    .join(" ");
}

function EventModal({ event, onClose, redact }: { event: AuditEvent; onClose: () => void; redact: RedactMode }) {
  return (
    <Modal title="Audit event" onClose={onClose} width={580}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <KV label="Event ID" value={event.id} mono />
        <KV label="Timestamp" value={event.timestamp} />
        <KV label="User" value={`${event.userName} (${users.find((u) => u.id === event.userId)?.email})`} />
        <KV label="Tool" value={event.toolName} mono />
        <KV label="Source" value={event.source} />
        <KV
          label="Status"
          value=""
          render={
            <Badge variant={event.status === "success" ? "success" : "error"}>{event.status}</Badge>
          }
        />
        <KV label="Duration" value={`${event.duration}ms`} />
        <div>
          <div style={{ fontSize: 11, color: t.fg3, marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em" }}>Parameters</div>
          <Code>{JSON.stringify(redact === "show" ? event.params : Object.fromEntries(Object.keys(event.params).map((k) => [k, "•••••"])), null, 2)}</Code>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Button variant="secondary" onClick={onClose}>Close</Button>
        </div>
      </div>
    </Modal>
  );
}

function KV({ label, value, mono, render }: { label: string; value: string; mono?: boolean; render?: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 16 }}>
      <div style={{ width: 110, fontSize: 11, color: t.fg3, textTransform: "uppercase", letterSpacing: "0.04em", paddingTop: 2 }}>{label}</div>
      <div style={{ flex: 1, fontSize: 13, color: t.fg1, fontFamily: mono ? t.fontMono : t.font, wordBreak: "break-all" }}>
        {render || value}
      </div>
    </div>
  );
}

function SinkModal({ onClose }: { onClose: () => void }) {
  const [url, setUrl] = useState("postgres://audit.acme.internal/arbytr_audit");
  const [tested, setTested] = useState(false);
  return (
    <Modal title="Audit sink configuration" onClose={onClose} width={560}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Alert type="info">
          Audit events stream over the same WSS connection back to a database you control. Arbytr never sees or stores audit data.
        </Alert>
        <Select
          label="Sink type"
          options={[
            { label: "Postgres", value: "postgres" },
            { label: "MySQL", value: "mysql" },
            { label: "ClickHouse", value: "clickhouse" },
            { label: "Snowflake", value: "snowflake" },
            { label: "S3 / object storage", value: "s3" },
            { label: "Webhook (HTTPS)", value: "webhook" },
          ]}
          value="postgres"
          onChange={() => {}}
        />
        <Input label="Connection string" value={url} onChange={(e) => setUrl(e.target.value)} monospace />
        <div style={{ display: "flex", gap: 8 }}>
          <Button variant="secondary" onClick={() => setTested(true)}>Test connection</Button>
          {tested && <Badge variant="success">Connected — table arbytr_audit ready</Badge>}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 8, borderTop: `1px solid ${t.border}` }}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="accent" onClick={onClose}>Save</Button>
        </div>
      </div>
    </Modal>
  );
}
