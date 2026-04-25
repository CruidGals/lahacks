<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Cleanr — frontend

A bounty marketplace for civic cleanup. Mobile-first PWA-style web app, designed for iPhone Safari/Chrome.

## Architecture

- `app/` — Next.js 16 App Router. Most pages are `"use client"` since they need GPS, camera, and live state.
  - `_components/` — shared UI primitives (Button, Card, Sheet, Toast, Skeleton, EmptyState, BottomNav, AppShell, ScreenHeader, BountyMap, CameraCapture, WorldIdGate).
  - `bounty/[id]/` — detail → `start` → `verify` → `submitted` flow.
  - `post/` — multi-step bounty posting flow.
  - `profile/`, `leaderboard/`, `onboarding/` — top-level tabs and World ID gate.
- `lib/` — typed mock API (`api.ts`), domain types (`types.ts`), seed data (`mock-data.ts`), formatting helpers (`format.ts`), client hooks (`useGeolocation.ts`, `useTaskSession.ts`).

## Mock API

All network calls go through `lib/api.ts`. State is persisted in `localStorage` under `cleanr.state.v1` so a demo flow survives reloads. To wire a real backend later, swap each function body with a `fetch(...)` — the contract on the consumer side does not change.

## Design system

- White surfaces, single saturated green accent (`--color-brand-500: #16a34a`). All tokens in `app/globals.css` via Tailwind v4 `@theme inline`.
- Mobile-first: max-width 480px frame, safe-area insets for top/bottom, no laptop-style scaling.
- Bottom nav (Map · Leaderboard · Profile) auto-hides on `/onboarding`, `/post`, and any `/bounty/...` screen — those screens render their own chrome.

## Notes for future agents

- Params are Promises in Next.js 16 — use `use(params)` in client components, `await params` in server components.
- Leaflet has to be imported via `next/dynamic` with `ssr: false` (see `BountyMapClient.tsx`); it touches `window` at module level.
- The "360° camera" is faked with the device camera + a guided pan UI + a faded ghost overlay representing the poster's reference frame.
