"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { Button, Input, Card } from "@/components/ui/primitives";
import { Logo } from "@/components/brand/Logo";
import { theme } from "@/lib/theme";
import { signIn } from "@/lib/auth";

export default function LoginPage() {
  const t = theme;
  const router = useRouter();
  const [email, setEmail] = useState("trevor@arbytr.com");
  const [password, setPassword] = useState("demo");
  const [loading, setLoading] = useState(false);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!email) return;
    setLoading(true);
    setTimeout(() => {
      signIn(email);
      router.push("/dashboard");
    }, 400);
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        position: "relative",
        overflow: "hidden",
        background: t.pageBg,
      }}
    >
      {/* ambient accent glow */}
      <div
        style={{
          position: "absolute",
          top: "-20%",
          left: "50%",
          transform: "translateX(-50%)",
          width: 800,
          height: 800,
          borderRadius: "50%",
          background: `radial-gradient(circle, oklch(0.50 0.20 ${t.hue} / 0.18), transparent 60%)`,
          pointerEvents: "none",
        }}
      />
      <div
        style={{
          position: "absolute",
          bottom: "-30%",
          right: "-10%",
          width: 600,
          height: 600,
          borderRadius: "50%",
          background: `radial-gradient(circle, oklch(0.50 0.20 ${t.hue} / 0.08), transparent 60%)`,
          pointerEvents: "none",
        }}
      />

      <div
        style={{
          width: "100%",
          maxWidth: 420,
          position: "relative",
          zIndex: 1,
        }}
      >
        <div style={{ marginBottom: 28, display: "flex", justifyContent: "center" }}>
          <Logo size={32} />
        </div>

        <Card padding={28}>
          <div style={{ marginBottom: 22 }}>
            <h1
              style={{
                fontSize: 20,
                fontWeight: 600,
                margin: 0,
                marginBottom: 6,
                color: t.fg1,
                letterSpacing: "-0.02em",
              }}
            >
              Sign in
            </h1>
            <p style={{ fontSize: 13, color: t.fg3, margin: 0, lineHeight: 1.5 }}>
              Welcome back to your Atomic Gateway.
            </p>
          </div>

          <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <Input
              label="Email"
              type="email"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
            />
            <div>
              <Input
                label="Password"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}>
                <a
                  href="#"
                  style={{
                    fontSize: 12,
                    color: t.accentText,
                    textDecoration: "none",
                  }}
                >
                  Forgot password?
                </a>
              </div>
            </div>

            <Button variant="accent" type="submit" disabled={loading} style={{ justifyContent: "center", width: "100%" }}>
              {loading ? "Signing in…" : "Sign in"}
            </Button>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                margin: "4px 0",
              }}
            >
              <div style={{ flex: 1, height: 1, background: t.border }} />
              <span style={{ fontSize: 11, color: t.fg3, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                or
              </span>
              <div style={{ flex: 1, height: 1, background: t.border }} />
            </div>

            <Button variant="secondary" onClick={() => onSubmit(new Event("submit") as unknown as FormEvent)} style={{ justifyContent: "center", width: "100%" }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" opacity="0.7" />
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" opacity="0.5" />
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z" opacity="0.3" />
              </svg>
              Continue with Google
            </Button>

            <Button variant="secondary" onClick={() => onSubmit(new Event("submit") as unknown as FormEvent)} style={{ justifyContent: "center", width: "100%" }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.4 3-.405 1.02.005 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
              </svg>
              Continue with GitHub
            </Button>
          </form>

          <p style={{ fontSize: 12, color: t.fg3, textAlign: "center", marginTop: 22, marginBottom: 0 }}>
            Don&apos;t have an account?{" "}
            <a href="#" style={{ color: t.accentText, textDecoration: "none", fontWeight: 500 }}>
              Request access
            </a>
          </p>
        </Card>

        <p
          style={{
            fontSize: 11,
            color: t.fg3,
            textAlign: "center",
            marginTop: 18,
            lineHeight: 1.6,
          }}
        >
          By signing in, you agree to Arbytr&apos;s{" "}
          <a href="#" style={{ color: t.fg2 }}>
            Terms
          </a>{" "}
          and{" "}
          <a href="#" style={{ color: t.fg2 }}>
            Privacy Policy
          </a>
          .
        </p>
      </div>
    </div>
  );
}
