"use client";

import { useState } from "react";
import { theme } from "@/lib/theme";
import {
  Avatar,
  Badge,
  Button,
  Card,
  Input,
  Modal,
  PageHeader,
  Select,
} from "@/components/ui/primitives";
import { roleProfiles, users as initial, User } from "@/lib/mock-data";

const t = theme;

export default function UsersPage() {
  const [list, setList] = useState<User[]>(initial);
  const [inviteOpen, setInviteOpen] = useState(false);
  const profileOptions = roleProfiles.map((p) => ({ label: p.name, value: p.id }));

  const setProfile = (id: string, profileId: string) => {
    setList((cur) => cur.map((u) => (u.id === id ? { ...u, profileId } : u)));
  };

  const removeUser = (id: string) => {
    if (typeof window !== "undefined" && !window.confirm("Remove this user? They'll lose access immediately.")) return;
    setList((cur) => cur.filter((u) => u.id !== id));
  };

  return (
    <>
      <PageHeader
        title="Users"
        description="Team members authorized to invoke tools through the gateway."
        actions={<Button variant="accent" onClick={() => setInviteOpen(true)}>+ Invite user</Button>}
      />

      <Card padding={0} style={{ overflow: "hidden" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1.5fr 1.6fr 1.2fr 1fr 80px",
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
          <span>User</span>
          <span>Email</span>
          <span>Role profile</span>
          <span>Last active</span>
          <span />
        </div>
        {list.map((u) => {
          const profile = roleProfiles.find((p) => p.id === u.profileId);
          return (
            <div
              key={u.id}
              style={{
                display: "grid",
                gridTemplateColumns: "1.5fr 1.6fr 1.2fr 1fr 80px",
                padding: "12px 16px",
                borderBottom: `1px solid ${t.border}`,
                alignItems: "center",
                gap: 8,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Avatar initials={u.initials} size={28} />
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500, color: t.fg1 }}>{u.name}</div>
                  {u.status === "invited" && <Badge variant="warning" style={{ marginTop: 2 }}>Invited</Badge>}
                </div>
              </div>
              <div style={{ fontSize: 12.5, color: t.fg2 }}>{u.email}</div>
              <div>
                <Select
                  options={profileOptions}
                  value={u.profileId}
                  onChange={(e) => setProfile(u.id, e.target.value)}
                />
              </div>
              <div style={{ fontSize: 12, color: t.fg3 }}>{u.lastActive}</div>
              <Button variant="ghost" onClick={() => removeUser(u.id)} style={{ color: t.error }}>Remove</Button>
            </div>
          );
        })}
      </Card>

      <div style={{ fontSize: 11, color: t.fg3, marginTop: 12 }}>
        {list.length} users • {roleProfiles.length} role profiles
      </div>

      {inviteOpen && (
        <InviteModal
          onClose={() => setInviteOpen(false)}
          onInvite={(email, profileId) => {
            const namePart = email.split("@")[0] || "new";
            const tidy = namePart.replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
            const initials = tidy.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase();
            setList((cur) => [
              ...cur,
              {
                id: `u-${Date.now()}`,
                name: tidy,
                email,
                initials,
                profileId,
                lastActive: "Pending",
                status: "invited",
              },
            ]);
            setInviteOpen(false);
          }}
        />
      )}
    </>
  );
}

function InviteModal({ onClose, onInvite }: { onClose: () => void; onInvite: (email: string, profileId: string) => void }) {
  const [email, setEmail] = useState("");
  const [profileId, setProfileId] = useState(roleProfiles[1]?.id || roleProfiles[0]?.id || "");
  return (
    <Modal title="Invite user" onClose={onClose} width={460}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Input label="Email" placeholder="teammate@company.com" value={email} onChange={(e) => setEmail(e.target.value)} type="email" />
        <Select
          label="Role profile"
          options={roleProfiles.map((p) => ({ label: p.name, value: p.id }))}
          value={profileId}
          onChange={(e) => setProfileId(e.target.value)}
        />
        <p style={{ fontSize: 12, color: t.fg3, margin: 0, lineHeight: 1.5 }}>
          The user will receive an email with a one-click link to authenticate via your configured AI platform (Claude or ChatGPT).
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="accent" onClick={() => onInvite(email, profileId)} disabled={!email}>Send invite</Button>
        </div>
      </div>
    </Modal>
  );
}
