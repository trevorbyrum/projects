"use client";

import { useRouter } from "next/navigation";
import { ReactNode, useEffect, useState } from "react";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { getSession, Session } from "@/lib/auth";
import { theme } from "@/lib/theme";

export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const s = getSession();
    if (!s) {
      router.replace("/login");
      return;
    }
    setSession(s);
    setHydrated(true);
  }, [router]);

  if (!hydrated || !session) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: theme.pageBg,
        }}
      />
    );
  }

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: theme.pageBg }}>
      <Sidebar />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <Topbar session={session} />
        <main style={{ flex: 1, padding: "24px 28px 48px", overflow: "auto" }}>
          <div style={{ maxWidth: 1280, margin: "0 auto" }}>{children}</div>
        </main>
      </div>
    </div>
  );
}
