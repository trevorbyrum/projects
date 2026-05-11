"use client";

import { useState } from "react";
import { theme } from "@/lib/theme";
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Code,
  Input,
  Modal,
  PageHeader,
  Select,
} from "@/components/ui/primitives";
import {
  connectors,
  Credential,
  credentials as initial,
  tools,
  users,
} from "@/lib/mock-data";

const t = theme;

export default function VaultPage() {
  const [list, setList] = useState<Credential[]>(initial);
  const [addOpen, setAddOpen] = useState(false);
  const [rotating, setRotating] = useState<Credential | null>(null);
  const [editingBindings, setEditingBindings] = useState<Credential | null>(null);

  const rotate = (id: string) => {
    setList((cur) => cur.map((c) => (c.id === id ? { ...c, lastRotated: "Just now", status: "active" } : c)));
    setRotating(null);
  };

  const revoke = (id: string) => {
    const c = list.find((x) => x.id === id);
    if (!c) return;
    const tcount = c.bindings.length;
    if (typeof window !== "undefined" && !window.confirm(`Revoke "${c.name}"? ${tcount} tool binding${tcount === 1 ? "" : "s"} will lose access.`)) return;
    setList((cur) => cur.map((x) => (x.id === id ? { ...x, status: "revoked" } : x)));
  };

  return (
    <>
      <PageHeader
        title="Vault"
        description="Credentials are stored on the customer side — in the Arbytr Client's local vault, never on the platform."
        actions={<Button variant="accent" onClick={() => setAddOpen(true)}>+ Add credential</Button>}
      />

      <Alert type="info">
        Vault values are write-only. Credentials are dereferenced only at execution time, within the customer trust boundary.
      </Alert>

      <div style={{ height: 14 }} />

      <Card padding={0} style={{ overflow: "hidden" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1.6fr 0.9fr 1.6fr 0.9fr 0.9fr 110px",
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
          <span>Credential</span>
          <span>Type</span>
          <span>Bindings</span>
          <span>Last used</span>
          <span>Status</span>
          <span />
        </div>
        {list.map((c) => (
          <div
            key={c.id}
            style={{
              display: "grid",
              gridTemplateColumns: "1.6fr 0.9fr 1.6fr 0.9fr 0.9fr 110px",
              padding: "12px 16px",
              borderBottom: `1px solid ${t.border}`,
              alignItems: "center",
              gap: 8,
              opacity: c.status === "active" ? 1 : 0.6,
            }}
          >
            <div>
              <div style={{ fontSize: 13, fontWeight: 500, color: t.fg1 }}>{c.name}</div>
              <div style={{ fontSize: 11, color: t.fg3, marginTop: 2, fontFamily: t.fontMono }}>
                ••••••••••••••••
              </div>
            </div>
            <div style={{ fontSize: 12, color: t.fg2 }}>{typeLabel(c.type)}</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {c.bindings.slice(0, 3).map((b, i) => (
                <BindingChip key={i} binding={b} />
              ))}
              {c.bindings.length > 3 && (
                <Badge style={{ cursor: "pointer" }}>
                  <span onClick={() => setEditingBindings(c)}>+{c.bindings.length - 3} more</span>
                </Badge>
              )}
            </div>
            <div style={{ fontSize: 12, color: t.fg3 }}>{c.lastUsed}</div>
            <div>
              <Badge
                variant={c.status === "active" ? "success" : c.status === "expired" ? "warning" : "error"}
              >
                {c.status}
              </Badge>
            </div>
            <div style={{ display: "flex", gap: 4 }}>
              <Button variant="ghost" onClick={() => setEditingBindings(c)}>Edit</Button>
              <Button variant="ghost" onClick={() => setRotating(c)}>Rotate</Button>
              <Button variant="ghost" onClick={() => revoke(c.id)} style={{ color: t.error }}>Revoke</Button>
            </div>
          </div>
        ))}
      </Card>

      {addOpen && (
        <AddCredentialModal
          onClose={() => setAddOpen(false)}
          onAdd={(c) => {
            setList((cur) => [c, ...cur]);
            setAddOpen(false);
          }}
        />
      )}

      {rotating && (
        <RotateModal cred={rotating} onClose={() => setRotating(null)} onRotate={() => rotate(rotating.id)} />
      )}

      {editingBindings && (
        <BindingsModal
          cred={editingBindings}
          onClose={() => setEditingBindings(null)}
          onSave={(bindings) => {
            setList((cur) => cur.map((x) => (x.id === editingBindings.id ? { ...x, bindings } : x)));
            setEditingBindings(null);
          }}
        />
      )}
    </>
  );
}

function typeLabel(type: Credential["type"]) {
  return (
    {
      "api-key": "API key",
      "oauth-token": "OAuth token",
      "bearer-token": "Bearer token",
      "basic-auth": "Basic auth",
    } as Record<string, string>
  )[type];
}

function BindingChip({ binding }: { binding: Credential["bindings"][number] }) {
  let label = "—";
  if (binding.toolId) {
    const tt = tools.find((x) => x.id === binding.toolId);
    label = tt ? tt.name : binding.toolId;
  } else if (binding.connectorId) {
    const c = connectors.find((x) => x.id === binding.connectorId);
    label = c ? `${c.name} (all)` : binding.connectorId;
  }
  if (binding.userId) {
    const u = users.find((x) => x.id === binding.userId);
    label = `${label} · ${u ? u.name.split(" ")[0] : binding.userId}`;
  }
  return (
    <span
      style={{
        fontSize: 11,
        padding: "2px 7px",
        background: t.accentSubtle,
        color: t.accentText,
        borderRadius: 3,
        fontFamily: t.fontMono,
      }}
    >
      {label}
    </span>
  );
}

function AddCredentialModal({ onClose, onAdd }: { onClose: () => void; onAdd: (c: Credential) => void }) {
  const [name, setName] = useState("");
  const [type, setType] = useState<Credential["type"]>("api-key");
  const [value, setValue] = useState("");
  const [bindTool, setBindTool] = useState<string>("");
  const [bindConnector, setBindConnector] = useState<string>("");
  const [bindUser, setBindUser] = useState<string>("");

  const handleAdd = () => {
    const bindings: Credential["bindings"] = [];
    if (bindTool) bindings.push({ toolId: bindTool, userId: bindUser || undefined });
    if (bindConnector) bindings.push({ connectorId: bindConnector, userId: bindUser || undefined });
    if (bindings.length === 0) bindings.push({ userId: bindUser || undefined });
    onAdd({
      id: `cred-${Date.now()}`,
      name,
      type,
      bindings,
      created: "Just now",
      lastUsed: "Never",
      lastRotated: "Just now",
      status: "active",
    });
  };

  return (
    <Modal title="Add credential" onClose={onClose} width={520}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Input label="Name" placeholder="e.g. Stripe Production Key" value={name} onChange={(e) => setName(e.target.value)} />

        <Select
          label="Type"
          options={[
            { label: "API key", value: "api-key" },
            { label: "OAuth token", value: "oauth-token" },
            { label: "Bearer token", value: "bearer-token" },
            { label: "Basic auth", value: "basic-auth" },
          ]}
          value={type}
          onChange={(e) => setType(e.target.value as Credential["type"])}
        />

        <div>
          <Input
            label="Value"
            placeholder={type === "basic-auth" ? "user:password" : "sk_live_…"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            type="password"
            monospace
          />
          <div style={{ fontSize: 11, color: t.fg3, marginTop: 5, lineHeight: 1.5 }}>
            ⚠ Shown only once. We&apos;ll never display this value again. Sent encrypted to the Arbytr Client&apos;s local vault.
          </div>
        </div>

        <div style={{ borderTop: `1px solid ${t.border}`, paddingTop: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: t.fg2, marginBottom: 8 }}>
            Bind to execution tuple
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
            <Select
              label="Tool"
              options={[{ label: "— any —", value: "" }, ...tools.map((tt) => ({ label: tt.name, value: tt.id }))]}
              value={bindTool}
              onChange={(e) => setBindTool(e.target.value)}
            />
            <Select
              label="Connector"
              options={[{ label: "— any —", value: "" }, ...connectors.map((c) => ({ label: c.name, value: c.id }))]}
              value={bindConnector}
              onChange={(e) => setBindConnector(e.target.value)}
            />
            <Select
              label="User"
              options={[{ label: "— any user —", value: "" }, ...users.map((u) => ({ label: u.name, value: u.id }))]}
              value={bindUser}
              onChange={(e) => setBindUser(e.target.value)}
            />
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="accent" onClick={handleAdd} disabled={!name || !value}>Save credential</Button>
        </div>
      </div>
    </Modal>
  );
}

function RotateModal({ cred, onClose, onRotate }: { cred: Credential; onClose: () => void; onRotate: () => void }) {
  const [value, setValue] = useState("");
  return (
    <Modal title={`Rotate ${cred.name}`} onClose={onClose} width={460}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Alert type="warning">
          Rotating immediately invalidates the previous value. {cred.bindings.length} binding{cred.bindings.length === 1 ? "" : "s"} will start using the new value on the next call.
        </Alert>
        <Input label="New value" type="password" value={value} onChange={(e) => setValue(e.target.value)} monospace placeholder="Paste new secret…" />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="accent" onClick={onRotate} disabled={!value}>Rotate now</Button>
        </div>
      </div>
    </Modal>
  );
}

function BindingsModal({
  cred,
  onClose,
  onSave,
}: {
  cred: Credential;
  onClose: () => void;
  onSave: (b: Credential["bindings"]) => void;
}) {
  const [b, setB] = useState<Credential["bindings"]>(cred.bindings);

  const addBinding = () => setB([...b, {}]);
  const updateBinding = (i: number, patch: Partial<Credential["bindings"][number]>) =>
    setB(b.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
  const removeBinding = (i: number) => setB(b.filter((_, idx) => idx !== i));

  return (
    <Modal title={`Bindings — ${cred.name}`} onClose={onClose} width={640}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <p style={{ fontSize: 12.5, color: t.fg3, margin: 0, lineHeight: 1.5 }}>
          Each binding is a (user, tool, connector) tuple. The credential is dereferenced only when a call matches a binding.
        </p>

        {b.map((binding, i) => (
          <div
            key={i}
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr 32px",
              gap: 8,
              padding: 10,
              borderRadius: t.radius,
              background: `oklch(0.10 0.003 ${t.hue})`,
              border: `1px solid ${t.borderSoft}`,
            }}
          >
            <Select
              options={[{ label: "— any —", value: "" }, ...tools.map((tt) => ({ label: tt.name, value: tt.id }))]}
              value={binding.toolId || ""}
              onChange={(e) => updateBinding(i, { toolId: e.target.value || undefined })}
            />
            <Select
              options={[{ label: "— any —", value: "" }, ...connectors.map((c) => ({ label: c.name, value: c.id }))]}
              value={binding.connectorId || ""}
              onChange={(e) => updateBinding(i, { connectorId: e.target.value || undefined })}
            />
            <Select
              options={[{ label: "— any user —", value: "" }, ...users.map((u) => ({ label: u.name, value: u.id }))]}
              value={binding.userId || ""}
              onChange={(e) => updateBinding(i, { userId: e.target.value || undefined })}
            />
            <Button variant="ghost" onClick={() => removeBinding(i)} style={{ color: t.error, justifyContent: "center" }}>
              ×
            </Button>
          </div>
        ))}

        <Button variant="secondary" onClick={addBinding}>+ Add binding</Button>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 8, borderTop: `1px solid ${t.border}` }}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="accent" onClick={() => onSave(b)}>Save</Button>
        </div>
      </div>
    </Modal>
  );
}
