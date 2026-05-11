"use client";

import { useMemo, useState } from "react";
import { theme } from "@/lib/theme";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Input,
  Modal,
  PageHeader,
  Segmented,
  Select,
  Textarea,
  Toggle,
} from "@/components/ui/primitives";
import { tools as initial, Tool } from "@/lib/mock-data";

const t = theme;

type Filter = "all" | "enabled" | "disabled";

export default function ToolsPage() {
  const [list, setList] = useState<Tool[]>(initial);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [classFilter, setClassFilter] = useState<number>(0); // 0 all, 1 read-only, 2 read-write
  const [editing, setEditing] = useState<Tool | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const sources = useMemo(() => Array.from(new Set(list.map((t) => t.source))).sort(), [list]);

  const filtered = useMemo(() => {
    return list.filter((tool) => {
      if (search && !tool.name.toLowerCase().includes(search.toLowerCase()) && !tool.description.toLowerCase().includes(search.toLowerCase())) return false;
      if (filter === "enabled" && !tool.enabled) return false;
      if (filter === "disabled" && tool.enabled) return false;
      if (sourceFilter !== "all" && tool.source !== sourceFilter) return false;
      if (classFilter === 1 && tool.classification !== "read-only") return false;
      if (classFilter === 2 && tool.classification !== "read-write") return false;
      return true;
    });
  }, [list, search, filter, sourceFilter, classFilter]);

  const toggle = (id: string) => {
    setList((cur) => cur.map((t) => (t.id === id ? { ...t, enabled: !t.enabled } : t)));
  };

  const saveDescription = (id: string, description: string) => {
    setList((cur) => cur.map((t) => (t.id === id ? { ...t, description } : t)));
  };

  const flipClassification = (id: string) => {
    setList((cur) =>
      cur.map((t) =>
        t.id === id
          ? { ...t, classification: t.classification === "read-only" ? "read-write" : "read-only" }
          : t,
      ),
    );
  };

  const toggleSelect = (id: string) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const bulkSet = (enabled: boolean) => {
    setList((cur) => cur.map((t) => (selected.has(t.id) ? { ...t, enabled } : t)));
    setSelected(new Set());
  };

  return (
    <>
      <PageHeader
        title="Tools"
        description="Every tool discovered across your services and connectors. Edit a description to change how the LLM interprets it."
        actions={
          selected.size > 0 ? (
            <>
              <Button variant="ghost" onClick={() => setSelected(new Set())}>Clear ({selected.size})</Button>
              <Button variant="secondary" onClick={() => bulkSet(false)}>Disable</Button>
              <Button variant="accent" onClick={() => bulkSet(true)}>Enable</Button>
            </>
          ) : (
            <>
              <Button variant="secondary">Sync tools</Button>
            </>
          )
        }
      />

      {/* Filters */}
      <Card padding={14} style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <Input
              placeholder="Search by name or description…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Segmented
            items={["All", "Read-only", "Read-write"]}
            active={classFilter}
            onChange={setClassFilter}
          />
          <Select
            options={[{ label: "All sources", value: "all" }, ...sources.map((s) => ({ label: s, value: s }))]}
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
          />
          <Select
            options={[
              { label: "All status", value: "all" },
              { label: "Enabled", value: "enabled" },
              { label: "Disabled", value: "disabled" },
            ]}
            value={filter}
            onChange={(e) => setFilter(e.target.value as Filter)}
          />
        </div>
      </Card>

      {/* Table */}
      <Card padding={0} style={{ overflow: "hidden" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "32px 1fr 220px 110px 110px 80px",
            padding: "10px 16px",
            fontSize: 11,
            fontWeight: 600,
            color: t.accentSolid,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            borderBottom: `1px solid ${t.border}`,
            background: `oklch(0.10 0.003 ${t.hue})`,
          }}
        >
          <span />
          <span>Tool</span>
          <span>Source</span>
          <span>Type</span>
          <span>Status</span>
          <span />
        </div>
        {filtered.map((tool) => (
          <div
            key={tool.id}
            style={{
              display: "grid",
              gridTemplateColumns: "32px 1fr 220px 110px 110px 80px",
              padding: "12px 16px",
              borderBottom: `1px solid ${t.border}`,
              alignItems: "center",
              gap: 8,
              opacity: tool.enabled ? 1 : 0.55,
            }}
          >
            <Checkbox checked={selected.has(tool.id)} onChange={() => toggleSelect(tool.id)} />
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 500, color: t.fg1, fontFamily: t.fontMono }}>{tool.name}</span>
                {tool.params.length > 0 && (
                  <span style={{ fontSize: 10.5, color: t.fg3 }}>
                    ({tool.params.length} {tool.params.length === 1 ? "param" : "params"})
                  </span>
                )}
              </div>
              <div style={{ fontSize: 12, color: t.fg3, marginTop: 2, maxWidth: 600, lineHeight: 1.4 }}>{tool.description}</div>
            </div>
            <div style={{ fontSize: 12, color: t.fg2 }}>{tool.source}</div>
            <div>
              <Badge variant={tool.classification === "read-only" ? "default" : "warning"} style={{ cursor: "pointer" }}>
                <span onClick={() => flipClassification(tool.id)}>{tool.classification}</span>
              </Badge>
            </div>
            <Toggle checked={tool.enabled} onChange={() => toggle(tool.id)} />
            <Button variant="ghost" onClick={() => setEditing(tool)}>Edit</Button>
          </div>
        ))}
        {filtered.length === 0 && (
          <div style={{ padding: 48, textAlign: "center", color: t.fg3, fontSize: 13 }}>
            No tools match your filters.
          </div>
        )}
      </Card>

      <div style={{ fontSize: 11, color: t.fg3, marginTop: 12 }}>
        Showing <span style={{ color: t.fg2 }}>{filtered.length}</span> of {list.length} tools •{" "}
        {list.filter((t) => t.enabled).length} enabled
      </div>

      {editing && (
        <EditToolModal
          tool={editing}
          onClose={() => setEditing(null)}
          onSave={(desc) => {
            saveDescription(editing.id, desc);
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

function EditToolModal({ tool, onClose, onSave }: { tool: Tool; onClose: () => void; onSave: (desc: string) => void }) {
  const [desc, setDesc] = useState(tool.description);
  return (
    <Modal title={`Edit ${tool.name}`} onClose={onClose} width={560}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div
          style={{
            padding: "10px 12px",
            background: t.accentSubtle,
            borderRadius: t.radius,
            fontSize: 12,
            color: t.accentText,
            lineHeight: 1.5,
          }}
        >
          The description below is what the LLM reads to decide when to use this tool. Edits take effect immediately.
        </div>

        <Textarea label="Description" value={desc} onChange={(e) => setDesc(e.target.value)} rows={4} />

        <div>
          <div style={{ fontSize: 12, fontWeight: 500, color: t.fg2, marginBottom: 6 }}>Parameters</div>
          {tool.params.length === 0 ? (
            <div style={{ fontSize: 12, color: t.fg3, fontStyle: "italic" }}>No parameters</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {tool.params.map((p) => (
                <div
                  key={p.name}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 10px",
                    background: `oklch(0.10 0.003 ${t.hue})`,
                    border: `1px solid ${t.borderSoft}`,
                    borderRadius: t.radius,
                    fontFamily: t.fontMono,
                    fontSize: 12,
                  }}
                >
                  <span style={{ color: t.accentText }}>{p.name}</span>
                  <span style={{ color: t.fg3 }}>:</span>
                  <span style={{ color: t.fg2 }}>{p.type}</span>
                  {p.required && <Badge variant="error" style={{ marginLeft: "auto" }}>required</Badge>}
                </div>
              ))}
            </div>
          )}
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 12,
            paddingTop: 8,
            borderTop: `1px solid ${t.border}`,
          }}
        >
          <div>
            <div style={{ fontSize: 11, color: t.fg3, marginBottom: 2 }}>Source</div>
            <div style={{ fontSize: 13, color: t.fg1 }}>{tool.source}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: t.fg3, marginBottom: 2 }}>Classification</div>
            <Badge variant={tool.classification === "read-only" ? "default" : "warning"}>
              {tool.classification}
            </Badge>
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="accent" onClick={() => onSave(desc)}>Save</Button>
        </div>
      </div>
    </Modal>
  );
}
