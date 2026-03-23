# Project Context for Codex

## Overview
AntiCrow landing page — a React SPA deployed on Cloudflare Pages. Currently migrating from waitlist registration to OpenVSX install buttons.

## Tech Stack
- Runtime: Node.js (pnpm 10.4.1)
- Framework: React 19 + Vite 7
- Language: TypeScript 5.6
- Styling: Tailwind CSS 4 + Framer Motion
- i18n: react-i18next (en.json / ja.json)
- Router: wouter
- Deploy: Cloudflare Pages (wrangler)

## Directory Structure
- `client/src/components/` — React components (HeroSection, CTASection, Navbar, etc.)
- `client/src/pages/` — Page components (Home, NotFound)
- `client/src/i18n/` — Translation JSON files (en.json, ja.json)
- `client/src/contexts/` — React context providers
- `client/public/` — Static assets
- `functions/api/` — Cloudflare Pages Functions (API endpoints)

## Coding Conventions
- Components use default exports
- Framer Motion for animations
- Tailwind utility classes (oklch color space)
- i18n keys accessed via `useTranslation()` hook with `t()` function
- Glass-card design pattern with `glass-card` CSS class

## Key Scripts
- `pnpm dev` — Start dev server
- `pnpm build` — Build for production
- `pnpm check` — TypeScript check (`tsc --noEmit`)
- `pnpm deploy` — Deploy to Cloudflare Pages

## Constraints
- Do NOT modify files outside the task scope
- Follow existing Tailwind patterns and animation conventions
- Keep i18n keys in both en.json and ja.json in sync
- Do NOT install new dependencies
