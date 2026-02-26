# CLAUDE.md — GetSalesCloser Project Guide

> Last updated: 2026-02-27 (Session 5 → 6)
> Purpose: Tracks project state, decisions, completed work, and remaining tasks for Claude Code sessions.

---

## Project Overview

Sales automation platform for high-ticket B2B (law, medical, real estate, solar).
Core value: Lead leakage prevention, AI sales coaching, appointment automation, revenue intelligence.
Business model: Freemium with tiered module-based pricing.

**Live URL**: https://www.getsalescloser.com (Vercel)
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
| `index.html` | Landing page, ROI calculator, dynamic pricing engine | ✅ Complete — CTAs wired to `pricing.html` |
| `login.html` | Multi-channel auth (OTP + OAuth) — post-login redirect via `org_members → org_services` | ✅ Fixed (Session 4) |
| `auth.js` | Central auth guard — `requireAuth()` pattern | ✅ Complete |
| `dashboard.html` | "Deal Commander" main UI — all widgets wired to real data | ✅ Complete |
| `dashboard.js` | ~~Deleted~~ — dead code, never loaded by dashboard.html | 🗑️ Deleted |
| `supabase-logic.js` | Lead/profile management — broken field refs removed | ✅ Fixed (Session 4) |
| `pricing.html` | First-time purchase page for new users — plan selector + `create_checkout_intent` | ✅ Fixed (Session 4) — was broken, now wired correctly |
| `billing.html` | Upgrade/manage plan engine for existing subscribers | ✅ Complete |
| `payment.html` | Razorpay checkout + bank transfer — auth guard added | ✅ Fixed (Session 4) |
| `success.html` | Post-payment verification (polls billing_intents for 'paid') | ✅ Working |
| `admin.html` | Finance Command — bank transfers + entitlements + AI Prompt Editor + Rate Limit panel (admin-only) | ✅ Complete |
| `sentinel.html` | Instant Sentinel — lead list + CRM modal + chat surveillance | ✅ Complete |
| `Voice Liaison.html` | Call logs + sentiment + Replay button (VAPI recordings) | ✅ Complete |
| `Knowledge Brain.html` | AI knowledge base — PDF upload + text rules + read/delete view | ✅ Complete |
| `App Architect.html` | Appointment scheduling viewer | ✅ Complete |
| `overview.html` | ~~Deleted~~ — old prototype with wrong table names and dead nav links | 🗑️ Deleted |

---

## Intended User Flow

```
index.html (landing)
  └─> login.html (signup / sign in)
       ├─> Has org + active org_services → dashboard.html
       └─> No active services (new user) → pricing.html
            └─> create_checkout_intent RPC → payment.html
                 └─> Razorpay / Bank Transfer → success.html
                      └─> dashboard.html

dashboard.html
  └─> billing.html (manage/upgrade existing plan)
       └─> create_checkout_intent RPC → payment.html → success.html
```

---

## Edge Functions (supabase/functions/)

| Function | Status | Notes |
|---|---|---|
| `executor_voice` | ✅ Complete | VAPI outbound call trigger |
| `executor_sms` | ✅ Complete | Twilio SMS |
| `executor_email` | ✅ Complete | Resend email |
| `webhook_inbound` | ✅ Complete | Inbound router + VAPI end-of-call-report (captures recordingUrl) |
| `webhook-razorpay` | ✅ Complete | Payment webhook processor |
| `intent_ai` | ✅ Complete | GPT-4o-mini intent classifier (13 labels) |
| `knowledge_brain` | ✅ Complete | Real OpenAI call — GPT-4o-mini (general) / GPT-4o (law, medical) |
| `campaign_ticker` | ✅ Complete | Campaign execution scheduler |
| `decision_engine` | ✅ Complete | Core execution decision logic (reads `decision_plans` table) |
| `execution_planner` | ✅ Complete | Plans execution steps |
| `execution-dispatcher` | ✅ Complete | Dispatches planned executions |
| `notification_dispatcher` | ✅ Complete | Notification routing |
| `task_sweeper` | ✅ Complete | Cleans up stale tasks |
| `voice_turn` | ✅ Complete | VAPI voice turn handler |
| `webhook_cal` | ✅ Complete | Cal.com webhook handler |
| `invoice-reminder-worker` | ✅ Complete | `REMINDER_DRY_RUN=false` set in prod secrets (Session 5) — live emails enabled |
| `org_channels_*` (5 functions) | ✅ Complete | Channel management |
| `context_builder` | ✅ Complete | Context assembly for AI |
| `create-checkout-intent` | ✅ Complete | Razorpay checkout intent |
| `get-payment-config` | ✅ Complete | Payment config fetcher |

**Shared modules** (`_shared/`): db.ts, intent_ai.ts, intent_rules.ts, brain.ts, reply_router.ts,
conversation_state.ts, guardrails/input_sentry.ts, guardrails/output_auditor.ts,
guardrails/prompt_packager.ts, security.ts, retry_policy.ts, strike_time.ts — all complete.

---

## Database

### Confirmed Tables (referenced + verified across codebase)
`profiles`, `leads`, `interactions`, `appointments`, `voice_usage`, `lead_timeline_events`,
`lead_actions`, `org_members`, `org_services`, `org_settings`, `beta_interest`,
`billing_intents`, `payment_attempts`, `knowledge_base`, `security_events`,
`execution_tasks`, `voice_calls`, `notifications`, `campaigns`, `campaign_leads`,
`org_channels`, `org_channel_provision_requests`, `conversation_state`, `active_org_prompts`,
`decision_plans`, `organizations`

### Tables Confirmed & Seeded (Session 5)
| Table | Status |
|---|---|
| `org_billing_profiles` | ✅ Created + RLS applied |
| `decision_plans` | ✅ Confirmed exists, indexes applied |
| `org_prompts` | ✅ Seeded 33 rows (11 orgs × 3 channels); `active_org_prompts` view reads it |
| `organizations.ai_credits_balance` | ✅ Set to 999999 for admin org |

### ❌ Removed from Schema (were dead references)
| Reference | Removed From | Reason |
|---|---|---|
| `user_subscriptions` | `login.html` | Table doesn't exist; replaced with `org_members → org_services` |
| `entitlements` | `pricing.html` | Table doesn't exist; replaced with `org_members → org_services` |
| `properties(nickname)` | `supabase-logic.js` | Table doesn't exist; was legacy real-estate prototype code |
| `leads.conversation_history` | `supabase-logic.js` | Column doesn't exist; conversations live in `interactions` table |

### Storage Buckets
- `logos` — Company branding images
- `documents` — Knowledge Brain PDFs

### Key RPCs
`is_lead_terminal`, `consume_tokens_v1`, `grant_tokens_core_v1`,
`settle_voice_call_tokens_v2`, `resolve_inbound_org_channel_v1`,
`apply_lead_halt_and_cancel`, `cancel_pending_retries_channel`, `approve_bank_transfer`,
`export_lead_timeline`, `get_active_entitlements`, `create_checkout_intent`,
`record_webhook_and_process_razorpay`, `resolve_billing_recipients_v1`,
`is_kill_switch_enabled_v1`, `is_org_member`, `is_org_admin_or_owner`,
`enforce_rate_limit_v1`, `claim_pending_notifications`, `claim_campaign_leads`,
`fetch_due_tasks`, `execution_policy_v1`

---

## Architecture Patterns

### Auth Guard
All protected pages use `auth.js` → `requireAuth()`.
- Requires `<script src="auth.js">` loaded before page script
- Requires `<div id="auth-loader">` (loading screen, visible by default)
- Requires `<div id="page-content">` (hidden by default, shown on auth success)
- Callback pattern: `requireAuth({ onAuthenticated: (profile, user, sb) => { /* page logic */ } })`
- **Exception**: `pricing.html` and `payment.html` use inline auth-loader pattern (no auth.js); both redirect to `login.html` on no session

### Entitlement Check Pattern (all module pages)
```js
const { data: membership } = await sb.from('org_members').select('org_id').eq('user_id', user.id).limit(1).single();
const { data: service } = await sb.from('org_services').select('status').eq('org_id', membership.org_id).eq('service_key', serviceKey).maybeSingle();
if (service?.status !== 'active') window.location.href = 'billing.html?lock={key}';
```

### Service Entitlement Keys
| Module | service_key |
|---|---|
| Instant Sentinel | `sentinel` |
| Voice Liaison | `voice` |
| Knowledge Brain | `brain` |
| App Architect | `architect` |

### Token System
- Voice: 5 tokens pre-debit, settled via `settle_voice_call_tokens_v2`
- SMS: 1 token per message
- Email: 1 token per message
- Refund on failure via `grant_tokens_core_v1`

### Billing Lock Guard (voice execution)
`executor_voice` and `voice_turn` both query `org_billing_profiles.billing_lock_status`.
- No row for org = `"none"` = not locked (safe default)
- Query ERROR = fail-closed (blocks all voice spend) — **table must exist**
- Lock values: `none`, `soft_lock`, `hard_lock`, `manual_lock`

### Pricing Modules
- Base: Instant Sentinel ($49), Voice Liaison ($149)
- Add-ons: Knowledge Brain, App Architect
- Rules: Knowledge Brain & App Architect require Sentinel or Voice as base
- Elite bundle: Voice + Brain + Architect = $349/mo
- Pricing logic lives in: `pricing.html` (new users) and `billing.html` (existing users)

---

## Pending Work (TODO)

### ✅ ALL CRITICAL + HIGH PRIORITY ITEMS COMPLETE (Session 5)

| # | Task | Status |
|---|---|---|
| P1 | `org_billing_profiles` SQL migration | ✅ Done |
| P2 | `org_prompts` seeded (11 orgs × 3 channels) | ✅ Done |
| P3 | `ai_credits_balance = 999999` | ✅ Done |
| P4 | `REMINDER_DRY_RUN=false` in Supabase secrets | ✅ Done |
| P5 | Landing page CTAs → `pricing.html` | ✅ Done |
| P6 | `decision_plans` indexes confirmed | ✅ Done |
| P7 | Admin AI Prompt Editor (inline edit per org×channel) | ✅ Done |
| P8 | Admin Rate Limit & Security panel (exec stats + billing lock + kill switch) | ✅ Done |

### ✅ ALL LOW PRIORITY ITEMS COMPLETE

| # | Task | Status |
|---|---|---|
| P9 | `conversation_state` TTL — pg_cron job, daily 3am UTC, 90-day expiry | ✅ Done (cron job id=8) |
| P10 | `pricing.html` → `auth.js` pattern | ✅ Done |

---

## 🧪 END-TO-END TEST PLAN (Next Session)

**Status: NOT STARTED — must be done before launch**

### 1. Auth Flow
- [ ] `index.html` → Deploy My Closer → lands on `pricing.html` (not login)
- [ ] `pricing.html` visited while logged out → redirects to `login.html`
- [ ] New account signup → lands on `pricing.html`
- [ ] Existing account with active services → lands on `dashboard.html`

### 2. Pricing → Payment
- [ ] Select modules on `pricing.html` → Deploy → redirects to `payment.html?intent_id=...`
- [ ] Razorpay or Bank Transfer → `billing_intents` row created in Supabase

### 3. Dashboard
- [ ] Live Traffic panel loads
- [ ] System Monitor / war-room feed shows recent interactions
- [ ] Revenue Doctor Priority Action card shows real data
- [ ] Sidebar module links correct (locked ones show lock icon)

### 4. Module Pages
- [ ] **Sentinel** — lead list loads; "View Full CRM Profile" modal opens with data
- [ ] **Voice Liaison** — call log loads; Replay button appears on rows with recordings
- [ ] **Knowledge Brain** — PDF upload works; text rule saves; Stored Knowledge list shows entries; delete works
- [ ] **App Architect** — appointment list loads

### 5. Admin Panel
- [ ] Only `anurag@yogmayaindustries.com` can access (others redirect to dashboard)
- [ ] Bank Transfers table loads
- [ ] Active Entitlements table loads
- [ ] AI Prompt Editor — prompts show per org×channel; inline edit → save works
- [ ] Rate Limit panel — org rows with task counts + billing lock status

---

## Completed Work Log

### Session 4 — 2026-02-26 (Schema Audit + Full Wiring Fixes)

**Security:**
- `dashboard.html`: Fixed XSS in `subscribeToInteractions()` — `payload.new.content` now set via `textContent` not `innerHTML`

**Auth & Flow:**
- `login.html`: Replaced broken `user_subscriptions` check (table doesn't exist) with real `org_members → org_services` entitlement pattern
- `pricing.html`: Replaced broken `entitlements` table check with `org_members → org_services`; fixed dead `overview.html` redirect → `dashboard.html`; added page-load auth guard with loader overlay
- `payment.html`: Added auth-loader overlay; content hidden until session + intent confirmed; fixed dead `overview.html` redirect → `dashboard.html`

**UI Completeness:**
- `dashboard.html`: Added `loadLiveTraffic()` — fetches top-15 org leads by last activity, renders status badge + risk dot + timeAgo in Live Traffic panel
- `dashboard.html`: Added `loadRecentInteractions()` — pre-populates System Monitor / war-room-feed with last 10 org interactions on load
- `Voice Liaison.html`: Added Replay button — checks `metadata.recording_url`; opens audio player modal; dismiss via × or backdrop

**Backend:**
- `webhook_inbound`: Extracts `recordingUrl` from VAPI `end-of-call-report` payload; stores as `interactions.metadata.recording_url`

**Dead Code / Schema Cleanup:**
- `supabase-logic.js`: Removed `properties(nickname)` join (table doesn't exist); removed `lead.conversation_history` reference (field doesn't exist); replaced with real columns `lead.source` + `lead.last_interaction_at`

**Migrations:**
- Created `supabase/migrations/20260226_org_billing_profiles.sql` — ⚠️ MUST be run manually in Supabase

---

### Session 3 — 2026-02-26

- `sentinel.html`: "View Full CRM Profile" modal — full lead fields + `lead_timeline_events` timeline
- `Knowledge Brain.html`: "Stored Knowledge" read view — lists all entries, type badge, preview, delete
- `dashboard.html`: `runRevenueDiagnosis()` wired to real `interactions` data; Priority Action card updates live
- `dashboard.html`: `subscribeToInteractions()` — real-time feed via Supabase Realtime
- `dashboard.js`: Deleted (confirmed dead code)

---

### Session 1 — 2026-02-26

- `admin.html`: `is_admin` check added; non-admins redirect to dashboard
- `sentinel.html`, `Voice Liaison.html`, `App Architect.html`, `Knowledge Brain.html`: auth guards + entitlement locks added
- `overview.html`: Deleted (old prototype)
- SQL: `profiles.is_admin` column added; `anurag@yogmayaindustries.com` set as admin

---

## SQL Migrations

### Applied
```sql
-- is_admin column (Session 1)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT false;
UPDATE profiles SET is_admin = true WHERE email = 'anurag@yogmayaindustries.com';
```

### Session 5 — Applied (2026-02-27)
- `org_billing_profiles` table created with RLS
- `org_prompts` seeded: 11 orgs × 3 channels (sms/email/voice), safety_level='moderate'
- `organizations.ai_credits_balance = 999999` for admin org
- `decision_plans` indexes confirmed
- Admin RLS policies added: `org_prompts` (select+update), `execution_tasks` (select), `org_billing_profiles` (select), `org_settings` (select+update)

---

## Known Non-Issues (Memory Corrections)

- `knowledge_brain` Edge Function has full OpenAI integration with GPT-4o/GPT-4o-mini model selection — NOT a stub
- `admin.html` credentials are real — NOT placeholders
- `success.html` billing_intents polling is active and working
- `dashboard.html` sidebar already queries `org_services` live — entitlements were already done in Session 1
- `org_billing_profiles` query returning null (no row) is safe — only a query ERROR triggers fail-closed
