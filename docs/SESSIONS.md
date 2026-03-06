# GetSalesCloser — Full Session History

> Archive of all completed work, migrations, bug fixes, and session notes.
> For current project state, see `/CLAUDE.md`.

---

## Session 18 — 2026-03-06 (Sprint 2–5 Complete)

### Sprint 2 — AI Pause Gate + Live Wire + Takeover

**2.1 — `leads.ai_paused` column + AI gate:**
- `leads.ai_paused BOOLEAN DEFAULT false` added via SQL
- `reply_router.ts`: checks `ai_paused` at top — skips all AI routing if true
- `executor_sms`: `force_content` bypass — if `task.metadata.force_content` is set, skips AI generation entirely and sends that string directly via Twilio
- `agent_dashboard.html`: `loadLeads` select updated to include `ai_paused`

**2.2 — Live Wire (Realtime inbound feed):**
- `agent_dashboard.html`: "Live Wire" card added — Supabase Realtime `postgres_changes` on `interactions` table; filtered client-side to only show interactions for assigned leads (`_allLeads.map(l => l.id)`)
- `enterprise_admin.html`: "Live Wire" card added — filtered by `org_id=eq.${_orgId}` at subscribe time

**2.3 — Takeover (Pause AI / Manual Reply / Resume AI):**
- `agent_dashboard.html` Lead Action Panel: Takeover section added to active panel
- `takeoverLead()`: sets `leads.ai_paused = true`; hides takeover button, shows manual reply textarea + resume button
- `sendManualReply()`: creates `decision_plans` + `execution_tasks` with `metadata: { force_content: text }` — sends human-written message via executor_sms bypass
- `resumeAI()`: sets `leads.ai_paused = false`; restores normal AI routing

### Sprint 3 — Mirror Test Onboarding (2-Step Wizard)

- `dashboard.html` onboarding modal rebuilt as 2-step wizard:
  - Step 1: existing business setup form (industry, cal_link, agent name, tone)
  - Step 2: Mirror Test — enter phone number → AI sends you a live intro SMS
- `handleOnboarding()`: saves to both `profiles` AND `org_settings`; no longer sets `onboarding_completed=true` — advances to step 2
- `runMirrorTest()`: validates phone, inserts test lead (source='system_mirror_test'), inserts `decision_plans` + `execution_tasks`, invokes `executor_sms` directly via `sb.functions.invoke()`, sets `onboarding_completed: true`, shows success state
- `skipMirrorTest()`: sets `onboarding_completed: true` and reloads

### Sprint 4 — Automations & Handoff

**SQL:**
- `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS phone TEXT;` — for meeting alert SMS

**`cron_handoff_brief` Edge Function:**
- Deployed `--no-verify-jwt`; pg_cron job #9 (`*/5 * * * *`)
- Queries `appointments` with `status='scheduled'` in 5–10 min window
- Fetches last 5 interactions → GPT-4o-mini generates 2-3 sentence pre-meeting brief
- SMS closer via Twilio if `profiles.phone` set; email fallback via Resend if not

**`cron_weekly_roi` Edge Function:**
- Deployed `--no-verify-jwt`; pg_cron job #10 (`0 8 * * 1` — Monday 8am UTC)
- Iterates all active orgs; computes 7-day metrics (new leads, closed, booked, SMS/email/voice)
- `buildROIEmail()` + `metricCard()` helpers generate styled HTML email
- Sends via Resend to all org owners + enterprise/agency admins

**`dashboard.html` — Persona Settings card:**
- Added "Your Mobile (meeting alerts)" phone field (`id="persona-closer-phone"`)
- `loadPersonaSettings()`: now parallel-fetches `org_settings` + `profiles.phone`
- `savePersona()`: saves `org_settings` fields + `profiles.phone` in `Promise.all`

### Sprint 5 — Platform Hardening

**5.1 — RLS Security Audit + Fixes:**
- Audited: organizations, org_members, api_keys, leads, interactions, execution_tasks, billing_intents
- **`execution_tasks` (CRITICAL fixed):** "Org members can insert/select" used `is_member_of_org()` → enterprise_agents could read all org tasks and insert tasks for any lead. Dropped both. Added:
  - `execution_tasks_admin_solo_select` — solo/agency_admin/enterprise_admin see all org tasks
  - `execution_tasks_admin_solo_insert` — non-agents can insert tasks for org
  - `execution_tasks_agent_select` — agents see only tasks for their assigned leads
  - `execution_tasks_agent_insert` — agents insert only for their assigned leads
- **`billing_intents` (HIGH fixed):** Dropped "Users can create intents" (allowed enterprise_agents to INSERT). Added `billing_intents_non_agent_insert` — excludes `enterprise_agent` role
- **`api_keys` ✅:** enterprise_agent already excluded from all 3 operations
- **`organizations`, `leads`, `interactions`, `org_members` ✅:** Already correctly scoped

**5.2 — Webhook Spam Protection:**
- `webhook_inbound`: 128 KB Content-Length guard added before try/catch block
- `hook_inbound`: 64 KB Content-Length guard added after auth check
- `widget_inbound`: 64 KB Content-Length guard + `history[]` capped at 20 turns + per-item content truncated to 1000 chars

**5.3 — Graceful Error Logging:**
- `last_error` column already existed on `execution_tasks` — no migration needed
- `executor_sms`: Twilio `fetch()` wrapped in try/catch → `TWILIO_NETWORK_ERROR` + task marked `failed`
- `executor_email`: Resend `fetch()` wrapped in try/catch → `RESEND_NETWORK_ERROR` + task marked `failed`
- `executor_voice`: VAPI `fetch()` wrapped in try/catch → token refund + `VAPI_NETWORK_ERROR` + task marked `failed`

**Schema correction discovered:**
- `api_keys` table actual columns: `id`, `org_id`, `api_key` (not `key`), `name` (not `label`), `created_at`, `last_used_at`
- CLAUDE.md previously had wrong column names — corrected

**Vercel:** deployed to `www.getsalescloser.com` ✅

### Bug Fixes (Session 18)
- Sentinel.html: black box fixed (empty state `<p>` text); 0% conv. prob. fixed (pass full `lead` object to `showDetail()`); Take Action button fixed (wrong element IDs + `.classList.remove()` on strings)
- `widget_inbound` name capture: `extractName()` per-message (not joined), capital-letter guard for second word
- Duplicate leads: `.limit(1)` instead of `.maybeSingle()` prevents PGRST116 cascade → multiple inserts
- Facebook pivot: removed `?source=facebook` from webhook endpoint lists; added Zapier/Make guidance note in setup guides

---

## Session 17 — 2026-03-06 (Sprint 1 Complete + Bug Fixes)

**Sprint 1.1 — `api_keys` table:**
- `generate_api_key()` SQL function: `'gsc_live_' || encode(gen_random_bytes(24), 'hex')`
- `payment_attempts` RLS fixed — UNION with `org_members` to fix "new row violates RLS" on payment.html

**Sprint 1.2 — `hook_inbound` Edge Function:**
- Auth: Bearer header or `?api_key=` URL param validated against `api_keys.api_key`
- Sources: ghl, zapier, make, apollo, hubspot, facebook, generic
- Duplicate guard: last-10-digit LIKE check; creates `decision_plans` + `execution_tasks`
- `role='owner'` added to RLS policies and actor resolution

**Sprint 1.3 — Site Liaison Widget:**
- `embed.js`: floating bubble + slide-up panel; localStorage session/history
- `chat.html`: hosted Smart Link, full-screen mobile-first, iOS safe-area
- `widget_inbound`: GET ?action=meta (no AI); POST chat handler with persona injection, GPT-4o-mini
- "Deploy AI Site Liaison" cards in all 3 dashboards — gated behind sentinel service

**Bug fixes:**
- `[Insert Booking Link]` placeholder: `book_appointment` (no-link safe) + `book_appointment_with_link` variants; `drop_cal_link` only when `cal_link` set
- Duplicate lead on country confirmation: dedup via last-10-digit LIKE; UPDATE existing lead's phone
- Email not collected when scheduling unavailable: parallel `org_services` check; email collect directive when no scheduling
- Stopword name capture: `extractName()` with 40+ stopword filter, capital-letter guard
- Onboarding: dual save to `profiles` + `org_settings`; industry options corrected
- Agency admins: AI Persona Settings card added to `agency_admin.html` (`ag-` prefix)
- Deploy AI gating: `initDeploySection()` async, queries sentinel status first

---

## Session 16 — 2026-03-05 (Phase 4 — Persona Injection)

**SQL:**
```sql
ALTER TABLE org_settings
  ADD COLUMN IF NOT EXISTS persona_name TEXT,
  ADD COLUMN IF NOT EXISTS tone_preset TEXT DEFAULT 'neutral_balanced',
  ADD COLUMN IF NOT EXISTS bot_disclosure TEXT DEFAULT 'transparent',
  ADD COLUMN IF NOT EXISTS conversion_objective TEXT DEFAULT 'book_appointment',
  ADD COLUMN IF NOT EXISTS terminology_overrides JSONB DEFAULT '{}';
```

**`_shared/persona_builder.ts`:** 6 tone presets, 6 industry language packs, 5 compliance guardrails (hardcoded), 2 bot disclosure scripts, 4 conversion objectives → `buildPersonaBlock(PersonaSettings): string`

**`brain.ts`:** expanded `org_settings` select; `buildPersonaBlock()` injected in `generateMessage()` + `getVoiceContext()`

**UI:** AI Persona Settings card in `dashboard.html` (solo), `enterprise_admin.html` (`ent-` prefix), `agency_admin.html` (`ag-` prefix). Admin.html prompt editor expanded with Agent/Tone/Objective columns.

---

## Session 15 — 2026-03-05 (E2E Test Blocks 3–6 + Bug Fixes)

- `leads` insert: added `profile_id: currentUser.id` (NOT NULL)
- `decision_plans` insert: removed non-existent `status`/`metadata`; added required `plan: {}` jsonb
- Terminal leads: Manage button replaced with "Closed" label + guard in `openLapPanel`/`openLeadPanel`
- Conversion Probability: `calcConversionProbability(lead)` added to sentinel.html, dashboard.html, agent_dashboard.html
  - Formula: closed_won=100%, closed_lost=0%; active base=45, new base=20; recency ±5–20; phone+8, email+5; clamped 1–99%

---

## Session 14 — 2026-03-05 (E2E Block 1-2 + Ghost Org Bug Fix)

- `create_checkout_intent` ghost org fix: RPC now checks `org_members` before creating "Personal Workspace" ghost org
- Test user arsahabh@gmail.com fixed: sentinel activated directly via SQL

---

## Session 13 — 2026-03-05 (Solo Lead Management + Data-Backed Upsell)

- `reply_router.ts`: service key names corrected (`voice_liaison`→`voice`, `appointment_architect`→`architect`)
- `webhook_inbound`: upsell hook — when `request_callback`/`request_meeting` + service inactive → inserts `manual_action_requests` + `notifications`
- `manual_action_requests` table created with RLS
- `generate-upsell-insight` Edge Function: GPT-4o-mini, accepts `{org_id, service_key, stats}`, returns `{insight}`
- `dashboard.html`: My Leads, Add Lead modal, Lead Action Panel, Pending Manual Actions, Revenue Intelligence upsell
- `agent_dashboard.html`: Pending Manual Actions card
- `enterprise_admin.html`: Revenue Intelligence card

---

## Session 12 — 2026-03-05 (Lead Action Panel MT20–MT24)

- `agent_dashboard.html`: Lead Action Panel — Active/Closed Won/Closed Lost tabs, AI instruction, mandatory close reason
- `enterprise_admin.html`: "Closed Won — Pending Review" section + Challenge button
- RLS policies: `lead_timeline_events` INSERT/SELECT, `notifications` INSERT/SELECT/UPDATE

---

## Session 11 — 2026-03-04 (Multi-Tenant E2E MT1–MT7)

- `billing_intents.intent_source TEXT` column added; constraint updated to allow `'admin'`
- `create_agency_enterprise_deal` RPC: GSC- reference_id, pricing_snapshot with version/breakdown/final_invoice_amount, expires_at, billing_cycle
- `approve_agency_enterprise_deal` RPC: `set_config('app.payment_processing','true',true)` unlock before UPDATE
- `org_invitations` RLS: invitees can read + delete own invites
- `send-agent-invite` Edge Function: Resend email, accepts admin or service_role JWT
- `handle_new_user` trigger rewrite (3 iterations): org → profiles (with organization_id) → org_members → org_settings → org_services → org_prompts

---

## Session 10 — 2026-03-04 (Multi-Tenant Architecture)

- Schema: `organizations.(seat_limit, org_type)`, `org_members.(role, credit_limit, campaigns_paused)`, `leads.assigned_to`
- `org_invitations` table created
- RLS on `leads` (org_select, agent_select, insert, update) and `interactions` (org_select, agent_select)
- RPCs: `create_agency_enterprise_deal`, `approve_agency_enterprise_deal`, `get_agent_leaderboard`
- New pages: `agency_admin.html`, `enterprise_admin.html`, `agent_dashboard.html`
- `login.html`: invitation claim + role routing

---

## Session 9 — 2026-03-03 (E2E Code Review)

- `index.html` pricing matrix aligned to `pricing.html`
- `admin.html`: entitlements JSON blob fixed, logout localStorage clear fix
- `login.html`: email confirmation card, GitHub button removed, Sign In/Sign Up toggle added
- Admin password: `UPDATE auth.users SET encrypted_password = crypt('AdminGSC2026', gen_salt('bf')) WHERE id = '4c4ae696-...'`

---

## Session 8 — 2026-03-03 (Admin Bank Transfers + Partial Payment)

- `admin.html`: JWT injection fix (`_adminToken` in global headers), amount display fix (`final_invoice_amount`), service list fix, Partial Payment button
- `payment.html`: `markAsSent()` now calls `mark_intent_awaiting_bank` RPC (billing_intents has BLOCK UPDATE RLS)
- `billing_intents_status_check` constraint: added `awaiting_bank`
- `mark_intent_awaiting_bank(UUID)` RPC: SECURITY DEFINER, checks `members` OR `org_members`
- `approve_bank_transfer` RPC: generates `event_id`, sets `signature_valid=true`, extends `expires_at` (+2h)
- `notify-partial-payment` Edge Function: admin auth via `app_admins`, Resend email with balance due

---

## Sessions 1–7 (Foundation)

- Session 7: admin.html `getUser()` IIFE (replaced broken `onAuthStateChange`); storage INSERT policy for `documents` bucket
- Session 6: billing.html price display fix; `is_admin = true` set via SQL; Supabase PAT obtained
- Session 5: `org_billing_profiles` table; `org_prompts` seeded; `ai_credits_balance = 999999`; Admin RLS policies
- Session 4: XSS fix in `subscribeToInteractions()`; dead table refs removed from `supabase-logic.js`; Replay button for voice recordings; ghost org patterns patched
- Session 3: Sentinel CRM modal; Knowledge Brain read view; `runRevenueDiagnosis()` + Realtime feed
- Session 1: `profiles.is_admin` column; entitlement guards on all module pages; `overview.html` deleted

---

## All SQL Migrations (Chronological)

```sql
-- Session 1
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT false;
-- Session 5: org_billing_profiles table + RLS (see migration file)
-- Session 8
ALTER TABLE billing_intents ADD COLUMN intent_source TEXT; -- plus constraint update
CREATE OR REPLACE FUNCTION mark_intent_awaiting_bank(p_intent_id UUID) ...
-- Session 10
ALTER TABLE organizations ADD COLUMN seat_limit INTEGER, ADD COLUMN org_type TEXT;
ALTER TABLE org_members ADD COLUMN role TEXT, ADD COLUMN credit_limit INTEGER,
  ADD COLUMN campaigns_paused BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE leads ADD COLUMN assigned_to UUID REFERENCES auth.users(id);
-- Session 16
ALTER TABLE org_settings ADD COLUMN IF NOT EXISTS persona_name TEXT,
  ADD COLUMN IF NOT EXISTS tone_preset TEXT DEFAULT 'neutral_balanced',
  ADD COLUMN IF NOT EXISTS bot_disclosure TEXT DEFAULT 'transparent',
  ADD COLUMN IF NOT EXISTS conversion_objective TEXT DEFAULT 'book_appointment',
  ADD COLUMN IF NOT EXISTS terminology_overrides JSONB DEFAULT '{}';
-- Session 17: api_keys table + generate_api_key() function
-- Session 18 (Sprint 4)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS phone TEXT;
-- Session 18 (Sprint 5): RLS policy changes (see Sprint 5 notes above)
```

---

## pg_cron Jobs

| Job ID | Name | Schedule | Function |
|---|---|---|---|
| 1 | expire-old-invoices | (unknown) | invoice expiry |
| 7 | purge_api_rate_limits | (unknown) | rate limit cleanup |
| 8 | cleanup-conversation-state | daily 3am UTC | 90-day TTL on conversation_state |
| 9 | handoff-brief | `*/5 * * * *` | cron_handoff_brief Edge Function |
| 10 | weekly-roi-email | `0 8 * * 1` | cron_weekly_roi Edge Function |

---

## E2E Test Results (All Passing as of Session 18)

All MT1–MT24 multi-tenant tests passing. All E2E test blocks 1–11 passing.
Remaining manual verifications (not automatable):
- widget_inbound: name stopword filter, last-10-digit dedup, email collection when scheduling unavailable
- Deploy AI card: sentinel gating (active vs inactive state)
- Mirror Test: live SMS received on phone during onboarding step 2
