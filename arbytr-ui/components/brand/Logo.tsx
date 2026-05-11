"use client";

import { theme } from "@/lib/theme";

/**
 * Arbytr wordmark + glyph.
 * The glyph is an "atomic gateway": two concentric arcs (the orbits)
 * with a centered diamond (the routed packet).
 */
export function Logo({
  size = 22,
  showWordmark = true,
}: {
  size?: number;
  showWordmark?: boolean;
}) {
  const t = theme;
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        style={{ flexShrink: 0 }}
      >
        {/* outer arc */}
        <path
          d="M 4 16 A 12 12 0 0 1 28 16"
          stroke={t.accentSolid}
          strokeWidth="2"
          strokeLinecap="round"
          fill="none"
        />
        <path
          d="M 28 16 A 12 12 0 0 1 4 16"
          stroke={t.accentSolid}
          strokeOpacity="0.35"
          strokeWidth="2"
          strokeLinecap="round"
          fill="none"
        />
        {/* center diamond */}
        <rect
          x="11"
          y="11"
          width="10"
          height="10"
          rx="1.5"
          transform="rotate(45 16 16)"
          fill={t.accentSolid}
        />
      </svg>
      {showWordmark && (
        <span
          style={{
            fontFamily: t.font,
            fontWeight: 600,
            fontSize: size * 0.78,
            color: t.fg1,
            letterSpacing: "-0.02em",
          }}
        >
          Arbytr
        </span>
      )}
    </div>
  );
}
