"use client";

import { useState } from "react";
import { theme } from "@/lib/theme";
import {
  Badge,
  Button,
  Card,
  Code,
  Dot,
  Input,
  Modal,
  PageHeader,
  Select,
  Spinner,
} from "@/components/ui/primitives";
import { services as initial, Service, tools } from "@/lib/mock-data";

const t = theme;

export default function ServicesPage() {
  const [list, setList] = useState<Service[]>(initial);
  const [modalOpen, setModalOpen] = useState(false);
  const [renameId, setRenameId] = useState<string | null>(null);

  const remove = (id: string) => {
    if (typeof window !== "undefined" && !window.confirm("Disconnect this service? Any tools it exposes will become unavailable.")) return;
    setList((cur) => cur.filter((s) => s.id !== id));
  };

  const rename = (id: string, name: string) => {
    setList((cur) => cur.map((s) => (s.id === id ? { ...s, name } : s)));
    setRenameId(null);
  };

  return (
    <>
      <PageHeader
        title="Services"
        description="Infrastructure you own, wrapped as MCP tools through the Arbytr Client."
        actions={<Button variant="accent" onClick={() => setModalOpen(true)}>+ Connect a service</Button>}
      />

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {list.map((svc) => (
          <ServiceRow
            key={svc.id}
            svc={svc}
            onRemove={() => remove(svc.id)}
            onRename={() => setRenameId(svc.id)}
          />
        ))}
      </div>

      {modalOpen && <ConnectServiceModal onClose={() => setModalOpen(false)} onConnected={(s) => setList((cur) => [s, ...cur])} />}
      {renameId && (
        <RenameModal
          current={list.find((s) => s.id === renameId)?.name || ""}
          onClose={() => setRenameId(null)}
          onSave={(name) => rename(renameId, name)}
        />
      )}
    </>
  );
}

function ServiceRow({ svc, onRemove, onRename }: { svc: Service; onRemove: () => void; onRename: () => void }) {
  const toolCount = tools.filter((tt) => tt.source === svc.name).length || svc.toolCount;
  const locationLabel: Record<string, string> = {
    local: "Local",
    homelab: "Homelab",
    "cloud-vm": "Cloud VM",
    container: "Container",
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
            background: svc.status === "online" ? `oklch(0.18 0.04 ${t.hue})` : t.subtleBg,
            border: `1px solid ${t.borderSoft}`,
            flexShrink: 0,
          }}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={svc.status === "online" ? t.accentSolid : t.fg3} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="3" width="20" height="14" rx="2" />
            <line x1="8" y1="21" x2="16" y2="21" />
            <line x1="12" y1="17" x2="12" y2="21" />
          </svg>
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: t.fg1 }}>{svc.name}</span>
            <Badge variant={svc.status === "online" ? "success" : "default"}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                <Dot variant={svc.status === "online" ? "success" : "neutral"} size={6} />
                {svc.status}
              </span>
            </Badge>
            <Badge>{locationLabel[svc.location]}</Badge>
          </div>
          <div style={{ fontSize: 12, color: t.fg3 }}>
            {svc.source} • <span style={{ color: t.fg2 }}>{toolCount}</span> tools discovered
            <span style={{ margin: "0 6px" }}>•</span>
            uptime <span style={{ color: t.fg2 }}>{svc.uptime}</span>
            <span style={{ margin: "0 6px" }}>•</span>
            last activity {svc.lastActivity}
          </div>
        </div>

        <div style={{ display: "flex", gap: 6 }}>
          <Button variant="ghost" onClick={onRename}>Rename</Button>
          <Button variant="ghost" onClick={onRemove} style={{ color: t.error }}>Disconnect</Button>
        </div>
      </div>
    </Card>
  );
}

function ConnectServiceModal({ onClose, onConnected }: { onClose: () => void; onConnected: (s: Service) => void }) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [name, setName] = useState("");
  const [location, setLocation] = useState("local");

  const token = "atok_03f2-91ab-ce47-8d2c-5e1f7b9c0a44";
  const cmd = `curl -fsSL https://get.arbytr.com | sh -s -- --token ${token}`;

  const handleStart = () => {
    if (!name) return;
    setStep(2);
    // simulate connection arriving
    setTimeout(() => setStep(3), 2200);
  };

  const handleFinish = () => {
    onConnected({
      id: `svc-${Date.now()}`,
      name,
      location: location as Service["location"],
      status: "online",
      uptime: "Just now",
      toolCount: 0,
      lastActivity: "Just now",
      source: location === "local" ? "Local machine" : location === "homelab" ? "Homelab" : location === "cloud-vm" ? "Cloud / VM" : "Container",
    });
    onClose();
  };

  return (
    <Modal title="Connect a service" onClose={onClose} width={520}>
      {/* progress */}
      <div style={{ display: "flex", gap: 4, marginBottom: 18 }}>
        {[1, 2, 3].map((n) => (
          <div
            key={n}
            style={{
              flex: 1,
              height: 3,
              borderRadius: 2,
              background: n <= step ? t.accentSolid : t.subtleBg,
              transition: "background 200ms",
            }}
          />
        ))}
      </div>

      {step === 1 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Input label="Service name" placeholder="e.g. Production Postgres" value={name} onChange={(e) => setName(e.target.value)} />
          <Select
            label="Where will the Arbytr Client run?"
            options={[
              { label: "Local machine", value: "local" },
              { label: "Homelab server", value: "homelab" },
              { label: "Cloud VM (AWS / GCP / Azure)", value: "cloud-vm" },
              { label: "Container / Kubernetes", value: "container" },
            ]}
            value={location}
            onChange={(e) => setLocation(e.target.value)}
          />
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 6 }}>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant="accent" onClick={handleStart} disabled={!name}>Generate token →</Button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div>
          <p style={{ fontSize: 13, color: t.fg2, marginBottom: 8, marginTop: 0 }}>
            Run this one-liner on your infrastructure to install and connect the Arbytr Client:
          </p>
          <Code copyable>{cmd}</Code>
          <div
            style={{
              marginTop: 16,
              padding: 14,
              borderRadius: t.radius,
              border: `1px dashed ${t.border}`,
              display: "flex",
              alignItems: "center",
              gap: 10,
              color: t.fg2,
              fontSize: 13,
            }}
          >
            <Spinner size={14} />
            Waiting for connection…
          </div>
          <p style={{ fontSize: 11, color: t.fg3, marginTop: 12 }}>
            Token expires in 15 minutes. Auto-rotates every 24h once connected.
          </p>
        </div>
      )}

      {step === 3 && (
        <div>
          <div
            style={{
              padding: 14,
              borderRadius: t.radius,
              background: `oklch(0.18 0.04 145)`,
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 14,
            }}
          >
            <Dot variant="success" size={10} />
            <div>
              <div style={{ fontSize: 13, fontWeight: 500, color: t.fg1 }}>Connected via WSS + mTLS</div>
              <div style={{ fontSize: 11.5, color: t.fg3, marginTop: 1 }}>
                Discovered 0 tools — auto-discovery in progress…
              </div>
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <Button variant="accent" onClick={handleFinish}>Done</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function RenameModal({ current, onClose, onSave }: { current: string; onClose: () => void; onSave: (name: string) => void }) {
  const [name, setName] = useState(current);
  return (
    <Modal title="Rename service" onClose={onClose} width={420}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Input label="Service name" value={name} onChange={(e) => setName(e.target.value)} />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="accent" onClick={() => onSave(name)} disabled={!name}>Save</Button>
        </div>
      </div>
    </Modal>
  );
}
