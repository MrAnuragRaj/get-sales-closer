# CLAUDE.md — GetSalesCloser Project Guide

> Last updated: 2026-02-26 (Session 2)
> Purpose: Tracks project state, decisions, completed work, and remaining tasks for Claude Code sessions.

---

## Project Overview

Sales automation platform for high-ticket B2B (law, medical, real estate, solar).
Core value: Lead leakage prevention, AI sales coaching, appointment automation, revenue intelligence.
Business model: Freemium with tiered module-based pricing.

**Live URL**: Hosted on Vercel
**Supabase Project**: https://klbwigcvrdfeeeeotehu.supabase.co

---

## Tech Stack

| Layer | Choice |
|---|---|
| Frontend | Vanilla HTML5 + Tailwind CSS (CDN) + Vanilla ES6+ JS |
| Icons | FontAwesome 6.4.0 (CDN) |
| Fonts | Google Fonts — Inter |
| Backend | Supabase (PostgreSQL + Auth + Storage + Edge Functions) |
| Payments | Razorpay (live key in payment.html) |
| Hosting | Vercel |
| Auth | Supabase Auth — Email/Password, Phone OTP, OAuth |
| AI | OpenAI GPT-4o-mini (intent), GPT-4o (knowledge brain for law/medical) |
| Voice | VAPI outbound calls |
| SMS | Twilio |
| Email | Resend |

---

## File Map

| File | Purpose | Status |
|---|---|---|
| `index.html` | Landing page, ROI calculator, dynamic pricing engine | ✅ Complete |
| `login.html` | Multi-channel auth (OTP + OAuth) | ✅ Complete |
| `auth.js` | Central auth guard — `requireAuth()` pattern | ✅ Complete |
| `dashboard.html` | "Deal Commander" main UI | ✅ Complete |
| `dashboard.js` | ⚠️ DEAD CODE — not loaded by dashboard.html. All logic lives inline in dashboard.html | ⚠️ Dead file |
| `supabase-logic.js` | Lead/profile management | ✅ Complete |
| `billing.html` | Upgrade/feature toggle engine | ✅ Complete |
| `payment.html` | Razorpay checkout + bank transfer | ✅ Complete |
| `success.html` | Post-payment verification (polls billing_intents for 'paid') | ✅ Working |
| `admin.html` | Finance Command — bank transfers + entitlements | ✅ Fixed (see changelog) |
| `sentinel.html` | Instant Sentinel — lead list + chat surveillance | ✅ Fixed (see changelog) |
| `Voice Liaison.html` | Call logs + sentiment analysis | ✅ Fixed (see changelog) |
| `Knowledge Brain.html` | AI knowledge base — PDF upload + text rules | ✅ Fixed (see changelog) |
| `App Architect.html` | Appointment scheduling viewer | ✅ Fixed (see changelog) |
| `overview.html` | ~~Deleted~~ — was an old prototype with wrong table names and dead nav links | 🗑️ Deleted |
| `billing.html` | Plan management | ✅ Complete |

---

## Edge Functions (supabase/functions/)

| Function | Status | Notes |
|---|---|---|
| `executor_voice` | ✅ Complete | VAPI outbound call trigger |
| `executor_sms` | ✅ Complete | Twilio SMS |
| `executor_email` | ✅ Complete | Resend email |
| `webhook_inbound` | ✅ Complete | Inbound message router |
| `webhook-razorpay` | ✅ Complete | Payment webhook processor |
| `intent_ai` | ✅ Complete | GPT-4o-mini intent classifier (13 labels) |
| `knowledge_brain` | ✅ Complete | Real OpenAI call — GPT-4o-mini (general) / GPT-4o (law, medical) |
| `campaign_ticker` | ✅ Complete | Campaign execution scheduler |
| `decision_engine` | ✅ Complete | Core execution decision logic |
| `execution_planner` | ✅ Complete | Plans execution steps |
| `execution-dispatcher` | ✅ Complete | Dispatches planned executions |
| `notification_dispatcher` | ✅ Complete | Notification routing |
| `task_sweeper` | ✅ Complete | Cleans up stale tasks |
| `voice_turn` | ✅ Complete | VAPI voice turn handler |
| `webhook_cal` | ✅ Complete | Cal.com webhook handler |
| `invoice-reminder-worker` | ✅ Complete | Invoice reminders |
| `org_channels_*` (5 functions) | ✅ Complete | Channel management |
| `context_builder` | ✅ Complete | Context assembly for AI |
| `create-checkout-intent` | ✅ Complete | Razorpay checkout intent |
| `get-payment-config` | ✅ Complete | Payment config fetcher |

**Shared modules** (`_shared/`): db.ts, intent_ai.ts, intent_rules.ts, brain.ts, reply_router.ts,
conversation_state.ts, guardrails/input_sentry.ts, guardrails/output_auditor.ts,
guardrails/prompt_packager.ts, security.ts, retry_policy.ts, strike_time.ts — all complete.

---

## Database

### Tables
`profiles`, `leads`, `interactions`, `appointments`, `voice_usage`, `lead_timeline_events`,
`lead_actions`, `org_members`, `org_services`, `user_subscriptions`, `beta_interest`,
`billing_intents`, `knowledge_base`, `org_settings`, `security_events`

### Storage Buckets
- `logos` — Company branding images
- `documents` — Knowledge Brain PDFs

### Key RPCs
`is_lead_terminal`, `consume_tokens_v1`, `grant_tokens_core_v1`,
`settle_voice_call_tokens_v2`, `resolve_inbound_org_channel_v1`,
`apply_lead_halt_and_cancel`, `cancel_pending_retries_channel`, `approve_bank_transfer`,
`export_lead_timeline`, `get_active_entitlements`, `create_checkout_intent`,
`record_webhook_and_process_razorpay`

---

## Architecture Patterns

### Auth Guard
All protected pages use `auth.js` → `requireAuth()`.
- Requires `<script src="auth.js">` loaded before page script
- Requires `<div id="auth-loader">` (loading screen, visible by default)
- Requires `<div id="page-content">` (hidden by default, shown on auth success)
- Callback pattern: `requireAuth({ onAuthenticated: (profile, user, sb) => { /* page logic */ } })`

### Service Entitlements
`org_services` table tracks active modules.
Locked modules redirect to: `billing.html?lock={module}`

### Token System
- Voice: 5 tokens pre-debit, settled via `settle_voice_call_tokens_v2`
- SMS: 1 token per message
- Email: 1 token per message

### Pricing Modules
- Instant Sentinel, Voice Liaison, Knowledge Brain, App Architect
- Rules: Knowledge Brain & App Architect require Sentinel or Voice as base
- Elite bundle: Voice + Brain + Architect = $349/mo

---

## Pending Work (TODO)

### 🔴 High Priority

| # | Task | File(s) | Notes |
|---|---|---|---|
| 1 | ~~`is_admin` SQL migration~~ | ✅ Done | `anurag@yogmayaindustries.com` set as admin |
| 2 | ~~Sidebar entitlements~~ | ✅ Already done in dashboard.html | `renderSidebar()` queries `org_services` live |
| 3 | ~~Revenue Doctor real data~~ | ✅ Moved to dashboard.html | `runRevenueDiagnosis()` wired to `interactions` table; updates Priority Action card in real time |
| 4 | ~~`overview.html`~~ | 🗑️ Deleted | Old prototype — conflicts with current page structure |

### 🟡 Medium Priority

| # | Task | File(s) | Notes |
|---|---|---|---|
| 5 | ~~Entitlement lock on module pages~~ | ✅ Done | All 4 module pages now check `org_services` and redirect to `billing.html?lock={key}` if inactive |
| 6 | Knowledge Brain — read view of existing entries | `Knowledge Brain.html` | Currently only write (upload/save) — no list of existing docs/rules displayed |
| 7 | Sentinel — "View Full CRM Profile" button | `sentinel.html` | Button has no `onclick` — needs to link to a lead detail page |
| 8 | ~~`dashboard.html` Priority Action card~~ | ✅ Done | `runRevenueDiagnosis()` now updates card text + badge + border color based on real interaction delay |
| 9 | ~~`dashboard.html` war-room-feed~~ | ✅ Done | `subscribeToInteractions()` added — new interactions stream in via Supabase Realtime |

### 🟢 Low Priority / Nice to Have

| # | Task | File(s) | Notes |
|---|---|---|---|
| 10 | `dashboard.js` — dead code file | `dashboard.js` | Never loaded. Can be deleted or its Revenue Doctor logic moved into dashboard.html |
| 11 | Voice Liaison — "Replay" button | `Voice Liaison.html` | Needs VAPI recording URL to work |

---

## SQL Migrations Applied

### is_admin column (applied 2026-02-26)
```sql
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT false;
UPDATE profiles SET is_admin = true WHERE email = 'anurag@yogmayaindustries.com';
-- Result: Success
```

---

## Changelog

### 2026-02-26 — Session 1

**Fixed:**
- `admin.html`: Added `is_admin` profile check — non-admin users redirected to dashboard.html
- `sentinel.html`: Added `auth.js` requireAuth() guard + `checkEntitlement('sentinel')` lock; removed duplicate Supabase SDK script tag; fixed fragile querySelector with proper id selectors
- `Voice Liaison.html`: Added `auth.js` requireAuth() guard + `checkEntitlement('voice')` lock
- `App Architect.html`: Added `auth.js` requireAuth() guard + `checkEntitlement('architect')` lock; removed duplicate Supabase SDK script tag
- `Knowledge Brain.html`: Added `auth.js` requireAuth() guard + `checkEntitlement('brain')` lock; removed redundant inline session calls
- `overview.html`: Deleted — was an old prototype with wrong table names, dead nav links, and a crash bug

**SQL Applied:**
- `profiles` table: Added `is_admin BOOLEAN DEFAULT false` column
- `anurag@yogmayaindustries.com` set as admin

**Discovered:**
- `dashboard.js` is dead code — never loaded by dashboard.html. dashboard.html has all logic inline.
- `dashboard.html` sidebar (`renderSidebar()`) already queries `org_services` with real entitlements — was already done.
- `handleLockedClick` in dead `dashboard.js` fixed from `pricing.html` → `billing.html` (but irrelevant since file not loaded)

**Corrected memory (previous notes were wrong):**
- `knowledge_brain` Edge Function — already fully implemented with real OpenAI calls; NOT a stub
- `admin.html` — already had real Supabase credentials; NOT placeholders
- `success.html` — poll filter was already working; NOT commented out

---

## Known Non-Issues (Memory Corrections)

These were flagged as gaps but are actually already implemented:
- `knowledge_brain` Edge Function has full OpenAI integration with GPT-4o/GPT-4o-mini model selection
- `admin.html` credentials are real (not placeholder)
- `success.html` billing_intents polling is active and working
