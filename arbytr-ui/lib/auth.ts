/**
 * Demo-only auth. Stores a flag in localStorage to gate the app shell.
 * Backend swap: replace these with real session helpers (NextAuth, JWT, etc).
 */

const KEY = "arbytr:session";

export type Session = {
  email: string;
  name: string;
  initials: string;
  org: string;
};

export function signIn(email: string): Session {
  const namePart = email.split("@")[0] || "user";
  const tidy = namePart
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  const initials = tidy
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const session: Session = {
    email,
    name: tidy,
    initials,
    org: "Acme Inc.",
  };
  if (typeof window !== "undefined") {
    localStorage.setItem(KEY, JSON.stringify(session));
  }
  return session;
}

export function signOut() {
  if (typeof window !== "undefined") {
    localStorage.removeItem(KEY);
  }
}

export function getSession(): Session | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}
