# Arbytr UI

Demo UI for the Arbytr Atomic Gateway. Next.js 14, TypeScript, App Router.

## Run

```bash
npm install
npm run dev
```

Open <http://localhost:3000>. Any credentials work — the login is mocked.

## Structure

```
app/
  layout.tsx                     # root html shell
  page.tsx                       # redirect → /login
  login/page.tsx                 # login page (no backend)
  globals.css                    # global styles, font imports
  (app)/                         # route group — all authenticated pages
    layout.tsx                   # wraps children in AppShell
    dashboard/page.tsx
    connect/
      services/page.tsx          # ★ demo priority
      connectors/page.tsx
      tools/page.tsx             # ★ demo priority
      proxy/page.tsx
    access/
      users/page.tsx
      profiles/page.tsx          # ★ demo priority
      permissions/page.tsx       # ★ demo priority
    security/
      vault/page.tsx             # ★ demo priority
      audit/page.tsx             # ★ demo priority
    settings/page.tsx

components/
  brand/Logo.tsx                 # Arbytr wordmark + glyph
  shell/AppShell.tsx             # sidebar + topbar layout, auth guard
  shell/Sidebar.tsx
  shell/Topbar.tsx
  ui/primitives.tsx              # Button, Card, Modal, Badge, etc.

lib/
  theme.ts                       # OKLCH design tokens (Arbytr palette)
  auth.ts                        # localStorage-backed mock session
  mock-data.ts                   # services, tools, users, audit events
```

## Design tokens

`lib/theme.ts` ports `trevorbyrum/ui-ux-components` to a typed module.

- Off-black surface: `oklch(0.07 0.0012 42)`
- Accent (lighter orange): hue 42, drives every accent state across the app
- Single-accent rule: no other hues except feedback (`success`, `error`, `warning`)
- 12-step accent + 13-step tinted neutral scales

Change `ARBYTR_HUE` in `lib/theme.ts` to re-theme everything.

## Backend handoff

Every page reads from `lib/mock-data.ts`. To wire up a real backend:

1. **Mock data layer** — `lib/mock-data.ts` already exposes async accessors
   (`getServices()`, `getTools()`, etc.). Replace the body of each with a
   `fetch()` call. The page components stay unchanged.

2. **Auth** — `lib/auth.ts` writes a session to `localStorage`. Replace with
   NextAuth, Clerk, or your own session helpers. `AppShell` only relies on
   `getSession()` and `signOut()`.

3. **Mutations** — Each page mutates in-memory state with `useState`. To make
   them durable, route the mutations through a hook (e.g. `useServices()`)
   that also issues `POST`/`PATCH`/`DELETE` requests.

4. **Realtime** — Audit events, connection status, and dashboard counts
   should subscribe to the gateway. Add a WebSocket/SSE hook and replace
   the static arrays.

## Notes

- All design choices are driven by tokens in `lib/theme.ts`. Components do
  not hardcode colors.
- The login page is intentionally permissive — any email works. Replace
  `signIn()` with a real authentication call.
- No backend, no database. The app is entirely frontend with mocked state.
