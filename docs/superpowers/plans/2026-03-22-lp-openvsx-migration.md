# LP Waitlist → OpenVSX Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the waitlist registration flow on the AntiCrow landing page with OpenVSX / Antigravity marketplace install buttons, and remove all waitlist-related backend code.

**Architecture:** Minimal swap — keep existing page structure (Hero → Features → Security → FAQ → Disclaimer → CTA → Footer), replace waitlist form with badge-only Hero, convert CTA section to dual install buttons, delete all waitlist/download/admin API endpoints and pages.

**Tech Stack:** React 19, TypeScript, Tailwind CSS, Framer Motion, react-i18next, Cloudflare Pages

**Spec:** `docs/superpowers/specs/2026-03-22-lp-openvsx-migration-design.md`

---

### Task 1: Update i18n files (en.json / ja.json)

**Files:**
- Modify: `landing-page/client/src/i18n/en.json`
- Modify: `landing-page/client/src/i18n/ja.json`

- [ ] **Step 1: Update en.json**

Remove waitlist-related keys, update badge/CTA text, add install keys, remove download section:

```json
{
  "nav": {
    "features": "Features",
    "howItWorks": "How it works",
    "security": "Security",
    "faq": "FAQ",
    "install": "Install"
  },
  "hero": {
    "badge": "Now Available on OpenVSX",
    "headline1": "Connecting Discord",
    "headline2": "and Antigravity —",
    "headline3": "Your Coding Partner",
    "subtitle": "Send a message on Discord. Antigravity codes. Results arrive on Discord. That's it.",
    "docsLink": "📖 View Documentation",
    "docsUrl": "https://anticrow.gitbook.io/anticrow-docs/docs-en/",
    "floatingAiRunning": "AI Running...",
    "floatingRelay": "Discord → Antigravity"
  },
  "cta": {
    "title1": "Ready to",
    "title2": "Code",
    "title3": "from",
    "title4": "Anywhere?",
    "subtitle": "AntiCrow is now available. Install from OpenVSX or the Antigravity marketplace and start coding from your phone.",
    "installOpenVSX": "Install from OpenVSX",
    "searchAntigravity": "Search \"AntiCrow\" in Antigravity",
    "copied": "Copied!",
    "docs": "Documentation",
    "docsUrl": "https://anticrow.gitbook.io/anticrow-docs/docs-en/"
  }
}
```

Note: Keep all other sections (features, security, faq, disclaimer, footer) unchanged. Remove the entire `"download"` section. Remove `"nav.waitlist"` and all `"hero"` keys related to waitlist (`placeholder`, `submit`, `loading`, `successTitle`, `successMessage`, `alreadyRegistered`, `invalidEmail`, `genericError`, `referralHint`, `referralCopied`, `referralApplied`, `share`, `shareXText`, `shareText`). Remove `"cta.button"`.

- [ ] **Step 2: Update ja.json**

Same structure changes as en.json:

```json
{
  "nav": {
    "install": "インストール"
  },
  "hero": {
    "badge": "OpenVSX で公開中"
  },
  "cta": {
    "subtitle": "AntiCrow は公開中です。OpenVSX または Antigravity マーケットプレイスからインストールして、スマホからコーディングを始めよう。",
    "installOpenVSX": "OpenVSX からインストール",
    "searchAntigravity": "Antigravity 内で「AntiCrow」を検索",
    "copied": "コピーしました！"
  }
}
```

Remove `"nav.waitlist"`, all waitlist-related `"hero"` keys, `"cta.button"`, and the entire `"download"` section. Keep existing `"cta.title1"`-`"cta.title4"`, `"cta.docs"`, `"cta.docsUrl"` unchanged — only add the new keys (`installOpenVSX`, `installAntigravity`) and update `subtitle`.

- [ ] **Step 3: Verify JSON validity**

Run: `cd landing-page && node -e "JSON.parse(require('fs').readFileSync('client/src/i18n/en.json','utf8')); JSON.parse(require('fs').readFileSync('client/src/i18n/ja.json','utf8')); console.log('Valid JSON')"`
Expected: `Valid JSON`

- [ ] **Step 4: Commit**

```bash
git add landing-page/client/src/i18n/en.json landing-page/client/src/i18n/ja.json
git commit -m "feat(lp): update i18n for OpenVSX migration — remove waitlist keys, add install keys"
```

---

### Task 2: Simplify HeroSection

**Files:**
- Modify: `landing-page/client/src/components/HeroSection.tsx`

- [ ] **Step 1: Rewrite HeroSection**

Remove all waitlist logic (state, form, API call, referral code, confetti, copy, XLogo). Keep: badge, headline, subtitle, docs link, mascot + floating cards.

```tsx
import { motion } from "framer-motion";
import { Sparkles, ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";

export default function HeroSection() {
  const { t } = useTranslation();

  return (
    <section className="relative min-h-screen flex items-center overflow-hidden pt-20">
      {/* Background Image */}
      <div className="absolute inset-0 z-0">
        <img
          src="https://d2xsxph8kpxj0f.cloudfront.net/310519663098678574/gUFQQZFwAHiwr6GHCExuzr/hero-bg-jLcZDYytnS2mJRk2Y2RK4P.webp"
          alt=""
          aria-hidden="true"
          width={1920}
          height={1080}
          decoding="async"
          fetchPriority="high"
          className="w-full h-full object-cover opacity-40"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-background/60 via-background/40 to-background" />
      </div>

      {/* Floating Orbs */}
      <div className="absolute top-1/4 left-[10%] w-64 h-64 rounded-full bg-indigo/10 blur-[80px] animate-float-orb-1" />
      <div className="absolute bottom-1/4 right-[10%] w-80 h-80 rounded-full bg-coral/10 blur-[100px] animate-float-orb-2" />

      <div className="container relative z-10">
        <div className="grid lg:grid-cols-2 gap-12 lg:gap-16 items-center">
          {/* Left: Text Content */}
          <div className="max-w-2xl">
            {/* Badge */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6 }}
              className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full glass-card mb-8"
            >
              <Sparkles className="w-4 h-4 text-amber" />
              <span className="text-sm font-medium text-amber">
                {t("hero.badge")}
              </span>
            </motion.div>

            {/* Headline */}
            <motion.h1
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.1 }}
              className="font-heading text-4xl sm:text-5xl lg:text-6xl xl:text-7xl font-extrabold leading-[1.1] tracking-tight mb-6"
            >
              <span className="text-foreground">{t("hero.headline1")}</span>
              <br />
              <span className="text-foreground">{t("hero.headline2")}</span>
              <br />
              <span className="text-gradient-primary">{t("hero.headline3")}</span>
            </motion.h1>

            {/* Subtitle */}
            <motion.p
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.2 }}
              className="text-lg sm:text-xl text-muted-foreground leading-relaxed mb-10 max-w-lg"
            >
              {t("hero.subtitle")}
            </motion.p>

            {/* Docs Link */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.7, delay: 0.3 }}
              className="flex items-center gap-3 text-sm text-muted-foreground"
            >
              <a
                href={t("hero.docsUrl")}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 hover:text-foreground transition-colors"
              >
                {t("hero.docsLink")}
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </motion.div>
          </div>

          {/* Right: Mascot + Visual */}
          <motion.div
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.8, delay: 0.3 }}
            className="relative hidden lg:flex items-center justify-center"
          >
            <div className="absolute w-[400px] h-[400px] rounded-full bg-gradient-to-br from-indigo/20 to-coral/20 blur-[60px]" />
            <img
              src="https://d2xsxph8kpxj0f.cloudfront.net/310519663098678574/gUFQQZFwAHiwr6GHCExuzr/AntiCrowFullBody_7b5bfad5.PNG"
              alt="AntiCrow Mascot"
              width={420}
              height={420}
              loading="lazy"
              decoding="async"
              className="relative w-[340px] h-[340px] xl:w-[420px] xl:h-[420px] object-contain drop-shadow-2xl animate-float-mascot"
            />
            <div className="absolute top-8 right-0 glass-card rounded-xl px-4 py-3 animate-float-card-1">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                <span className="text-xs font-medium text-foreground">{t("hero.floatingAiRunning")}</span>
              </div>
            </div>
            <div className="absolute bottom-12 left-0 glass-card rounded-xl px-4 py-3 animate-float-card-2">
              <div className="flex items-center gap-2">
                <span className="text-xs">💬</span>
                <span className="text-xs font-medium text-foreground">{t("hero.floatingRelay")}</span>
              </div>
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add landing-page/client/src/components/HeroSection.tsx
git commit -m "feat(lp): simplify HeroSection — remove waitlist form, keep badge and copy"
```

---

### Task 3: Update CTASection with install buttons

**Files:**
- Modify: `landing-page/client/src/components/CTASection.tsx`

- [ ] **Step 1: Rewrite CTASection**

Replace `#waitlist` link with two external link buttons (OpenVSX primary + Antigravity secondary). Add `id="install"` for Navbar anchor. Keep docs link.

```tsx
import { useState } from "react";
import { motion } from "framer-motion";
import { ExternalLink, Copy, Check } from "lucide-react";
import { useTranslation } from "react-i18next";

function CopyAntigravityButton({ label, copiedLabel }: { label: string; copiedLabel: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText("AntiCrow");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className="inline-flex items-center gap-2 px-6 py-4 rounded-xl font-semibold text-sm text-muted-foreground hover:text-foreground glass-card hover:bg-[oklch(0.22_0.04_260_/_60%)] transition-all"
    >
      {copied ? (
        <>
          <Check className="w-4 h-4 text-green-400" />
          {copiedLabel}
        </>
      ) : (
        <>
          <Copy className="w-4 h-4" />
          {label}
        </>
      )}
    </button>
  );
}

export default function CTASection() {
  const { t } = useTranslation();

  return (
    <section id="install" className="relative py-24 md:py-32 overflow-hidden">
      {/* Background */}
      <div className="absolute inset-0 z-0">
        <img
          src="https://d2xsxph8kpxj0f.cloudfront.net/310519663098678574/gUFQQZFwAHiwr6GHCExuzr/cta-bg-NPUEKsdbVBiekvD9nk3V6H.webp"
          alt=""
          className="w-full h-full object-cover opacity-25"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-background via-background/50 to-background" />
      </div>

      <div className="container relative z-10">
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.7 }}
          className="max-w-3xl mx-auto text-center"
        >
          <h2 className="font-heading text-3xl sm:text-4xl lg:text-5xl xl:text-6xl font-bold tracking-tight mb-5">
            {t("cta.title1")}
            <br />
            <span className="text-gradient-primary">{t("cta.title2")}</span>{t("cta.title3")}
            <br />
            {t("cta.title4")}
          </h2>
          <p className="text-lg text-muted-foreground leading-relaxed mb-8 max-w-lg mx-auto">
            {t("cta.subtitle")}
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <a
              href="https://open-vsx.org/extension/lucianlamp/anti-crow"
              target="_blank"
              rel="noopener noreferrer"
              className="group relative inline-flex items-center gap-3 px-8 py-4 rounded-xl font-semibold text-base overflow-hidden transition-all hover:scale-[1.03] active:scale-[0.98]"
            >
              <span className="absolute inset-0 bg-gradient-to-r from-indigo to-coral" />
              <span className="relative text-white">{t("cta.installOpenVSX")}</span>
              <ExternalLink className="relative w-4 h-4 text-white opacity-70" />
            </a>
            <CopyAntigravityButton label={t("cta.searchAntigravity")} copiedLabel={t("cta.copied")} />
            <a
              href={t("cta.docsUrl")}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-6 py-4 rounded-xl font-semibold text-sm text-muted-foreground hover:text-foreground glass-card hover:bg-[oklch(0.22_0.04_260_/_60%)] transition-all"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25" />
              </svg>
              {t("cta.docs")}
            </a>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
```

**NOTE:** The Antigravity button copies "AntiCrow" to the clipboard on click, so users can paste it into the IDE's extension search. It shows a "Copied!" feedback state for 2 seconds.

- [ ] **Step 2: Commit**

```bash
git add landing-page/client/src/components/CTASection.tsx
git commit -m "feat(lp): update CTASection with OpenVSX and Antigravity install buttons"
```

---

### Task 4: Update Navbar

**Files:**
- Modify: `landing-page/client/src/components/Navbar.tsx`

- [ ] **Step 1: Update Navbar**

Change both desktop and mobile `#waitlist` links to `#install`. Change label from `nav.waitlist` to `nav.install`.

In **desktop CTA** (around line 75-81), change:
- `href="#waitlist"` → `href="#install"`
- `{t("nav.waitlist")}` → `{t("nav.install")}`

In **mobile CTA** (around line 122-128), change:
- `href="#waitlist"` → `href="#install"`
- `{t("nav.waitlist")}` → `{t("nav.install")}`

- [ ] **Step 2: Commit**

```bash
git add landing-page/client/src/components/Navbar.tsx
git commit -m "feat(lp): update Navbar — waitlist link to install anchor"
```

---

### Task 5: Update App.tsx — remove routes

**Files:**
- Modify: `landing-page/client/src/App.tsx`

- [ ] **Step 1: Remove download and admin routes**

Remove lazy imports for `AdminPage` and `DownloadPage`. Remove their `<Route>` entries. Keep `Home`, `NotFound`.

```tsx
import { lazy, Suspense } from "react";
import "./i18n";
import { HelmetProvider } from "react-helmet-async";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";

const NotFound = lazy(() => import("@/pages/NotFound"));

function Router() {
  return (
    <Suspense fallback={<div className="min-h-screen" />}>
      <Switch>
        <Route path={"/"} component={Home} />
        <Route path={"/404"} component={NotFound} />
        <Route component={NotFound} />
      </Switch>
    </Suspense>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <HelmetProvider>
        <ThemeProvider defaultTheme="dark">
          <TooltipProvider>
            <Toaster />
            <Router />
          </TooltipProvider>
        </ThemeProvider>
      </HelmetProvider>
    </ErrorBoundary>
  );
}

export default App;
```

- [ ] **Step 2: Commit**

```bash
git add landing-page/client/src/App.tsx
git commit -m "feat(lp): remove download and admin routes from App.tsx"
```

---

### Task 6: Delete frontend files

**Files:**
- Delete: `landing-page/client/src/pages/AdminPage.tsx`
- Delete: `landing-page/client/src/pages/DownloadPage.tsx`
- Delete: `landing-page/client/src/components/ManusDialog.tsx` (if exists)
- Delete: `landing-page/client/src/components/PricingSection.tsx` (if exists)

- [ ] **Step 1: Delete files**

```bash
cd landing-page
git rm client/src/pages/AdminPage.tsx client/src/pages/DownloadPage.tsx
git rm client/src/components/ManusDialog.tsx 2>/dev/null || true
git rm client/src/components/PricingSection.tsx 2>/dev/null || true
```

- [ ] **Step 2: Commit**

```bash
git commit -m "chore(lp): delete AdminPage, DownloadPage, ManusDialog, PricingSection"
```

---

### Task 7: Delete backend API files

**Files:**
- Delete: `landing-page/functions/api/waitlist/` (entire directory)
- Delete: `landing-page/functions/api/admin/` (entire directory)
- Delete: `landing-page/functions/api/download/` (entire directory)
- Delete: `landing-page/functions/api/validate-code.ts`
- Delete: `landing-page/functions/api/validate-license.ts`
- Delete: `landing-page/functions/api/stripe-webhook.ts`
- Delete: `landing-page/functions/api/latest.ts`
- Delete: `landing-page/functions/functions/` (entire duplicate directory)

- [ ] **Step 1: Delete all API files**

```bash
cd landing-page
git rm -r functions/api/waitlist/ functions/api/admin/
git rm 'functions/api/download/[token].ts'
rmdir functions/api/download 2>/dev/null || true
git rm functions/api/validate-code.ts functions/api/validate-license.ts functions/api/stripe-webhook.ts functions/api/latest.ts
git rm -r functions/functions/
```

- [ ] **Step 2: Commit**

```bash
git commit -m "chore(lp): delete all waitlist, download, and admin API endpoints"
```

---

### Task 8: Delete admin.html and schema.sql

**Files:**
- Delete: `landing-page/admin.html`
- Delete: `landing-page/schema.sql`

- [ ] **Step 1: Delete files**

```bash
cd landing-page
git rm admin.html schema.sql
```

- [ ] **Step 2: Commit**

```bash
git commit -m "chore(lp): delete admin.html and schema.sql"
```

---

### Task 9: Update wrangler.toml and add _redirects

**Files:**
- Modify: `landing-page/wrangler.toml`
- Create: `landing-page/client/public/_redirects` (or `landing-page/dist/public/_redirects` depending on build setup)

- [ ] **Step 1: Update wrangler.toml**

Remove all D1 and R2 bindings:

```toml
name = "anticrow"
compatibility_date = "2024-12-01"
pages_build_output_dir = "dist/public"
```

- [ ] **Step 2: Create _redirects file**

Create `landing-page/client/public/_redirects` (Cloudflare Pages serves files from public/ into the build output):

```
/download / 301
/admin / 301
```

- [ ] **Step 3: Commit**

```bash
cd landing-page
git add wrangler.toml client/public/_redirects
git commit -m "chore(lp): remove D1/R2 bindings, add redirects for removed routes"
```

---

### Task 10: Build verification

- [ ] **Step 1: Install dependencies and build**

Run: `cd landing-page && npm install && npm run build`
Expected: Build succeeds with no TypeScript errors

- [ ] **Step 2: Check for broken imports**

Run: `cd landing-page && npx tsc --noEmit`
Expected: No errors (no references to deleted files remain)

- [ ] **Step 3: Commit any fixes if needed**

If build errors are found, fix them and commit:
```bash
git add -A && git commit -m "fix(lp): resolve build errors from migration cleanup"
```
