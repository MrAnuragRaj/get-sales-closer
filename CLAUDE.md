# CLAUDE.md — GetSalesCloser Project Guide

> Last updated: 2026-03-04 (Session 10)
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
| `login.html` | Multi-channel auth (OTP + OAuth + Email/Password Sign In) — post-login redirect via `org_members → org_services` + invitation claim + role routing | ✅ Updated (Session 10) — invitation auto-claim + role-based routing (agency_admin/enterprise_admin/enterprise_agent/solo) |
| `auth.js` | Central auth guard — `requireAuth()` pattern | ✅ Complete |
| `dashboard.html` | "Deal Commander" main UI — all widgets wired to real data | ✅ Complete |
| `dashboard.js` | ~~Deleted~~ — dead code, never loaded by dashboard.html | 🗑️ Deleted |
| `supabase-logic.js` | Lead/profile management — broken field refs removed | ✅ Fixed (Session 4) |
| `pricing.html` | First-time purchase page for new users — plan selector + `create_checkout_intent` | ✅ Fixed (Session 4) — was broken, now wired correctly |
| `billing.html` | Upgrade/manage plan engine for existing subscribers | ✅ Complete |
| `payment.html` | Razorpay checkout + bank transfer — auth guard added | ✅ Fixed (Session 4 + Session 8) — `markAsSent()` now calls `mark_intent_awaiting_bank` RPC |
| `success.html` | Post-payment verification (polls billing_intents for 'paid') | ✅ Working |
| `admin.html` | Finance Command — bank transfers + entitlements + AI Prompt Editor + Rate Limit panel + Partial Payment + Pending Deals + Create Deal form (admin-only) | ✅ Updated (Session 10) — added Pending Agency/Enterprise Deals section + Create Deal form |
| `sentinel.html` | Instant Sentinel — lead list + CRM modal + chat surveillance | ✅ Complete |
| `Voice Liaison.html` | Call logs + sentiment + Replay button (VAPI recordings) | ✅ Complete |
| `Knowledge Brain.html` | AI knowledge base — PDF upload + text rules + read/delete view | ✅ Complete |
| `App Architect.html` | Appointment scheduling viewer | ✅ Complete |
| `overview.html` | ~~Deleted~~ — old prototype with wrong table names and dead nav links | 🗑️ Deleted |
| `agency_admin.html` | Agency Admin Portal — seat usage, user management, invite/remove, pending invites | ✅ Created (Session 10) |
| `enterprise_admin.html` | Enterprise Command — leaderboard, agent management, overseer slide-out, reassign leads, pause campaigns | ✅ Created (Session 10) |
| `agent_dashboard.html` | Enterprise Agent Dashboard — my leads, status filter tabs, add lead modal, AI outreach toggle, activity feed | ✅ Created (Session 10) |

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

dashboard.html  ← solo users + agency clients (NULL role)
  └─> billing.html (manage/upgrade existing plan)
       └─> create_checkout_intent RPC → payment.html → success.html

agency_admin.html  ← role='agency_admin'
  └─> Add/remove client users within seat limit

enterprise_admin.html  ← role='enterprise_admin'
  └─> Leaderboard + Agent management + Overseer panel

agent_dashboard.html  ← role='enterprise_agent'
  └─> My leads + Add lead + AI outreach trigger
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
| `notify-partial-payment` | ✅ Complete (Session 8) | Admin-triggered partial payment email via Resend — deployed with `--no-verify-jwt`; function handles its own admin auth via `app_admins` table |

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
`decision_plans`, `organizations`, `org_invitations`

### Tables Confirmed & Seeded (Session 5)
| Table | Status |
|---|---|
| `org_billing_profiles` | ✅ Created + RLS applied |
| `decision_plans` | ✅ Confirmed exists, indexes applied |
| `org_prompts` | ✅ Seeded 33 rows (11 orgs × 3 channels); `active_org_prompts` view reads it |
| `organizations.ai_credits_balance` | ✅ Set to 999999 for admin org |

### New Tables / Columns (Session 10)
| Object | Type | Notes |
|---|---|---|
| `organizations.seat_limit` | column INTEGER | NULL = unlimited (solo); positive = seat cap for agency/enterprise |
| `organizations.org_type` | column TEXT | NULL = solo, 'agency', 'enterprise' |
| `org_members.role` | column TEXT | NULL = solo/agency client; 'agency_admin'; 'enterprise_admin'; 'enterprise_agent' |
| `org_members.credit_limit` | column INTEGER | NULL = no cap; enterprise_admin can cap per-agent token spend |
| `org_members.campaigns_paused` | column BOOLEAN | Default FALSE; enterprise_admin can pause individual agent campaigns |
| `leads.assigned_to` | column UUID | References auth.users; NULL = unassigned (solo org) |
| `org_invitations` | table | Pending invites auto-claimed on first login; RLS allows agency/enterprise admins to manage |

### New RPCs (Session 10)
| RPC | Purpose |
|---|---|
| `create_agency_enterprise_deal(...)` | Admin-only: create org + billing_intent with intent_source='admin_deal' |
| `approve_agency_enterprise_deal(p_intent_id)` | Admin-only: mark paid, activate org_services, create invitation (or direct link if user exists), allocate initial AI credits |
| `get_agent_leaderboard(p_org_id)` | Returns top 5 agents by closed_won + win_rate |

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
`mark_intent_awaiting_bank`, `export_lead_timeline`, `get_active_entitlements`,
`create_checkout_intent`, `record_webhook_and_process_razorpay`, `resolve_billing_recipients_v1`,
`is_kill_switch_enabled_v1`, `is_org_member`, `is_org_admin_or_owner`,
`enforce_rate_limit_v1`, `claim_pending_notifications`, `claim_campaign_leads`,
`fetch_due_tasks`, `execution_policy_v1`,
`create_agency_enterprise_deal`, `approve_agency_enterprise_deal`, `get_agent_leaderboard`

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

### 🔜 Phase 4 — Deferred (NOT started)
- **Vertical Lexicon / Persona Injection** — per-org AI persona config, industry-specific language packs, persona editor in admin panel
- Deferred by design — Phase 4 scope was explicitly excluded from current implementation

### 🧪 Multi-Tenant E2E Tests (next session, before any first agency/enterprise deal goes live)

| # | Test | Status |
|---|---|---|
| MT1 | Create Deal form → RPC creates org + billing_intent with intent_source='admin_deal' | ⬜ Not tested |
| MT2 | Confirm Payment button → org_services activated + org_invitations row created | ⬜ Not tested |
| MT3 | Copy Payment Instructions → correct email text with ref ID on clipboard | ⬜ Not tested |
| MT4 | Invited owner logs in → org_invitations claimed → org_members row created + invite deleted | ⬜ Not tested |
| MT5 | agency_admin logs in → lands on agency_admin.html (not dashboard) | ⬜ Not tested |
| MT6 | enterprise_admin logs in → lands on enterprise_admin.html | ⬜ Not tested |
| MT7 | enterprise_agent logs in → lands on agent_dashboard.html | ⬜ Not tested |
| MT8 | agency_admin Add User → seat limit check works; invite shows in Pending list | ⬜ Not tested |
| MT9 | agency_admin seat limit reached → "Seat limit reached" warning shown in modal | ⬜ Not tested |
| MT10 | enterprise_admin leaderboard → get_agent_leaderboard RPC returns data | ⬜ Not tested |
| MT11 | enterprise_admin credit limit inline edit → org_members.credit_limit updated | ⬜ Not tested |
| MT12 | enterprise_admin Pause Campaigns toggle → org_members.campaigns_paused = true | ⬜ Not tested |
| MT13 | enterprise_admin overseer slide-out → shows agent's leads + interactions | ⬜ Not tested |
| MT14 | Reassign Lead → leads.assigned_to updated; overseer refreshes | ⬜ Not tested |
| MT15 | enterprise_agent campaigns_paused = true → amber banner visible on agent_dashboard | ⬜ Not tested |
| MT16 | agent_dashboard My Leads → only shows leads WHERE assigned_to = uid (RLS enforced) | ⬜ Not tested |
| MT17 | Add Lead modal → lead inserted with correct assigned_to + org_id | ⬜ Not tested |
| MT18 | Add Lead + AI toggle → decision_plans row + execution_tasks row created | ⬜ Not tested |
| MT19 | enterprise_agent cannot see other agents' leads (RLS check) | ⬜ Not tested |

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
- [x] Only `anurag@yogmayaindustries.com` can access (others redirect to dashboard)
- [x] Bank Transfers table loads with correct amounts and module names
- [x] **Confirm Receipt** button — marks intent paid, activates org_services
- [x] **Partial Payment** button — prompts for amount, sends email to customer ✅ verified working (Session 9)
- [x] Active Entitlements table loads with human-readable service names
- [x] AI Prompt Editor — prompts show per org×channel; inline edit → save works
- [x] Rate Limit panel — org rows with task counts + billing lock status
- [ ] Pending Agency/Enterprise Deals section loads (shows admin_deal intents)
- [ ] Create Deal form → billing_intent created, ref ID + bank details shown
- [ ] Confirm Payment (deal) → org_services activated + org_invitations created

---

## Supabase Direct Access
Management API PAT stored in Claude memory (`supabase-access.md`). Run SQL via:
```bash
curl -s -X POST "https://api.supabase.com/v1/projects/klbwigcvrdfeeeeotehu/database/query" \
  -H "Authorization: Bearer {PAT}" -H "Content-Type: application/json" \
  -d '{"query": "SQL;"}'
```

---

## Completed Work Log

### Session 10 — 2026-03-04 (Multi-Tenant Agency + Enterprise Architecture, Phases 1–3)

**Phase 1 — Database Schema (all applied via Management API):**
- `organizations`: added `seat_limit` (INTEGER), `org_type` (TEXT)
- `org_members`: added `role` (TEXT), `credit_limit` (INTEGER), `campaigns_paused` (BOOLEAN NOT NULL DEFAULT FALSE)
- `leads`: added `assigned_to` (UUID → auth.users)
- `org_invitations` table created with RLS (`agency_admin_invitations` policy — admins manage their own org's invites)
- RLS enabled on `leads`: `leads_org_select` (solo+admins see all org leads), `leads_agent_select` (agents see only assigned leads), `leads_insert`, `leads_update`
- RLS enabled on `interactions`: `interactions_org_select` (solo+admins), `interactions_agent_select` (agents see interactions for their assigned leads)
- RPCs created: `create_agency_enterprise_deal`, `approve_agency_enterprise_deal`, `get_agent_leaderboard`

**Phase 2 — `login.html`:**
- Added invitation claim block: on SIGNED_IN, checks `org_invitations` for user's email, auto-provisions `org_members`, deletes invite
- Extended role routing: `agency_admin` → `agency_admin.html`, `enterprise_admin` → `enterprise_admin.html`, `enterprise_agent` → `agent_dashboard.html`, NULL → `dashboard.html`

**Phase 3A — `admin.html`:**
- Added "Pending Agency / Enterprise Deals" section: queries `billing_intents WHERE intent_source='admin_deal' AND status='awaiting_bank'`, Confirm Payment button calls `approve_agency_enterprise_deal` RPC, shows org name / type / seats / owner email / amount
- Added "Create Agency / Enterprise Deal" form: org name, owner email, deal type, seats, price, services checkboxes, initial AI credits → calls `create_agency_enterprise_deal` RPC → shows reference ID + bank details card + Copy Payment Instructions button (copies email-ready text to clipboard)
- Added `fetchPendingDeals()` call to init sequence and `showToast()` helper

**Phase 3B — `agency_admin.html` (NEW):**
- requireAuth() + role='agency_admin' guard (redirects to dashboard.html if not)
- Header: org name + "X / Y seats" pill (red when at limit) + admin name + sign out
- Client Users table: `org_members JOIN profiles WHERE role IS NULL`; Remove button deletes row
- Pending Invitations list with Cancel option
- Add User modal with seat limit check (counts current members + pending invites vs seat_limit)

**Phase 3C — `enterprise_admin.html` (NEW):**
- requireAuth() + role='enterprise_admin' guard
- Leaderboard via `get_agent_leaderboard` RPC; rank #1 gets gold medal + yellow border
- Agent Management table: credit limit inline input (saves on blur), campaigns toggle (updates campaigns_paused), Remove button, View button
- Agent Overseer right slide-out panel (480px, CSS transition): shows agent leads + recent interactions, reassign dropdown, pause/resume campaigns header button
- Reassign Lead: opens floating dropdown of other agents, updates `leads.assigned_to`

**Phase 3D — `agent_dashboard.html` (NEW):**
- requireAuth() + role='enterprise_agent' guard
- Campaigns Paused amber banner (checks org_members.campaigns_paused on load)
- My Leads panel with status filter tabs (All/New/Active/Closed Won/Closed Lost), timeAgo display
- Add Lead modal: name, phone, email, source select, notes, AI toggle
- AI toggle: inserts `decision_plans` row (plan_id required by execution_tasks), then `execution_tasks` row with channel='sms', status='pending', trigger='manual_agent'
- Recent Activity feed: last 10 interactions for assigned leads, chat bubble style with channel icon

### Session 9 — 2026-03-03 (E2E Code Review + Login Fixes + Admin Verified)

**E2E code review completed** — walked through all flows (auth, pricing→payment, dashboard, modules, admin).

**index.html — pricing matrix mismatch fixed:**
- Landing page `calculate()` had different prices than `pricing.html` — customers saw one price on landing, paid another at checkout
- Fixed: replaced index.html matrix with the exact logic from pricing.html

**admin.html — Active Entitlements JSON blob fixed:**
- `fetchActiveEntitlements()` was rendering services as raw `JSON.stringify(services)` blob
- Fixed: applied same `Object.entries().filter().map().join()` pattern used in bank transfers table

**admin.html — logout() bug fixed:**
- `logout()` called `signOut()` on a client with `persistSession: false` — SDK doesn't clear localStorage in this mode
- Fixed: manually clear all `sb-*-auth-token` localStorage keys before signOut()

**login.html — email confirmation feedback added:**
- `mailer_autoconfirm: false` confirmed (email confirmation required), but signup form showed nothing after submit
- Fixed: shows "check your email" card after successful `signUp()`

**login.html — broken GitHub button removed:**
- `external_github_enabled: false` confirmed via Supabase auth config — GitHub OAuth not configured
- Fixed: removed GitHub button, changed grid from `grid-cols-6` to `grid-cols-5`

**login.html — Sign In / Sign Up toggle added:**
- Account only had Google OAuth (no password, no phone) — needed email+password fallback when OAuth has connectivity issues
- Added: "Already have an account? Sign in" toggle — switches to email+password sign-in mode using `signInWithPassword()`
- Admin password set via SQL: `UPDATE auth.users SET encrypted_password = crypt('AdminGSC2026', gen_salt('bf')) WHERE id = '4c4ae696-...'`

**Admin panel verified working (Session 9):**
- All tables load correctly, Partial Payment confirmed working, Confirm Receipt confirmed working

---

### Session 8 — 2026-03-03 (Admin Bank Transfer Fixes + Partial Payment Feature)

**admin.html — JWT injection fix:**
- Admin Supabase client used `persistSession: false` but no JWT was injected → all DB queries ran as anonymous → bank transfers table appeared empty
- Fixed: stored `_adminToken` at script scope; createClient now passes `global: { headers: { Authorization: \`Bearer ${token}\` } }`
- Same fix applied to `supabase.functions.invoke()` — must pass `headers: { Authorization: \`Bearer ${_adminToken}\` }` explicitly since the client has no active session

**admin.html — $N/A amount display fix:**
- Was reading `pricing_snapshot?.bank_usd` (field doesn't exist) → showed `N/A` for every row
- Fixed: reads `pricing_snapshot.final_invoice_amount` with `toLocaleString('en-US', { minimumFractionDigits: 2 })` formatting

**admin.html — service list display fix:**
- Raw JSON object `{"sentinel":true,"voice":true,...}` was being rendered as blob
- Fixed: `Object.entries(services).filter(([,v]) => v).map(([k]) => k).join(', ')` → readable module names

**admin.html — Partial Payment button added:**
- Yellow button per row in Pending Bank Transfers: prompts admin for amount received, calculates balance due, sends email via `notify-partial-payment` Edge Function
- Guard: if amount ≥ total, directs to use "Confirm Receipt" instead

**payment.html — markAsSent() fixed:**
- Was only updating `payment_attempts` table, never updating `billing_intents` status
- `billing_intents` has BLOCK UPDATE RLS — cannot update from client side
- Fixed: calls `mark_intent_awaiting_bank` SECURITY DEFINER RPC after updating payment_attempts
- Error display improved — shows real error message instead of silent failure

**Database changes applied (Session 8):**
- `billing_intents_status_check` constraint: added `awaiting_bank` to allowed status values (was missing, blocked all bank transfer flows)
- `mark_intent_awaiting_bank(p_intent_id UUID)` RPC created: SECURITY DEFINER, checks membership in BOTH `members` OR `org_members` (because `create_checkout_intent` uses `members`, not `org_members`), updates status to `awaiting_bank`
- `approve_bank_transfer` RPC replaced (3 iterations to fix all null constraints):
  - Added `event_id = 'MANUAL-' || gen_random_uuid()::text` (NOT NULL in `billing_webhook_receipts`, no default)
  - Added `signature_valid = true` (NOT NULL in `billing_webhook_receipts`, no default)
  - Added `UPDATE billing_intents SET expires_at = now() + interval '2 hours'` BEFORE calling `process_payment_webhook_v2` — intents expire in 30 min but admin approves 24-72h later; without this the processor raises "Intent expired"
- Backfilled 4 `billing_intents` rows to `awaiting_bank` status directly via SQL (test data)
- `GRANT EXECUTE ON FUNCTION mark_intent_awaiting_bank(UUID) TO authenticated`

**New Edge Function — `notify-partial-payment`:**
- Created: `supabase/functions/notify-partial-payment/index.ts`
- Verifies caller is admin via `app_admins` table
- Resolves customer email: checks `members` first, then `org_members` fallback (mirrors `create_checkout_intent` logic)
- Calculates: `due = max(0, round((totalDue - paid) * 100) / 100)`
- Sends Resend email with: invoice total / amount received / balance due (red row) / action-required warning / "Contact Support" mailto button → `Support@getsalescloser.com`
- Deployed with `--no-verify-jwt` — Supabase gateway was rejecting ES256 magic-link JWTs before function could run; function handles its own admin auth internally

**Verified working (programmatic tests):**
- **Confirm Receipt**: `POST /rpc/approve_bank_transfer` → `{"status":"success"}` → 4 `org_services` rows activated (sentinel, voice, brain, architect)
- **Partial Payment email**: `POST /functions/v1/notify-partial-payment` → `{"success":true,"email_sent_to":"anurag@getsalescloser.com","amount_paid":5000,"amount_due":3405.76}` (math: 8405.76 − 5000 = 3405.76 ✓)

---

### Session 7 — 2026-03-03 (Admin Auth + Storage Upload Fix)

**admin.html — auth method replaced:**
- Switched from `onAuthStateChange(INITIAL_SESSION)` to `getUser()` IIFE
- Root cause of frozen spinner: `onAuthStateChange` fires asynchronously and can miss the INITIAL_SESSION event in certain redirect/timing scenarios; `getUser()` validates JWT directly against Supabase API — never hangs, no event race conditions
- DB confirmed correct: `is_admin = true` for `anurag@yogmayaindustries.com` (id `4c4ae696-de66-4b32-833c-b656454437d6`)

**Storage — documents INSERT policy added (directly via SQL):**
- Root cause of Knowledge Brain "upload failed: new row violates row-level security policy": storage INSERT policy was never added for the `documents` bucket (only SELECT + DELETE existed)
- Added: `CREATE POLICY "Users can upload own documents" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'documents' AND (auth.uid())::text = (storage.foldername(name))[1])`
- Note: The "Upload Failed:" error message prefix comes from the storage upload step (not the DB insert step)

**billing.html — yearly toggle added (Session 6 work also included):**
- Monthly/Yearly toggle with 20% off yearly (×0.8 multiplier)
- Explicit dollar savings display; removed misleading "2 months free" note

---

### Session 6 — 2026-03-03 (Bug Fixes + Supabase Access)

**billing.html price display fix:**
- `calculate()` now handles Brain (B) or Architect (A) selected without a base service (S or L)
- Previously returned `base = 0` → showed `--`; now implies Sentinel ($49) as minimum required base
- Added `#baseImpliedHint` yellow notice: "Instant Sentinel ($49 base) will be included — required for this module"

**login.html admin redirect fix:**
- Admin users now redirect to `admin.html` (was incorrectly redirecting to `dashboard.html`)
- Root cause of redirect-to-pricing: Session 1 SQL used `WHERE email = ...` but `profiles` has no `email` column → UPDATE matched 0 rows → `is_admin` was never set

**Database fix (via Management API):**
- Ran: `UPDATE profiles SET is_admin = true WHERE id = (SELECT id FROM auth.users WHERE email = 'anurag@yogmayaindustries.com')`
- Verified: `is_admin = true` confirmed for user id `4c4ae696-de66-4b32-833c-b656454437d6`

**Supabase direct access:**
- Management API PAT obtained and stored in Claude memory (not in git)
- Claude can now run arbitrary SQL without user intervention

---

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

### Session 10 — Applied (2026-03-04)
- Column additions: `organizations.(seat_limit, org_type)`, `org_members.(role, credit_limit, campaigns_paused)`, `leads.assigned_to`
- `org_invitations` table + RLS policy `agency_admin_invitations`
- RLS enabled + policies on `leads` (org_select, agent_select, insert, update)
- RLS enabled + policies on `interactions` (org_select, agent_select)
- `create_agency_enterprise_deal(TEXT,TEXT,TEXT,INTEGER,NUMERIC,JSONB,INTEGER)` — SECURITY DEFINER
- `approve_agency_enterprise_deal(UUID)` — SECURITY DEFINER, handles plan activation + invite + credit allocation
- `get_agent_leaderboard(UUID)` — SECURITY DEFINER STABLE, top 5 agents by win rate
- `GRANT EXECUTE` on all three new RPCs to authenticated

### Session 8 — Applied (2026-03-03)
- `billing_intents_status_check` constraint: dropped and recreated to include `awaiting_bank`
- `mark_intent_awaiting_bank(p_intent_id UUID)` function created (SECURITY DEFINER) — checks `members` OR `org_members`, updates intent to `awaiting_bank`
- `approve_bank_transfer` RPC replaced — now generates `event_id`, sets `signature_valid=true`, extends `expires_at` before calling processor
- `GRANT EXECUTE ON FUNCTION mark_intent_awaiting_bank(UUID) TO authenticated`

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
