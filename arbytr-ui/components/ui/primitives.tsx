"use client";

import React, { CSSProperties, ReactNode, useState } from "react";
import { theme, Theme } from "@/lib/theme";

const t: Theme = theme;
const dark = t.mode === "dark";

/* ── Shared card border style ── */
export function cardBorderStyle(): CSSProperties {
  const borderColor = dark ? `oklch(0.26 0.006 ${t.hue})` : t.accent[4];
  return {
    background: dark ? `oklch(0.21 0.006 ${t.hue})` : t.surfaceBg,
    border: `1px solid ${borderColor}`,
    borderTopWidth: "1.2px",
    borderLeftWidth: "1.5px",
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderStyle: "solid",
    borderTopColor: dark ? `oklch(0.25 0.006 ${t.hue})` : borderColor,
    borderLeftColor: dark ? `oklch(0.25 0.006 ${t.hue})` : borderColor,
    borderRightColor: dark ? `oklch(0.22 0.004 ${t.hue})` : borderColor,
    borderBottomColor: dark ? `oklch(0.22 0.004 ${t.hue})` : borderColor,
    boxShadow: dark
      ? `0 2px 6px oklch(0.15 0.06 ${t.hue} / 0.6), 0 1px 2px oklch(0.12 0.04 ${t.hue} / 0.4), inset 0 1px 0 rgba(255,255,255,0.04)`
      : "0 1px 3px rgba(0,0,0,0.12), inset 0 1px 0 rgba(255,255,255,0.5)",
  };
}

/* ── Button ── */
type ButtonProps = {
  children: ReactNode;
  variant?: "primary" | "accent" | "secondary" | "ghost" | "link" | "danger";
  size?: "sm" | "md" | "lg";
  onClick?: (e: React.MouseEvent) => void;
  type?: "button" | "submit" | "reset";
  disabled?: boolean;
  style?: CSSProperties;
  title?: string;
};

export function Button({
  children,
  variant = "secondary",
  size = "md",
  onClick,
  type = "button",
  disabled,
  style,
  title,
}: ButtonProps) {
  const sizes = {
    sm: { fontSize: 12, padding: "5px 10px" },
    md: { fontSize: 13, padding: "7px 14px" },
    lg: { fontSize: 14, padding: "9px 18px" },
  } as const;
  const btnBorder = (v: string): CSSProperties => {
    if (v === "accent") {
      return {
        borderStyle: "solid",
        borderTopWidth: "1.2px",
        borderLeftWidth: "1.5px",
        borderRightWidth: "1px",
        borderBottomWidth: "1px",
        borderTopColor: dark ? `oklch(0.65 0.18 ${t.hue})` : "rgba(255,255,255,0.3)",
        borderLeftColor: dark ? `oklch(0.65 0.18 ${t.hue})` : "rgba(255,255,255,0.25)",
        borderRightColor: dark ? `oklch(0.40 0.14 ${t.hue})` : "rgba(0,0,0,0.08)",
        borderBottomColor: dark ? `oklch(0.38 0.12 ${t.hue})` : "rgba(0,0,0,0.1)",
      };
    }
    return {
      borderStyle: "solid",
      borderTopWidth: "1.2px",
      borderLeftWidth: "1.5px",
      borderRightWidth: "1px",
      borderBottomWidth: "1px",
      borderTopColor: dark ? `oklch(0.30 0.01 ${t.hue})` : "rgba(255,255,255,0.3)",
      borderLeftColor: dark ? `oklch(0.30 0.01 ${t.hue})` : "rgba(255,255,255,0.25)",
      borderRightColor: dark ? "rgba(0,0,0,0.3)" : "rgba(0,0,0,0.08)",
      borderBottomColor: dark ? "rgba(0,0,0,0.4)" : "rgba(0,0,0,0.1)",
    };
  };
  const raised = dark
    ? "0 2px 4px rgba(0,0,0,0.6), 0 1px 2px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.12)"
    : "0 1px 3px rgba(0,0,0,0.1), 0 1px 1px rgba(0,0,0,0.06), inset 0 1px 0 rgba(255,255,255,0.25)";
  const raisedSec = dark
    ? "0 2px 4px rgba(0,0,0,0.6), 0 1px 2px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.06)"
    : "0 1px 3px rgba(0,0,0,0.08), 0 1px 1px rgba(0,0,0,0.04), inset 0 1px 0 rgba(255,255,255,0.5)";

  const variants: Record<string, CSSProperties> = {
    primary: { background: `oklch(0.88 0.005 ${t.hue})`, color: t.pageBg, ...btnBorder("primary"), boxShadow: raised },
    accent: { background: t.accentSolid, color: t.accentOnSolid, ...btnBorder("accent"), boxShadow: raised },
    secondary: {
      background: dark ? `oklch(0.12 0.004 ${t.hue})` : t.surfaceBg,
      color: t.fg1,
      ...btnBorder("secondary"),
      boxShadow: raisedSec,
    },
    ghost: { background: "transparent", color: t.fg2, border: "none", boxShadow: "none" },
    link: {
      background: "none",
      color: t.accentText,
      border: "none",
      textDecoration: "underline",
      textUnderlineOffset: "2px",
      padding: "7px 4px",
      boxShadow: "none",
    },
    danger: {
      background: t.error,
      color: "#fff",
      ...btnBorder("accent"),
      boxShadow: raised,
    },
  };
  const s = { ...sizes[size], ...variants[variant] };

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        fontFamily: t.font,
        fontWeight: 500,
        borderRadius: t.radius,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        letterSpacing: "-0.01em",
        lineHeight: 1,
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        transition: "all 150ms ease-out",
        ...s,
        ...style,
      }}
    >
      {children}
    </button>
  );
}

/* ── Input ── */
type InputProps = {
  label?: string;
  placeholder?: string;
  type?: string;
  value?: string;
  defaultValue?: string;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  name?: string;
  autoComplete?: string;
  required?: boolean;
  disabled?: boolean;
  style?: CSSProperties;
  monospace?: boolean;
};

export function Input({
  label,
  placeholder,
  type = "text",
  value,
  defaultValue,
  onChange,
  name,
  autoComplete,
  required,
  disabled,
  style,
  monospace,
}: InputProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {label && (
        <label
          style={{
            fontSize: 12,
            fontWeight: 500,
            color: t.fg2,
            fontFamily: t.font,
          }}
        >
          {label}
        </label>
      )}
      <input
        type={type}
        placeholder={placeholder}
        value={value}
        defaultValue={defaultValue}
        onChange={onChange}
        name={name}
        autoComplete={autoComplete}
        required={required}
        disabled={disabled}
        style={{
          fontFamily: monospace ? t.fontMono : t.font,
          fontSize: 13,
          padding: "8px 10px",
          borderRadius: t.radius,
          border: `1px solid ${t.borderSoft}`,
          background: t.surfaceBg,
          color: t.fg1,
          outline: "none",
          lineHeight: 1.4,
          width: "100%",
          ...style,
        }}
      />
    </div>
  );
}

/* ── Textarea ── */
export function Textarea({
  label,
  placeholder,
  rows = 3,
  value,
  defaultValue,
  onChange,
  style,
}: {
  label?: string;
  placeholder?: string;
  rows?: number;
  value?: string;
  defaultValue?: string;
  onChange?: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  style?: CSSProperties;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {label && (
        <label style={{ fontSize: 12, fontWeight: 500, color: t.fg2, fontFamily: t.font }}>
          {label}
        </label>
      )}
      <textarea
        placeholder={placeholder}
        rows={rows}
        value={value}
        defaultValue={defaultValue}
        onChange={onChange}
        style={{
          fontFamily: t.font,
          fontSize: 13,
          padding: "8px 10px",
          borderRadius: t.radius,
          border: `1px solid ${t.borderSoft}`,
          background: t.surfaceBg,
          color: t.fg1,
          outline: "none",
          lineHeight: 1.5,
          resize: "vertical",
          boxShadow: "none",
          width: "100%",
          ...style,
        }}
      />
    </div>
  );
}

/* ── Select ── */
export function Select({
  label,
  options,
  value,
  defaultValue,
  onChange,
  style,
}: {
  label?: string;
  options: { label: string; value: string }[] | string[];
  value?: string;
  defaultValue?: string;
  onChange?: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  style?: CSSProperties;
}) {
  const opts =
    typeof options[0] === "string"
      ? (options as string[]).map((o) => ({ label: o, value: o }))
      : (options as { label: string; value: string }[]);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {label && (
        <label style={{ fontSize: 12, fontWeight: 500, color: t.fg2, fontFamily: t.font }}>
          {label}
        </label>
      )}
      <select
        value={value}
        defaultValue={defaultValue}
        onChange={onChange}
        style={{
          fontFamily: t.font,
          fontSize: 13,
          padding: "8px 14px",
          paddingRight: 28,
          borderRadius: t.radius,
          border: `1px solid ${t.borderSoft}`,
          background: t.surfaceBg,
          color: t.fg1,
          outline: "none",
          appearance: "auto",
          ...style,
        }}
      >
        {opts.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/* ── Toggle ── */
export function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange?: (v: boolean) => void;
}) {
  return (
    <div
      onClick={() => onChange && onChange(!checked)}
      style={{
        width: 32,
        height: 18,
        borderRadius: 9,
        cursor: "pointer",
        background: checked ? t.accentSolid : t.subtleBg,
        border: `1px solid ${checked ? t.accentSolid : t.border}`,
        position: "relative",
        transition: "background 150ms",
        flexShrink: 0,
      }}
    >
      <div
        style={{
          width: 14,
          height: 14,
          borderRadius: 7,
          background: checked ? t.accentOnSolid : t.fg3,
          position: "absolute",
          top: 1,
          left: checked ? 15 : 1,
          transition: "left 150ms",
          boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
        }}
      />
    </div>
  );
}

/* ── Badge ── */
export function Badge({
  children,
  variant = "default",
  style,
}: {
  children: ReactNode;
  variant?: "default" | "accent" | "success" | "error" | "warning";
  style?: CSSProperties;
}) {
  const variants: Record<string, { background: string; color: string; border: string }> = {
    default: { background: t.subtleBg, color: t.fg2, border: t.border },
    accent: { background: t.accentSubtle, color: t.accentSolid, border: "transparent" },
    success: {
      background: `oklch(0.20 0.04 145)`,
      color: t.success,
      border: "transparent",
    },
    error: { background: `oklch(0.20 0.04 30)`, color: t.error, border: "transparent" },
    warning: {
      background: `oklch(0.20 0.04 80)`,
      color: t.warning,
      border: "transparent",
    },
  };
  const v = variants[variant];
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 500,
        padding: "2px 8px",
        borderRadius: t.radius,
        background: v.background,
        color: v.color,
        border: `1px solid ${v.border}`,
        fontFamily: t.font,
        display: "inline-block",
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {children}
    </span>
  );
}

/* ── Card ── */
export function Card({
  children,
  padding = 16,
  style,
  onClick,
}: {
  children: ReactNode;
  padding?: number | string;
  style?: CSSProperties;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        position: "relative",
        borderRadius: t.radiusLg,
        padding,
        fontFamily: t.font,
        cursor: onClick ? "pointer" : "default",
        ...cardBorderStyle(),
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/* ── Divider ── */
export function Divider({ style }: { style?: CSSProperties }) {
  return <div style={{ height: 1, background: t.border, ...style }} />;
}

/* ── Tabs ── */
export function Tabs({
  items,
  active,
  onChange,
}: {
  items: string[];
  active: number;
  onChange?: (i: number) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 0, borderBottom: `1px solid ${t.border}` }}>
      {items.map((item, i) => (
        <div
          key={i}
          onClick={() => onChange && onChange(i)}
          style={{
            padding: "8px 14px",
            fontSize: 13,
            cursor: "pointer",
            fontFamily: t.font,
            color: i === active ? t.fg1 : t.fg3,
            fontWeight: i === active ? 500 : 400,
            borderBottom: i === active ? `2px solid ${t.accentSolid}` : "2px solid transparent",
            marginBottom: -1,
          }}
        >
          {item}
        </div>
      ))}
    </div>
  );
}

/* ── Segmented Control ── */
export function Segmented({
  items,
  active,
  onChange,
}: {
  items: string[];
  active: number;
  onChange?: (i: number) => void;
}) {
  return (
    <div
      style={{
        display: "inline-flex",
        borderRadius: t.radius,
        padding: 2,
        ...cardBorderStyle(),
      }}
    >
      {items.map((item, i) => (
        <div
          key={i}
          onClick={() => onChange && onChange(i)}
          style={{
            padding: "4px 12px",
            fontSize: 12,
            borderRadius: 2,
            cursor: "pointer",
            background: i === active ? t.accentSolid : "transparent",
            color: i === active ? t.accentOnSolid : t.fg3,
            fontWeight: i === active ? 500 : 400,
            fontFamily: t.font,
          }}
        >
          {item}
        </div>
      ))}
    </div>
  );
}

/* ── Avatar ── */
export function Avatar({ initials, size = 28 }: { initials: string; size?: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: t.radius,
        background: t.accentSubtle,
        color: t.accentText,
        fontSize: size * 0.4,
        fontWeight: 600,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: t.font,
        flexShrink: 0,
      }}
    >
      {initials}
    </div>
  );
}

/* ── Dot ── */
export function Dot({
  variant = "accent",
  size = 8,
}: {
  variant?: "accent" | "success" | "error" | "warning" | "neutral";
  size?: number;
}) {
  const colors: Record<string, string> = {
    accent: t.accentSolid,
    success: t.success,
    error: t.error,
    warning: t.warning,
    neutral: t.fg3,
  };
  return (
    <span
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: "50%",
        background: colors[variant],
        flexShrink: 0,
        boxShadow: variant === "success" ? `0 0 8px ${t.success}` : undefined,
      }}
    />
  );
}

/* ── Stat ── */
export function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string | number;
  sub?: string;
}) {
  return (
    <div style={{ flex: 1 }}>
      <div
        style={{
          fontSize: 11,
          color: t.fg3,
          marginBottom: 4,
          fontFamily: t.font,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 24,
          fontWeight: 600,
          color: t.fg1,
          fontFamily: t.font,
          letterSpacing: "-0.02em",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
      {sub && (
        <div
          style={{
            fontSize: 11,
            color: t.accentText,
            fontWeight: 500,
            marginTop: 2,
            fontFamily: t.font,
          }}
        >
          {sub}
        </div>
      )}
    </div>
  );
}

/* ── Modal ── */
export function Modal({
  title,
  children,
  onClose,
  width = 480,
}: {
  title: string;
  children: ReactNode;
  onClose?: () => void;
  width?: number;
}) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "relative",
          width,
          maxWidth: "100%",
          maxHeight: "90vh",
          overflow: "auto",
          borderRadius: t.radiusLg,
          fontFamily: t.font,
          ...cardBorderStyle(),
          boxShadow: `0 16px 48px rgba(0,0,0,0.5), 0 2px 6px oklch(0.15 0.06 ${t.hue} / 0.6), inset 0 1px 0 rgba(255,255,255,0.04)`,
        }}
      >
        <div
          style={{
            padding: "14px 16px",
            borderBottom: `1px solid oklch(0.24 0.006 ${t.hue})`,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 600, color: t.fg1 }}>{title}</span>
          <span
            onClick={onClose}
            style={{
              fontSize: 18,
              color: t.fg3,
              cursor: "pointer",
              lineHeight: 1,
            }}
          >
            ×
          </span>
        </div>
        <div style={{ padding: 16 }}>{children}</div>
      </div>
    </div>
  );
}

/* ── Checkbox ── */
export function Checkbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange?: (v: boolean) => void;
  label?: string;
}) {
  return (
    <div
      onClick={() => onChange && onChange(!checked)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        cursor: "pointer",
        fontFamily: t.font,
      }}
    >
      <div
        style={{
          width: 16,
          height: 16,
          borderRadius: 3,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          transition: "all 150ms",
          flexShrink: 0,
          background: checked ? t.accentSolid : `oklch(0.10 0.002 ${t.hue})`,
          border: `1.5px solid ${t.accentSolid}`,
        }}
      >
        {checked && (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path
              d="M2 5L4.5 7.5L8 3"
              stroke="#fff"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </div>
      {label && <span style={{ fontSize: 13, color: t.fg1 }}>{label}</span>}
    </div>
  );
}

/* ── Alert ── */
export function Alert({
  message,
  type = "info",
  children,
}: {
  message?: string;
  type?: "info" | "success" | "error" | "warning";
  children?: ReactNode;
}) {
  const typeColors: Record<string, string> = {
    info: t.accentSolid,
    success: t.success,
    error: t.error,
    warning: t.warning,
  };
  return (
    <div
      style={{
        padding: "10px 14px",
        borderRadius: t.radius,
        fontFamily: t.font,
        fontSize: 13,
        display: "flex",
        alignItems: "center",
        gap: 10,
        color: t.fg1,
        ...cardBorderStyle(),
      }}
    >
      <div
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: typeColors[type],
          flexShrink: 0,
        }}
      />
      <span style={{ flex: 1 }}>{message || children}</span>
    </div>
  );
}

/* ── Progress ── */
export function Progress({ value = 50 }: { value?: number }) {
  return (
    <div
      style={{
        width: "100%",
        height: 6,
        borderRadius: 6,
        background: t.subtleBg,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          width: `${Math.min(100, Math.max(0, value))}%`,
          height: "100%",
          background: t.accentSolid,
          borderRadius: 6,
          transition: "width 300ms ease-out",
        }}
      />
    </div>
  );
}

/* ── Spinner ── */
export function Spinner({ size = 20 }: { size?: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        border: `2px solid ${t.subtleBg}`,
        borderTopColor: t.accentSolid,
        animation: "spin 0.8s linear infinite",
      }}
    >
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

/* ── Code Block ── */
export function Code({
  children,
  copyable = false,
}: {
  children: string;
  copyable?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(children);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };
  return (
    <div
      style={{
        position: "relative",
        padding: "10px 12px",
        paddingRight: copyable ? 70 : 12,
        borderRadius: t.radius,
        fontFamily: t.fontMono,
        fontSize: 12,
        background: `oklch(0.10 0.004 ${t.hue})`,
        color: t.fg1,
        border: `1px solid ${t.borderSoft}`,
        wordBreak: "break-all",
        whiteSpace: "pre-wrap",
        lineHeight: 1.5,
      }}
    >
      {children}
      {copyable && (
        <button
          onClick={copy}
          style={{
            position: "absolute",
            right: 8,
            top: 8,
            fontSize: 11,
            padding: "2px 8px",
            borderRadius: 4,
            background: copied ? t.success : t.accentSubtle,
            color: copied ? "#fff" : t.accentText,
            border: "none",
            cursor: "pointer",
            fontFamily: t.font,
            fontWeight: 500,
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      )}
    </div>
  );
}

/* ── PageHeader ── */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-start",
        gap: 16,
        marginBottom: 24,
      }}
    >
      <div>
        <h1
          style={{
            fontSize: 22,
            fontWeight: 600,
            color: t.fg1,
            margin: 0,
            letterSpacing: "-0.02em",
            fontFamily: t.font,
          }}
        >
          {title}
        </h1>
        {description && (
          <p
            style={{
              fontSize: 13,
              color: t.fg3,
              marginTop: 6,
              margin: 0,
              marginBlockStart: 6,
              maxWidth: 640,
              lineHeight: 1.5,
              fontFamily: t.font,
            }}
          >
            {description}
          </p>
        )}
      </div>
      {actions && <div style={{ display: "flex", gap: 8 }}>{actions}</div>}
    </div>
  );
}

/* ── EmptyState ── */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div
      style={{
        padding: "48px 24px",
        textAlign: "center",
        color: t.fg3,
        fontFamily: t.font,
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600, color: t.fg2, marginBottom: 4 }}>
        {title}
      </div>
      {description && (
        <div style={{ fontSize: 13, marginBottom: 16, color: t.fg3 }}>{description}</div>
      )}
      {action}
    </div>
  );
}
