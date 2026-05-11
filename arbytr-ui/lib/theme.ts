/*
  Arbytr theme — derived from ui-ux-components design tokens.
  Off-black surfaces, single accent (slightly-lighter orange).
  OKLCH throughout, dark-first.
*/

export type ThemeMode = "dark" | "light";

export type Theme = {
  mode: ThemeMode;
  hue: number;
  accent: Record<number, string>;
  neutral: Record<number, string>;
  pageBg: string;
  surfaceBg: string;
  raisedBg: string;
  subtleBg: string;
  border: string;
  borderSoft: string;
  fg1: string;
  fg2: string;
  fg3: string;
  accentSolid: string;
  accentHover: string;
  accentActive: string;
  accentSubtle: string;
  accentText: string;
  accentOnSolid: string;
  success: string;
  error: string;
  warning: string;
  radius: string;
  radiusLg: string;
  font: string;
  fontMono: string;
};

// Hue 42 ≈ a peachy / slightly-warmer orange (lighter than pure #FF8000 hue ~30).
export const ARBYTR_HUE = 42;

function maxChroma(hue: number): number {
  if (hue >= 50 && hue <= 110) return 0.2;
  if (hue >= 30 && hue <= 50) return 0.22;
  if (hue >= 110 && hue <= 150) return 0.2;
  if (hue >= 0 && hue <= 30) return 0.2;
  return 0.28;
}

function generateAccentScale(hue: number): Record<number, string> {
  const mc = maxChroma(hue);
  const c = (ratio: number) => Math.min(mc, mc * ratio).toFixed(3);
  return {
    1: `oklch(0.98 ${c(0.04)} ${hue})`,
    2: `oklch(0.96 ${c(0.08)} ${hue})`,
    3: `oklch(0.92 ${c(0.16)} ${hue})`,
    4: `oklch(0.86 ${c(0.32)} ${hue})`,
    5: `oklch(0.80 ${c(0.48)} ${hue})`,
    6: `oklch(0.72 ${c(0.60)} ${hue})`,
    7: `oklch(0.64 ${c(0.75)} ${hue})`,
    8: `oklch(0.56 ${c(0.90)} ${hue})`,
    9: `oklch(0.50 ${c(1.0)} ${hue})`,
    10: `oklch(0.44 ${c(0.90)} ${hue})`,
    11: `oklch(0.72 ${c(0.60)} ${hue})`,
    12: `oklch(0.88 ${c(0.32)} ${hue})`,
  };
}

function generateNeutralScale(hue: number): Record<number, string> {
  const c = 0.008;
  return {
    1: `oklch(0.99 ${c * 0.5} ${hue})`,
    2: `oklch(0.97 ${c * 0.6} ${hue})`,
    3: `oklch(0.94 ${c * 0.7} ${hue})`,
    4: `oklch(0.91 ${c * 0.8} ${hue})`,
    5: `oklch(0.87 ${c} ${hue})`,
    6: `oklch(0.82 ${c} ${hue})`,
    7: `oklch(0.72 ${c} ${hue})`,
    8: `oklch(0.55 ${c * 1.2} ${hue})`,
    9: `oklch(0.40 ${c * 1.2} ${hue})`,
    10: `oklch(0.28 ${c} ${hue})`,
    11: `oklch(0.20 ${c * 0.8} ${hue})`,
    12: `oklch(0.14 ${c * 0.6} ${hue})`,
    13: `oklch(0.10 ${c * 0.4} ${hue})`,
  };
}

export function buildTheme(mode: ThemeMode = "dark", hue: number = ARBYTR_HUE): Theme {
  const accent = generateAccentScale(hue);
  const neutral = generateNeutralScale(hue);
  const dark = mode === "dark";

  return {
    mode,
    hue,
    accent,
    neutral,
    pageBg: dark ? `oklch(0.07 ${0.004 * 0.3} ${hue})` : neutral[2],
    surfaceBg: dark ? neutral[12] : neutral[1],
    raisedBg: dark ? neutral[11] : neutral[1],
    subtleBg: dark ? neutral[10] : neutral[3],
    border: dark ? `oklch(0.24 0.008 ${hue})` : neutral[4],
    borderSoft: dark ? `oklch(0.30 0.006 ${hue})` : neutral[3],
    fg1: dark ? `oklch(0.96 0.003 ${hue})` : `oklch(0.18 0.01 ${hue})`,
    fg2: dark ? `oklch(0.75 0.006 ${hue})` : `oklch(0.45 0.01 ${hue})`,
    fg3: dark ? `oklch(0.65 0.006 ${hue})` : `oklch(0.60 0.008 ${hue})`,
    accentSolid: dark ? accent[8] : accent[9],
    accentHover: dark ? accent[7] : accent[8],
    accentActive: dark ? accent[9] : accent[10],
    accentSubtle: dark ? `oklch(0.20 0.04 ${hue})` : accent[3],
    accentText: dark ? accent[11] : accent[10],
    accentOnSolid: "#fff",
    success: `oklch(${dark ? 0.65 : 0.5} 0.22 145)`,
    error: `oklch(${dark ? 0.55 : 0.5} 0.26 30)`,
    warning: `oklch(${dark ? 0.7 : 0.55} 0.18 80)`,
    radius: "5px",
    radiusLg: "8px",
    font: '"Inter", -apple-system, BlinkMacSystemFont, sans-serif',
    fontMono: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  };
}

export const theme: Theme = buildTheme("dark", ARBYTR_HUE);
