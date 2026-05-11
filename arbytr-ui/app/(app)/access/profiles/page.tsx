"use client";

import { useState } from "react";
import { theme } from "@/lib/theme";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Input,
  Modal,
  PageHeader,
  Textarea,
} from "@/components/ui/primitives";
import {
  connectors,
  RoleProfile,
  roleProfiles as initial,
  services,
  tools,
} from "@/lib/mock-data";

const t = theme;

export default function ProfilesPage() {
  const [list, setList] = useState<RoleProfile[]>(initial);
  const [editing, setEditing] = useState<RoleProfile | null>(null);
  const [creating, setCreating] = useState(false);

  const remove = (id: string) => {
    const p = list.find((x) => x.id === id);
    if (!p) return;
    if (p.userCount > 0) {
      if (typeof window !== "undefined" && !window.confirm(`${p.userCount} users are assigned to "${p.name}". Reassign them before deletion. Continue anyway?`)) return;
    } else {
      if (typeof window !== "undefined" && !window.confirm(`Delete role profile "${p.name}"?`)) return;
    }
    setList((cur) => cur.filter((x) => x.id !== id));
  };

  const duplicate = (id: string) => {
    const p = list.find((x) => x.id === id);
    if (!p) return;
    setList((cur) => [
      ...cur,
      {
        ...p,
        id: `prof-${Date.now()}`,
        name: `${p.name} (copy)`,
        userCount: 0,
        lastModified: "Just now",
      },
    ]);
  };

  const save = (p: RoleProfile) => {
    setList((cur) => {
      if (cur.find((x) => x.id === p.id)) {
        return cur.map((x) => (x.id === p.id ? { ...p, lastModified: "Just now" } : x));
      }
      return [...cur, { ...p, lastModified: "Just now" }];
    });
    setEditing(null);
    setCreating(false);
  };

  return (
    <>
      <PageHeader
        title="Role profiles"
        description="Reusable bundles of services, connectors, and tools. Assign to users to grant access."
        actions={<Button variant="accent" onClick={() => setCreating(true)}>+ Create profile</Button>}
      />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 14 }}>
        {list.map((p) => (
          <Card key={p.id} padding={18}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 10 }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 600, color: t.fg1, marginBottom: 2 }}>{p.name}</div>
                <div style={{ fontSize: 12, color: t.fg3, lineHeight: 1.5, maxWidth: 280 }}>{p.description}</div>
              </div>
              <Badge variant="accent">{p.userCount} {p.userCount === 1 ? "user" : "users"}</Badge>
            </div>

            <div style={{ display: "flex", gap: 12, padding: "12px 0", borderTop: `1px solid ${t.border}`, borderBottom: `1px solid ${t.border}`, marginBottom: 12 }}>
              <Mini label="Services" value={p.serviceIds.length} />
              <Mini label="Connectors" value={p.connectorIds.length} />
              <Mini label="Tools" value={p.toolIds.length} />
            </div>

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 11, color: t.fg3 }}>Modified {p.lastModified}</span>
              <div style={{ display: "flex", gap: 4 }}>
                <Button variant="ghost" onClick={() => duplicate(p.id)}>Duplicate</Button>
                <Button variant="ghost" onClick={() => setEditing(p)}>Edit</Button>
                <Button variant="ghost" onClick={() => remove(p.id)} style={{ color: t.error }}>Delete</Button>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {editing && <EditProfileModal profile={editing} onClose={() => setEditing(null)} onSave={save} />}
      {creating && (
        <EditProfileModal
          profile={{
            id: `prof-${Date.now()}`,
            name: "",
            description: "",
            userCount: 0,
            serviceIds: [],
            connectorIds: [],
            toolIds: [],
            lastModified: "Just now",
          }}
          onClose={() => setCreating(false)}
          onSave={save}
        />
      )}
    </>
  );
}

function Mini({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ flex: 1 }}>
      <div style={{ fontSize: 18, fontWeight: 600, color: t.fg1, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      <div style={{ fontSize: 10.5, color: t.fg3, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
    </div>
  );
}

function EditProfileModal({ profile, onClose, onSave }: { profile: RoleProfile; onClose: () => void; onSave: (p: RoleProfile) => void }) {
  const [draft, setDraft] = useState<RoleProfile>(profile);

  const toggleService = (id: string) =>
    setDraft((d) => ({
      ...d,
      serviceIds: d.serviceIds.includes(id) ? d.serviceIds.filter((x) => x !== id) : [...d.serviceIds, id],
    }));
  const toggleConnector = (id: string) =>
    setDraft((d) => ({
      ...d,
      connectorIds: d.connectorIds.includes(id) ? d.connectorIds.filter((x) => x !== id) : [...d.connectorIds, id],
    }));
  const toggleTool = (id: string) =>
    setDraft((d) => ({
      ...d,
      toolIds: d.toolIds.includes(id) ? d.toolIds.filter((x) => x !== id) : [...d.toolIds, id],
    }));

  const visibleTools = tools.filter((tt) =>
    tt.sourceType === "service"
      ? draft.serviceIds.includes(services.find((s) => s.name === tt.source)?.id || "")
      : draft.connectorIds.includes(connectors.find((c) => c.name === tt.source)?.id || ""),
  );

  return (
    <Modal title={profile.name ? `Edit ${profile.name}` : "Create role profile"} onClose={onClose} width={720}>
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 12 }}>
          <Input label="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Engineering" />
          <Textarea
            label="Description"
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            rows={2}
            placeholder="What this profile is for."
          />
        </div>

        {/* Services */}
        <Section title="Services" count={draft.serviceIds.length} total={services.length}>
          {services.map((s) => (
            <Row key={s.id} checked={draft.serviceIds.includes(s.id)} onChange={() => toggleService(s.id)} title={s.name} sub={`${s.toolCount} tools`} />
          ))}
        </Section>

        {/* Connectors */}
        <Section title="Connectors" count={draft.connectorIds.length} total={connectors.length}>
          {connectors.map((c) => (
            <Row key={c.id} checked={draft.connectorIds.includes(c.id)} onChange={() => toggleConnector(c.id)} title={c.name} sub={`${c.toolCount} tools • ${c.auth}`} />
          ))}
        </Section>

        {/* Tools — only show those reachable via selected services/connectors */}
        <Section
          title="Tools within selected scope"
          count={draft.toolIds.filter((tid) => visibleTools.find((vt) => vt.id === tid)).length}
          total={visibleTools.length}
        >
          {visibleTools.length === 0 ? (
            <div style={{ fontSize: 12, color: t.fg3, fontStyle: "italic", padding: "10px 0" }}>
              Select a service or connector above to see tools.
            </div>
          ) : (
            visibleTools.map((tt) => (
              <Row
                key={tt.id}
                checked={draft.toolIds.includes(tt.id)}
                onChange={() => toggleTool(tt.id)}
                title={tt.name}
                sub={`${tt.source} • ${tt.classification}`}
                mono
              />
            ))
          )}
        </Section>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 8, borderTop: `1px solid ${t.border}` }}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="accent" onClick={() => onSave(draft)} disabled={!draft.name}>Save</Button>
        </div>
      </div>
    </Modal>
  );
}

function Section({ title, count, total, children }: { title: string; count: number; total: number; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: t.fg1 }}>{title}</div>
        <Badge>{count} of {total}</Badge>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2, maxHeight: 200, overflowY: "auto" }}>{children}</div>
    </div>
  );
}

function Row({ checked, onChange, title, sub, mono }: { checked: boolean; onChange: () => void; title: string; sub: string; mono?: boolean }) {
  return (
    <div
      onClick={onChange}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "7px 10px",
        borderRadius: t.radius,
        cursor: "pointer",
        background: checked ? t.accentSubtle : "transparent",
        transition: "background 120ms",
      }}
    >
      <Checkbox checked={checked} onChange={onChange} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, color: t.fg1, fontWeight: 500, fontFamily: mono ? t.fontMono : t.font }}>{title}</div>
        <div style={{ fontSize: 11, color: t.fg3 }}>{sub}</div>
      </div>
    </div>
  );
}
