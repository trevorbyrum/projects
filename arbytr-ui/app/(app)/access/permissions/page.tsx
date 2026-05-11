"use client";

import { useMemo, useState } from "react";
import { theme } from "@/lib/theme";
import {
  Badge,
  Card,
  Input,
  PageHeader,
  Segmented,
  Select,
} from "@/components/ui/primitives";
import {
  connectors,
  roleProfiles,
  services,
  tools,
  users,
} from "@/lib/mock-data";

const t = theme;

type Axis = 0 | 1; // 0 = profiles, 1 = users

export default function PermissionsPage() {
  const [axis, setAxis] = useState<Axis>(0);
  const [scope, setScope] = useState<"tools" | "connectors">("tools");
  const [search, setSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState<string>("all");

  const rows = axis === 0 ? roleProfiles : users;
  const sources = useMemo(() => Array.from(new Set(tools.map((tt) => tt.source))), []);

  const cols =
    scope === "tools"
      ? tools.filter((tt) => (sourceFilter === "all" || tt.source === sourceFilter) && (!search || tt.name.toLowerCase().includes(search.toLowerCase())))
      : connectors.filter((c) => !search || c.name.toLowerCase().includes(search.toLowerCase()));

  // helpers
  const profileHas = (profileId: string, colId: string) => {
    const p = roleProfiles.find((x) => x.id === profileId);
    if (!p) return false;
    return scope === "tools" ? p.toolIds.includes(colId) : p.connectorIds.includes(colId);
  };
  const userHas = (userId: string, colId: string) => {
    const u = users.find((x) => x.id === userId);
    if (!u) return false;
    return profileHas(u.profileId, colId);
  };
  const has = (rowId: string, colId: string) => (axis === 0 ? profileHas(rowId, colId) : userHas(rowId, colId));

  // gap detection: column references a disabled tool
  const isGapCol = (colId: string) => scope === "tools" && tools.find((t) => t.id === colId)?.enabled === false;

  return (
    <>
      <PageHeader
        title="Permissions"
        description='Visualize "what does User X actually see in Claude?" — and find gaps or over-access at a glance.'
      />

      <Card padding={14} style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 11, color: t.fg3, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.04em" }}>View by</div>
            <Segmented items={["Role profile", "User"]} active={axis} onChange={(i) => setAxis(i as Axis)} />
          </div>
          <div>
            <div style={{ fontSize: 11, color: t.fg3, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.04em" }}>Across</div>
            <Segmented items={["Tools", "Connectors"]} active={scope === "tools" ? 0 : 1} onChange={(i) => setScope(i === 0 ? "tools" : "connectors")} />
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <Input placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          {scope === "tools" && (
            <Select
              options={[{ label: "All sources", value: "all" }, ...sources.map((s) => ({ label: s, value: s }))]}
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value)}
            />
          )}
        </div>
      </Card>

      {/* Summary band */}
      <div style={{ display: "flex", gap: 12, marginBottom: 14 }}>
        <SummaryStat
          label={axis === 0 ? "Profiles" : "Users"}
          value={rows.length}
        />
        <SummaryStat label={scope === "tools" ? "Tools" : "Connectors"} value={cols.length} />
        {scope === "tools" && (
          <SummaryStat
            label="Disabled tools in view"
            value={cols.filter((c: { id: string }) => isGapCol(c.id)).length}
            highlight="warning"
          />
        )}
      </div>

      {/* Matrix */}
      <Card padding={0} style={{ overflow: "auto" }}>
        <div style={{ minWidth: cols.length * 56 + 240 }}>
          {/* Column headers */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: `240px repeat(${cols.length}, 56px)`,
              borderBottom: `1px solid ${t.border}`,
              background: `oklch(0.10 0.003 ${t.hue})`,
              position: "sticky",
              top: 0,
              zIndex: 2,
            }}
          >
            <div
              style={{
                padding: "10px 14px",
                fontSize: 11,
                fontWeight: 600,
                color: t.accentSolid,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                position: "sticky",
                left: 0,
                background: `oklch(0.10 0.003 ${t.hue})`,
                zIndex: 1,
                borderRight: `1px solid ${t.border}`,
              }}
            >
              {axis === 0 ? "Profile" : "User"}
            </div>
            {cols.map((c: any) => {
              const gap = isGapCol(c.id);
              return (
                <div
                  key={c.id}
                  title={c.name}
                  style={{
                    padding: "8px 4px",
                    fontSize: 10.5,
                    color: gap ? t.warning : t.fg2,
                    fontFamily: scope === "tools" ? t.fontMono : t.font,
                    textAlign: "center",
                    writingMode: "vertical-rl",
                    transform: "rotate(180deg)",
                    height: 110,
                    display: "flex",
                    alignItems: "flex-end",
                    justifyContent: "center",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    borderRight: `1px solid ${t.border}`,
                  }}
                >
                  {c.name}
                </div>
              );
            })}
          </div>

          {/* Rows */}
          {rows.map((row: any) => {
            const counts = cols.filter((c: any) => has(row.id, c.id)).length;
            return (
              <div
                key={row.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: `240px repeat(${cols.length}, 56px)`,
                  borderBottom: `1px solid ${t.border}`,
                  alignItems: "center",
                }}
              >
                <div
                  style={{
                    padding: "10px 14px",
                    fontSize: 12.5,
                    color: t.fg1,
                    position: "sticky",
                    left: 0,
                    background: `oklch(0.07 0.0012 ${t.hue})`,
                    zIndex: 1,
                    borderRight: `1px solid ${t.border}`,
                    height: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 500, color: t.fg1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {axis === 0 ? row.name : row.name}
                    </div>
                    <div style={{ fontSize: 10.5, color: t.fg3 }}>
                      {axis === 0
                        ? `${row.userCount} ${row.userCount === 1 ? "user" : "users"}`
                        : roleProfiles.find((p) => p.id === row.profileId)?.name}
                    </div>
                  </div>
                  <Badge>{counts}</Badge>
                </div>
                {cols.map((c: any) => {
                  const v = has(row.id, c.id);
                  const gap = v && isGapCol(c.id);
                  return (
                    <div
                      key={c.id}
                      title={`${axis === 0 ? row.name : row.name} → ${c.name}${gap ? " (tool globally disabled — gap)" : ""}`}
                      style={{
                        height: 38,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        borderRight: `1px solid ${t.border}`,
                      }}
                    >
                      {v ? (
                        gap ? (
                          <div
                            style={{
                              width: 14,
                              height: 14,
                              borderRadius: 3,
                              background: t.warning,
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              fontSize: 10,
                              fontWeight: 700,
                              color: "#000",
                            }}
                            title="User has access in profile, but tool is globally disabled"
                          >
                            !
                          </div>
                        ) : (
                          <div
                            style={{
                              width: 14,
                              height: 14,
                              borderRadius: 3,
                              background: t.accentSolid,
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                            }}
                          >
                            <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
                              <path d="M2 5L4.5 7.5L8 3" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          </div>
                        )
                      ) : (
                        <div
                          style={{
                            width: 14,
                            height: 14,
                            borderRadius: 3,
                            background: "transparent",
                            border: `1px solid ${t.border}`,
                          }}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </Card>

      {/* Legend */}
      <div style={{ display: "flex", gap: 18, marginTop: 14, fontSize: 11, color: t.fg3 }}>
        <LegendItem color={t.accentSolid} label="Allowed" />
        <LegendItem color="transparent" border label="Not allowed" />
        <LegendItem color={t.warning} label="Gap — profile grants access, tool globally disabled" />
      </div>
    </>
  );
}

function SummaryStat({ label, value, highlight }: { label: string; value: number; highlight?: "warning" }) {
  return (
    <Card padding={14} style={{ flex: 1 }}>
      <div style={{ fontSize: 11, color: t.fg3, marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em" }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, color: highlight === "warning" && value > 0 ? t.warning : t.fg1, fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </Card>
  );
}

function LegendItem({ color, border, label }: { color: string; border?: boolean; label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div style={{ width: 12, height: 12, borderRadius: 3, background: color, border: border ? `1px solid ${t.border}` : "none" }} />
      <span>{label}</span>
    </div>
  );
}
