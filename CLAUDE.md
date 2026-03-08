# CLAUDE.md — GetSalesCloser Project Guide

> Last updated: 2026-03-09 (Session 25) | Full session history → `docs/SESSIONS.md`

**Live URL**: https://www.getsalescloser.com (Vercel) | **Supabase**: https://klbwigcvrdfeeeeotehu.supabase.co
**Admin email**: anurag@yogmayaindustries.com | **Admin password**: AdminGSC2026

---

## Tech Stack

| Layer | Choice |
|---|---|
| Frontend | Vanilla HTML5 + Tailwind CSS (CDN) + Vanilla ES6+ JS (no build step) |
| Backend | Supabase (PostgreSQL + Auth + Storage + Edge Functions) |
| AI | OpenAI GPT-4o-mini (intent/chat/upsell), GPT-4o (knowledge brain — law/medical) |
| Voice | VAPI outbound calls | SMS | Twilio | Email | Resend |
| Payments | Razorpay (live key in payment.html) | Hosting | Vercel |
| Icons | FontAwesome 6.4.0 (CDN) | Fonts | Google Fonts — Inter |

---

## File Map (Current Status)

| File | Purpose | Status |
|---|---|---|
| `index.html` | Landing page, ROI calculator, dynamic pricing engine | ✅ Complete |
| `login.html` | Auth (OTP + OAuth + Email/Password) + invitation claim + role routing | ✅ Complete |
| `auth.js` | Central auth guard — `requireAuth()` pattern | ✅ Complete |
| `dashboard.html` | Solo user command center — leads, AI persona, deploy widget, API keys, Mirror Test onboarding, Live Wire, Credit Wallet, Delivery Status, Channel Infrastructure | ✅ Complete (Session 21) |
| `agency_admin.html` | Agency portal — seat mgmt, invites, AI persona, deploy widget, API keys, Live Wire, Credit Wallet, Delivery Status, Channel Infrastructure | ✅ Complete (Session 21) |
| `enterprise_admin.html` | Enterprise command — leaderboard, agents, overseer, closed won review, AI persona, deploy widget, API keys, Live Wire, Credit Wallet, Delivery Status, Channel Infrastructure | ✅ Complete (Session 21) |
| `agent_dashboard.html` | Agent view — my leads, action panel, takeover/manual reply/resume AI, pending actions, Live Wire | ✅ Complete (Session 18) |
| `admin.html` | Finance command — bank transfers, entitlements, prompt editor, rate limits, partial payment, deals, Channel Sender Mgmt, Channel Fallback Events, Provisioning Queue | ✅ Complete (Session 21) |
| `number_request_checkout.html` | $110 dedicated number bundle purchase flow → payment.html | ✅ Complete (Session 20) |
| `cancel.html` | 3-step subscription cancellation: feedback → refund preview → confirm | ✅ Complete (Session 20) |
| `sentinel.html` | Instant Sentinel — lead list + CRM modal + conversion probability | ✅ Complete |
| `pricing.html` | New user plan selector → `create_checkout_intent` | ✅ Complete |
| `billing.html` | Upgrade/manage plan for existing subscribers | ✅ Complete |
| `payment.html` | Razorpay checkout + bank transfer | ✅ Complete |
| `success.html` | Post-payment verification (polls billing_intents) | ✅ Complete |
| `Voice Liaison.html` | Call logs + sentiment + Replay button | ✅ Complete |
| `Knowledge Brain.html` | PDF upload + text rules + read/delete view | ✅ Complete |
| `App Architect.html` | Appointment scheduling viewer | ✅ Complete |
| `embed.js` | Embeddable chat widget (floating bubble, localStorage session) | ✅ Complete |
| `chat.html` | Hosted Smart Link chat (`?org=<id>`, full-screen mobile-first) | ✅ Complete |

---

## Edge Functions (supabase/functions/)

| Function | Status | Key Notes |
|---|---|---|
| `executor_sms` | ✅ | Twilio SMS; `force_content` bypass for human takeover; try/catch on fetch |
| `executor_email` | ✅ | Resend email; try/catch on fetch |
| `executor_voice` | ✅ | VAPI call; billing lock guard; try/catch on fetch + token refund |
| `webhook_inbound` | ✅ | Twilio SMS inbound + VAPI end-of-call; 128KB payload guard |
| `hook_inbound` | ✅ | CRM ingestion (GHL/Zapier/Make/Apollo/HubSpot/Generic); `api_keys` auth; 64KB guard |
| `widget_inbound` | ✅ | AI chat widget backend; persona injection; lead capture; 64KB guard; history capped at 20 |
| `webhook-razorpay` | ✅ | Razorpay payment webhook |
| `notify-partial-payment` | ✅ | Admin partial payment email (Resend); `--no-verify-jwt`; admin auth via `app_admins`; FROM=`billing@getsalescloser.com` |
| `send-agent-invite` | ✅ | Invitation email (Resend); `--no-verify-jwt`; FROM=`support@getsalescloser.com` |
| `send-welcome-email` | ✅ | Welcome email on onboarding complete; `--no-verify-jwt`; FROM=`hello@getsalescloser.com`; called from `dashboard.html` |
| `generate-upsell-insight` | ✅ | GPT-4o-mini upsell copy; `--no-verify-jwt` |
| `cron_handoff_brief` | ✅ | Pre-meeting SMS/email brief; runs every 5min via pg_cron job #9 |
| `cron_weekly_roi` | ✅ | Weekly ROI email to org owners; every Monday 8am UTC via pg_cron job #10 |
| `intent_ai` | ✅ | GPT-4o-mini intent classifier (13 labels) |
| `knowledge_brain` | ✅ | GPT-4o-mini (general) / GPT-4o (law, medical) |
| `executor_whatsapp` | ✅ | Twilio WhatsApp; capability+routing gate; wa_msg token; delivery_attempts logging; SMS fallback |
| `executor_rcs` | ✅ | Google RBM; WebCrypto SA→OAuth2 JWT; 3-step fallback; device capability → SMS fallback; rcs_msg token |
| `executor_messenger` | ✅ | Graph API v21.0; PSID guard; 24h window → SMS fallback; terminal 551/190; messenger_msg token |
| `initiate-cancellation` | ✅ | Feedback capture → prorated refund quote (1h expiry); top-up/number exclusions; audit_events |
| `confirm-cancellation` | ✅ | Validates quote; immediate: cancel services + tasks + refund; end_of_term: set service_ends_at |
| `execute-refund` | ✅ | Idempotent; finds Razorpay payment_id via payment_attempts; POST /v1/payments/{id}/refund |
| `run-low-balance-alerts` | ✅ | 24h debounce; email+SMS per token key; `run-low-balance-alerts` pg_cron #12 every 15min |
| `campaign_ticker` | ✅ | Campaign execution scheduler |
| `decision_engine` | ✅ | Core execution decision logic |
| `execution_planner` | ✅ | Plans execution steps |
| `execution-dispatcher` | ✅ | Dispatches planned executions |
| `task_sweeper` | ✅ | Cleans stale tasks |
| `voice_turn` | ✅ | VAPI voice turn handler |
| `webhook_cal` | ✅ | Cal.com webhook handler |
| `invoice-reminder-worker` | ✅ | `REMINDER_DRY_RUN=false` (live) |
| `org_channels_*` (5) | ✅ | Channel management |
| `context_builder` | ✅ | Context assembly for AI |
| `create-checkout-intent` | ✅ | Razorpay checkout intent (subscription plans) |
| `create-credit-topup-order` | ✅ | Credit top-up order + billing_intent (intent_source=credit_topup) |
| `create-number-purchase-order` | ✅ | Bundle: $40 number + $30 setup + $20 voice (100 min) + $20 SMS (2000 msg) = $110; intent_source=number_purchase |
| `fulfill-paid-order` | ✅ | Idempotent credit grant; `credit_wallet_add_v1` atomic RPC; amount integrity check |
| `fulfill-number-request` | ✅ | Grants bundled voice_min+sms_msg credits idempotently; creates provision_request; emails admin; marks billing_intent paid |
| `run-low-balance-alerts` | ✅ | 24h debounce cron; email+SMS; alert state machine |
| `get-payment-config` | ✅ | Payment config fetcher |

**Shared modules** (`_shared/`): `db.ts`, `brain.ts`, `persona_builder.ts`, `reply_router.ts`, `intent_ai.ts`, `intent_rules.ts`, `conversation_state.ts`, `security.ts`, `retry_policy.ts`, `strike_time.ts`, `guardrails/` (input_sentry, output_auditor, prompt_packager)

---

## Database — Current Schema

### All Confirmed Tables
**Core:** `profiles`, `leads`, `interactions`, `appointments`, `voice_usage`, `lead_timeline_events`, `lead_actions`, `org_members`, `org_services`, `org_settings`, `billing_intents`, `payment_attempts`, `knowledge_base`, `security_events`, `execution_tasks`, `voice_calls`, `notifications`, `campaigns`, `campaign_leads`, `org_channels`, `org_channel_provision_requests`, `conversation_state`, `active_org_prompts` (VIEW), `decision_plans`, `organizations`, `org_invitations`, `manual_action_requests`, `org_billing_profiles`, `org_prompts`, `api_keys`, `beta_interest`, `app_admins`, `members` (legacy), `platform_channels`

**Credits (Session 20):** `credit_wallets`, `credit_ledger`, `credit_alert_state`, `orders`, `order_lines`, `idempotency_keys`, `usage_rating_events`, `usage_settlements`

**Cancellation (Session 20):** `subscription_contracts`, `cancellation_feedback`, `refund_quotes`, `subscription_cancellations`, `refund_executions`

**Channels (Session 20-21):** `org_channel_capabilities`, `message_routing_policies`, `delivery_attempts`, `message_threads`
**Hardening (Sessions 22–24):** `platform_control_flags`, `rate_limit_buckets`, `execution_dead_letters`, `provider_webhook_events`, `channel_health_current`

### Key Columns Added (all sessions)
| Column | Table | Type | Notes |
|---|---|---|---|
| `is_admin` | `profiles` | BOOLEAN DEFAULT false | Platform admin flag |
| `phone` | `profiles` | TEXT | Closer's mobile for meeting alert SMS |
| `seat_limit` | `organizations` | INTEGER | NULL = unlimited |
| `org_type` | `organizations` | TEXT | NULL / 'agency' / 'enterprise' |
| `role` | `org_members` | TEXT | NULL / 'agency_admin' / 'enterprise_admin' / 'enterprise_agent' |
| `credit_limit` | `org_members` | INTEGER | NULL = no cap |
| `campaigns_paused` | `org_members` | BOOLEAN DEFAULT false | |
| `assigned_to` | `leads` | UUID | References auth.users; NULL = solo |
| `ai_paused` | `leads` | BOOLEAN DEFAULT false | Blocks AI routing; set by Takeover |
| `intent_source` | `billing_intents` | TEXT | 'admin_deal' for agency/enterprise |
| `persona_name` | `org_settings` | TEXT | |
| `tone_preset` | `org_settings` | TEXT DEFAULT 'neutral_balanced' | |
| `bot_disclosure` | `org_settings` | TEXT DEFAULT 'transparent' | |
| `conversion_objective` | `org_settings` | TEXT DEFAULT 'book_appointment' | |
| `terminology_overrides` | `org_settings` | JSONB DEFAULT '{}' | |
| `messenger_psid` | `leads` | TEXT | Facebook Messenger PSID; indexed; NULL until auto-linked |
| `fallback_policy` | `org_channels` | TEXT DEFAULT 'allow_shared' | allow_shared \| fail_task \| admin_override |
| `provider_token` | `org_channels` | TEXT | Per-org Facebook page access token |
| `cancellation_status` | `organizations` | TEXT | NULL \| cancelled_immediate \| cancelled_end_of_term |
| `service_ends_at` | `organizations` | TIMESTAMPTZ | End-of-term cancellation effective date |

### `api_keys` Table (exact columns — important!)
`id` (uuid), `org_id` (uuid), `api_key` (text, DEFAULT `generate_api_key()`), `name` (text label), `created_at`, `last_used_at`
> ⚠️ Column is `api_key` NOT `key`. Label column is `name` NOT `label`.

### `execution_tasks` Key Columns
`id`, `plan_id` (NOT NULL), `lead_id`, `org_id`, `channel`, `status`, `attempt`, `max_attempts`, `scheduled_for`, `executed_at`, `last_error` (TEXT — for error logging), `metadata` (JSONB), `locked_by`, `locked_until`, `provider`, `provider_id`, `actor_user_id`, `ai_generation_locked`

### Key RPCs
`is_lead_terminal`, `consume_tokens_v1`, `grant_tokens_core_v1`, `settle_voice_call_tokens_v2`, `resolve_inbound_org_channel_v1`, `apply_lead_halt_and_cancel`, `cancel_pending_retries_channel`, `approve_bank_transfer`, `mark_intent_awaiting_bank`, `export_lead_timeline`, `get_active_entitlements`, `create_checkout_intent`, `record_webhook_and_process_razorpay`, `resolve_billing_recipients_v1`, `is_kill_switch_enabled_v1`, `is_org_member`, `is_org_admin_or_owner`, `enforce_rate_limit_v1`, `claim_pending_notifications`, `claim_campaign_leads`, `fetch_due_tasks`, `execution_policy_v1`, `create_agency_enterprise_deal`, `approve_agency_enterprise_deal`, `get_agent_leaderboard`

### RLS Summary (Sprint 5 hardened)
| Table | enterprise_agent can... |
|---|---|
| `leads` | SELECT own assigned leads only; INSERT for own leads; UPDATE own assigned leads |
| `interactions` | SELECT own assigned leads' interactions only; no INSERT from frontend |
| `execution_tasks` | SELECT/INSERT only for their assigned leads (agent-scoped policies) |
| `api_keys` | ❌ Blocked from all operations |
| `billing_intents` | ❌ Blocked from INSERT (`billing_intents_non_agent_insert` excludes agent role) |
| `organizations` | SELECT own org name only; no UPDATE/INSERT/DELETE |
| `org_members` | SELECT own membership row only |

### pg_cron Jobs
| ID | Name | Schedule | Target |
|---|---|---|---|
| 8 | cleanup-conversation-state | daily 3am UTC | 90-day TTL |
| 9 | handoff-brief | `*/5 * * * *` | `cron_handoff_brief` |
| 10 | weekly-roi-email | `0 8 * * 1` | `cron_weekly_roi` |
| 11 | process-activations | `* * * * *` | `process_pending_activations()` |
| 12 | low-balance-alerts | `*/15 * * * *` | `run-low-balance-alerts` |
| 13 | wallet-ledger-reconcile | `0 4 * * *` | `run_wallet_ledger_reconciliation()` SQL fn |
| 14 | channel-health | `*/5 * * * *` | `compute_channel_health_v1()` SQL fn |

### Storage Buckets
`logos` (company branding), `documents` (Knowledge Brain PDFs)

---

## Architecture Patterns

### Auth Guard
All protected pages use `auth.js` → `requireAuth({ onAuthenticated: (profile, user, sb) => {} })`.
- Requires: `<script src="auth.js">`, `<div id="auth-loader">` (visible by default), `<div id="page-content">` (hidden by default)
- **Exception**: `pricing.html` + `payment.html` use inline auth-loader pattern (no auth.js)
- Role pages (`agency_admin.html`, `enterprise_admin.html`, `agent_dashboard.html`) need `requireOnboarding: false`

### Entitlement Check Pattern
```js
const { data: membership } = await sb.from('org_members').select('org_id').eq('user_id', user.id).limit(1).maybeSingle();
const { data: svc } = await sb.from('org_services').select('status').eq('org_id', membership.org_id).eq('service_key', 'sentinel').maybeSingle();
if (svc?.status !== 'active') window.location.href = 'billing.html?lock=sentinel';
```

### Service Keys: `sentinel` | `voice` | `brain` | `architect`

### Token System
- Voice: 5 tokens pre-debit → settled via `settle_voice_call_tokens_v2`
- SMS + Email: 1 token each → `consume_tokens_v1` with `p_idempotency_key: task_id`
- Refund on failure: `grant_tokens_core_v1`

### Billing Lock Guard (voice)
`executor_voice` + `voice_turn` query `org_billing_profiles.billing_lock_status`. Query ERROR = fail-closed. Values: `none` | `soft_lock` | `hard_lock` | `manual_lock`

### Pricing
- Base: Sentinel ($49/mo), Voice ($149/mo) | Add-ons: Brain, Architect
- Rule: Brain + Architect require Sentinel or Voice as base
- Elite bundle: Voice + Brain + Architect = $349/mo

### Human Takeover Flow (Sprint 2.3)
1. Agent clicks "Takeover" → `leads.ai_paused = true`
2. `reply_router.ts` skips all AI routing when `ai_paused = true`
3. Agent types message → `execution_tasks` with `metadata.force_content = text`
4. `executor_sms` detects `force_content` → skips AI generation, sends directly
5. Agent clicks "Resume AI" → `leads.ai_paused = false`

---

## Email Address Convention (Session 19)
| Address | Use |
|---|---|
| `hello@getsalescloser.com` | Welcome email on new user onboarding (`send-welcome-email`) |
| `support@getsalescloser.com` | Operational: agent invites, cron_handoff_brief, cron_weekly_roi, executor_email |
| `billing@getsalescloser.com` | Billing: invoice reminders (`invoice-reminder-worker`), partial payment alerts |

## Sessions 20–24 Implementation Archive

### Session 20 Completed ✅
- **Credit substrate** built: `credit_wallets`, `credit_ledger`, `credit_alert_state`, `orders`, `order_lines`, `idempotency_keys`, `audit_events`, `subscription_contracts`, `usage_rating_events`, `usage_settlements` tables created
- **Seeded**: 44 credit_wallets (11 orgs × 4 keys); credit_ledger migration entries; credit_alert_state rows; billing_mode migrated to `prepaid_strict`
- **`credits.js`** shared module — `initCreditWallet`, `showTopupModal`, wallet card rendering, low-balance flash banner
- **`sentinel.html`**, **`Voice Liaison.html`**, **`Knowledge Brain.html`** — buy credits chips + initCreditWallet wired
- **`dashboard.html`** — Credit Wallet card + initCreditWallet wired (after Growth Intelligence card)
- **`agency_admin.html`** — Credit Wallet card + initCreditWallet wired
- **`enterprise_admin.html`** — Credit Wallet card + initCreditWallet wired
- **`create-credit-topup-order`** edge function — validates token_key/qty, creates orders+billing_intent, returns intent_id
- **`fulfill-paid-order`** edge function — idempotent credit grant, ledger → wallet update, alert recovery check
- **`run-low-balance-alerts`** edge function — 24h debounce cron, email+SMS alerts
- **`webhook-razorpay`** — updated to invoke `fulfill-paid-order` on credit_topup intents
- **`success.html`** — credit_topup branch: "Credits Added!" message with quantity
- **pg_cron job #12** (`low-balance-alerts`, `*/15 * * * *`) created
- All 4 new functions deployed to Supabase

### Pricing & Thresholds (frozen)
| Token | Min Buy | Price | Alert Threshold | Recovery |
|---|---|---|---|---|
| voice_min | 100 min | $0.20/min | < 10 | 20 |
| sms_msg | 2,000 msgs | $0.01/msg | < 100 | 250 |
| ai_credit | 90,000 credits | $0.01/30 = $30 min | < 5,000 | 10,000 |
| wa_msg | 2,000 msgs | $0.01/msg | < 100 | 250 |

### Phase 2 — Personalized Number ✅ (Session 20, fully complete)
- `number_request_checkout.html` — **$110** bundle ($40 number + $30 setup + $20 voice 100min + $20 SMS 2000msg), area code preference, channel selector; SLA = **72 hours**
- `create-number-purchase-order` edge function — 4-line order (number_fee, setup_fee, credit_voice, credit_sms) + billing_intent (intent_source='number_purchase'); `pricing_snapshot.final_invoice_amount = 110`
- `fulfill-number-request` edge function — idempotent; amount integrity check; **grants bundled voice_min+sms_msg credits via credit_ledger + `credit_wallet_add_v1`**; creates org_channel_provision_requests status='payment_received'; emails admin; marks billing_intent 'paid'
- `webhook-razorpay` — number_purchase branch → invokes fulfill-number-request
- `success.html` — number_purchase branch: "Number Requested! 72h provisioning"
- `admin.html` — Number Provisioning Queue section: lists payment_received requests, "Provision" button → modal → calls org_channels_purchase, marks request succeeded
- `executor_sms` — per-org FROM number: looks up org_channels (channel=sms, is_default=true, status=active), falls back to TWILIO_FROM_NUMBER env var
- `executor_voice` — **per-org VAPI phone number ID**: looks up org_channels (channel=voice, is_default=true, status=active, vapi_phone_number_id IS NOT NULL), falls back to VAPI_PHONE_NUMBER_ID env var
- Phase 2 uses existing `org_channels` + `org_channel_provision_requests` tables (no new tables needed)

### Canonical Vocabulary (FROZEN — do not rename)
| Concept | Canonical Name | Notes |
|---|---|---|
| Customer payment initiation | `create-number-purchase-order` | edge function |
| Post-payment credit + provision trigger | `fulfill-number-request` | edge function |
| Admin-triggered Twilio number buy | `org_channels_purchase` | edge function |
| Active per-org channel bindings | `org_channels` | table; `vapi_phone_number_id` + `from_e164` columns |
| Provisioning request lifecycle | `org_channel_provision_requests` | table; statuses: payment_received → succeeded |
| Credit wallet cache | `credit_wallets` | table; never compute balance client-side |
| Immutable credit history | `credit_ledger` | table; `idempotency_key` UNIQUE |

### Phase 3 — Cancel Subscription ✅ (Session 20 part 3)

**New tables:**
- `subscription_contracts` — backfilled from billing_intents for all active orgs; ambiguous cases flagged (`is_ambiguous=true`); key cols: `plan_code`, `billing_cycle`, `gross_amount`, `cycle_start_at`, `cycle_end_at`, `status`, `cancellation_id`
- `cancellation_feedback` — mandatory reason before quote; `reason_code`, `reason_detail`, `would_recommend`
- `refund_quotes` — prorated refund computed from `subscription_contracts`; expires 1h; `net_refund_amount`, `refund_breakdown` JSONB
- `subscription_cancellations` — commit record; `cancellation_mode` (immediate|end_of_term); `effective_at`
- `refund_executions` — idempotent via `idempotency_key` UNIQUE; Razorpay refund API; `status` (pending|succeeded|failed|not_applicable)

**organizations columns added:** `cancellation_status` (NULL|cancelled_immediate|cancelled_end_of_term), `service_ends_at`

**SQL RPC:** `is_org_cancelled_v1(p_org_id UUID) RETURNS BOOLEAN` — STABLE SECURITY DEFINER; checks both immediate and expired end-of-term

**Backfill:** 8 orgs seeded; 2 with real billing data (not ambiguous), 6 ambiguous (no matching billing_intent → `is_ambiguous=true`, `gross_amount=0`)

**New edge functions (all deployed):**
- `initiate-cancellation` — feedback captured first; refund computed from `subscription_contracts.gross_amount`; top-up credits always excluded; number fees excluded unless provision failed; 1h quote expiry; audit_events written
- `confirm-cancellation` — validates quote (not expired, not used); immediate: cancels org_services + bulk-cancels pending/running tasks + invokes execute-refund; end_of_term: sets `service_ends_at = cycle_end_at`; all state changes audited
- `execute-refund` — idempotent; `not_applicable` if amount=0; finds Razorpay payment_id via `payment_attempts` table; calls Razorpay `POST /v1/payments/{id}/refund`; full audit trail

**Runtime enforcement (3 layers):**
- `_shared/security.ts` — 3 new functions: `enforceOrgCancellationForTaskExecutor`, `enforceOrgCancellationForDispatcher`, `enforceOrgCancellationForCampaign`; all use `is_org_cancelled_v1` RPC
- Layer 1 (task creation): `campaign_ticker` — cancellation gate checked before kill-switch; cancelled org campaigns paused
- Layer 2 (dispatcher lease): `execution-dispatcher` — per-task cancellation check before calling executor; blocked tasks marked `blocked` with reason `ORG_CANCELLED`
- Layer 3 (executors): `executor_sms`, `executor_email`, `executor_voice` — cancellation gate after kill-switch; terminal block

**Frontend:**
- `cancel.html` — 3-step flow: (1) reason form (mandatory) → (2) refund preview with breakdown → (3) confirmation screen; ambiguous contract warning shown; full currency formatting
- Cancel buttons added: `dashboard.html` (sidebar below Sign Out), `agency_admin.html` (navbar), `enterprise_admin.html` (navbar)

**Refund exclusion rules (frozen):**
- Top-up credits (`intent_source=credit_topup`): ALWAYS excluded
- Number purchase fees (`intent_source=number_purchase`): excluded if `org_channel_provision_requests.status='succeeded'`; refunded if provision pending/failed
- No refund for end_of_term cancellations (amount=0)

### Routing Fixes ✅ (Session 20 part 4b — Sprint 7 routing hardening)

**Problem:** All three executors silently fell back from inactive org numbers to shared sender with no logging, audit, or policy control. WhatsApp inbound on shared sender was broken (no `platform_channels` row). Cross-org ambiguity was silently dropped.

**`org_channels.fallback_policy`** — TEXT NOT NULL DEFAULT 'allow_shared'; backfill automatic via DEFAULT
- Values: `allow_shared` (use shared + audit), `fail_task` (abort before token, + audit), `admin_override` (use shared + audit + console.error)

**3-step outbound resolution algorithm** (applied in all 3 executors — resolution BEFORE token consumption):
1. Active `is_default=true` org channel → use it (no fallback)
2. Most recent `is_default=true` org channel (any status) → read `fallback_policy`
3. Apply policy: `allow_shared` → shared + `audit_events(action='channel_fallback_triggered')`; `fail_task` → abort, no token consumed; `admin_override` → shared + audit

**`executor_sms`** — `resolveSmsSender()` + `writeFallbackAuditEvent()` at top; resolution at step 4 (before AI + before `consume_tokens_v1`); old inline lookup removed

**`executor_voice`** — `resolveVoiceSender()` selects `vapi_phone_number_id`; moved to step 4.6 (before pre-debit at step 5); `fail_task` calls `failTask()` with no token consumed

**`executor_whatsapp`** — `resolveWaSender()` + `writeWaFallbackAuditEvent()` at top; WhatsApp capability gate at step 1.7 (checks `org_channel_capabilities.whatsapp_enabled`); if false + `whatsapp_fallback_to_sms=true` → rewrites task to `sms` + invokes `executor_sms`

**`webhook_inbound`** — cross-org lead lookup now structured: 0 leads → `audit_events(action='inbound_route_no_lead')`; 2+ leads → `audit_events(action='inbound_route_ambiguous', candidate_org_ids=[...])`; exactly 1 → routes correctly

**`platform_channels` row** — inserted `(twilio, whatsapp, +14155238886, active)` so `resolve_inbound_org_channel_v1` returns `source='platform'` for shared WA inbound (was broken — returned not_found)

**`tests/channel-routing-tests.sql`** — 5 regression tests: SMS allow_shared, SMS fail_task, Voice allow_shared, Shared WA inbound routing, Inbound ambiguity logging. Each test: SETUP (DO $$ block) + VERIFY (checks task status + `COUNT(*) FROM audit_events WHERE action=...`) + TEARDOWN.

**Two frozen operating rules:**
- Rule 1: When moving from sandbox WA to production, always update BOTH `platform_channels.from_e164` AND `TWILIO_WA_FROM_NUMBER` in the same change window
- Rule 2: For premium/branding-sensitive orgs, explicitly set `fallback_policy='fail_task'`

### Items 3/4/5 ✅ (Session 20 part 4c — Admin UI + Org toggles + Delivery dashboard)

**Item 3 — Admin UI for fallback_policy (`admin.html`):**
- "Channel Sender Management" section (P8b) added between P8 (Number Provisioning Queue) and P9 (Rate Limit)
- Table: Org, Channel, Sender, Status, Default, Fallback Policy (editable dropdown per row)
- `loadChannelSenders()` — queries all `org_channels`, joins org names, renders table
- `updateFallbackPolicy(selectEl)` — saves on change via Supabase JS; disables select during save

**Item 4 — Org-facing WhatsApp capability toggle (all 3 portals):**
- `dashboard.html` — WhatsApp Settings card (`dash-wa-body`): reads `org_channel_capabilities.whatsapp_enabled` + `org_channels(channel='whatsapp')`, shows toggle + sender info; `loadDashWaSettings()` + `toggleDashWa()`
- `agency_admin.html` — WhatsApp Settings card (`ag-wa-body`): same pattern, uses `_sb` client; `agLoadWaSettings()` + `agToggleWa()`
- `enterprise_admin.html` — WhatsApp Settings card (`ent-wa-body`): same pattern, uses `sb` client; `entLoadWaSettings()` + `entToggleWa()`

**Item 5 — Delivery status dashboard (all 3 portals):**
- All 3 portals: Delivery Status card alongside WA Settings; fetches `delivery_attempts` last 7 days (limit 500), aggregates by channel×status in JS, renders summary table + recent failures list
- `dashboard.html`: `loadDashDeliveryStatus(orgId, sb)` → card id `dash-delivery-body`
- `agency_admin.html`: `agLoadDeliveryStatus(orgId, sb)` → card id `ag-delivery-body`
- `enterprise_admin.html`: `entLoadDeliveryStatus(orgId, sb)` → card id `ent-delivery-body`

### Phase 4 — WhatsApp ✅ (Session 20 part 4)

**New DB tables (all seeded for all 11 orgs):**
- `org_channel_capabilities` — per-org channel flags: `whatsapp_enabled`, `sms_enabled`, `voice_enabled`, `wa_business_account_id`, `wa_phone_number_id`, `wa_template_namespace`, `wa_opt_in_method`
- `message_routing_policies` — `preferred_channel`, `whatsapp_fallback_to_sms` (default true), `sms_fallback_to_whatsapp` (default false)
- `delivery_attempts` — provider-level message tracking: `task_id`, `channel`, `provider`, `provider_message_id`, `status` (pending|sent|delivered|read|failed|received), `delivered_at`, `read_at`; indexed by task_id + org_id + lead_id + provider_message_id

**`org_channel_type` ENUM:** `whatsapp` value added via `ALTER TYPE org_channel_type ADD VALUE IF NOT EXISTS 'whatsapp'`

**`credit_wallets` wa_msg:** Seeded `wa_msg` wallet (balance=0) for all 11 orgs

**New edge function:**
- `executor_whatsapp` ✅ — same discipline as executor_sms; capability gate before execution; routing policy fallback to SMS if `whatsapp_fallback_to_sms=true` (rewrites task channel + invokes executor_sms); `To: whatsapp:{phone}` / `From: whatsapp:{wa_from}`; token key `wa_msg` (1 token/msg); logs to `delivery_attempts` (pre-send + post-send update); token refund on provider failure; cancellation gate + kill-switch gate

**Updated functions (deployed):**
- `execution-dispatcher` — added `if (channel === "whatsapp") return "/functions/v1/executor_whatsapp"` to `executorPath()`
- `webhook_inbound` (Twilio source):
  - Status callback path: detects `MessageStatus` with no `Body` → updates `delivery_attempts` by `provider_message_id` (delivered_at / read_at / error_code)
  - Inbound WhatsApp: detects `From` starts with `whatsapp:` → strips prefix → sets `channel='whatsapp'` → resolves org via `org_channels(channel='whatsapp')` → logs interaction as `type='whatsapp'` → logs to `delivery_attempts (direction=inbound)` → passes `channel_source='whatsapp'` to reply_router

**Env vars needed for WhatsApp (set in Supabase project secrets):**
- `TWILIO_WA_FROM_NUMBER` — platform-level fallback WhatsApp sender number (e.g. `+14155238886` for sandbox)
- Per-org dedicated sender: stored in `org_channels(channel='whatsapp', from_e164=...)` — takes priority over env var

**Routing policy logic:**
1. `org_channel_capabilities.whatsapp_enabled = false` → check `whatsapp_fallback_to_sms`; if true → rewrite task to `sms` and invoke `executor_sms`; if false → fail task
2. `org_channel_capabilities.whatsapp_enabled = true` → send via WhatsApp; status callbacks update `delivery_attempts`

**WhatsApp setup required (user action):**
- Twilio Sandbox: Enable at console.twilio.com → Messaging → Try it out → WhatsApp; set sandbox webhook to `https://klbwigcvrdfeeeeotehu.supabase.co/functions/v1/webhook_inbound?source=twilio`
- Production: Register WhatsApp Business Number in Twilio → get approved number → set as `TWILIO_WA_FROM_NUMBER` or per-org `org_channels` row
- Meta Business: Must verify Business Manager + WhatsApp Business Account for production template messages

### Phase 5A — RCS (Google RBM) ✅ (Session 20 part 5)

**DB changes:**
- `org_channel_type` ENUM: `rcs` value added
- `org_channel_capabilities`: `rcs_enabled BOOLEAN DEFAULT false`
- `message_routing_policies`: `rcs_fallback_to_sms BOOLEAN DEFAULT true`
- `credit_wallets`: `rcs_msg` seeded for all 11 orgs

**`executor_rcs`** — Google RCS Business Messaging (RBM) / Business Communications REST API
- Auth: Google Service Account → OAuth2 JWT (RFC 7523) via WebCrypto — no third-party deps
- API: `POST https://rcsbusinessmessaging.googleapis.com/v1/phones/{msisdn}/agentMessages?agentId={id}&messageId={uuid}`
- 3-step fallback_policy resolver (per-org dedicated agent stored in `org_channels.provider_id`)
- Capability gate: `rcs_enabled=false` → `rcs_fallback_to_sms` → delegate to `executor_sms` (rewrites channel)
- Device capability fallback: RBM API 403/404 → SMS fallback if `rcs_fallback_to_sms=true` (refunds `rcs_msg`, SMS executor consumes `sms_msg`)
- Token key: `rcs_msg` (1 token/msg); refund on auth/network/provider failure via `grant_tokens_core_v1`
- `delivery_attempts`: pre-send (status=pending) + post-send update (status=sent)
- Env vars: `GOOGLE_RBM_SERVICE_ACCOUNT_JSON` (full SA JSON), `GOOGLE_RBM_AGENT_ID` (platform agent)

**`webhook_inbound` (google_rbm path):**
- `source=google_rbm&token={GOOGLE_RBM_WEBHOOK_SECRET}` — token validated against env var
- Parses Google Pub/Sub push envelope: `{ message: { data: base64(RbmEvent) } }`
- `agentEvent` (DELIVERED/READ): updates `delivery_attempts.status` + timestamps
- `userEvent.text`: cross-org lead lookup → interaction (type='rcs') + delivery_attempts (status=received) + `replyRouter(channel_source='rcs')`
- Ambiguity/no-lead: `audit_events` written (same pattern as WA)

**Other updates:**
- `execution-dispatcher`: routes `channel='rcs'` to `executor_rcs`
- `create-credit-topup-order`: `rcs_msg` added ($0.01/msg, min 2000)
- `reply_router.ts`: `channel_source` type updated to `"sms"|"voice"|"whatsapp"|"rcs"`; `actor_user_id`/`plan_id` made optional

**RBM setup required (user action):**
- Create Google Cloud project → enable Business Communications API → create RBM agent at https://business.google.com/business-messages
- Create Service Account with `rcsbusinessmessaging` scope → download JSON → set as `GOOGLE_RBM_SERVICE_ACCOUNT_JSON` secret
- Register test devices at the Business Communications Console (pre-launch only test devices can receive messages)
- Configure Pub/Sub push subscription → webhook URL: `https://klbwigcvrdfeeeeotehu.supabase.co/functions/v1/webhook_inbound?source=google_rbm&token={GOOGLE_RBM_WEBHOOK_SECRET}`
- For launch: submit RBM agent for Google review (takes 1-5 days)

**Bug fixes also shipped in this session:**
- `fulfill-number-request`: `billing_intents` missing `created_by` in select; `credit_wallets` wrong column names (`balance` → `available_balance`); `credit_ledger` wrong column names (`source`/`reference_id`/`metadata` → `source_object_type`/`source_object_id`/`note`); missing `direction: "credit"`
- `webhook_inbound`: WA inbound `delivery_attempts.provider_message_id` was always null (was reading from URL query instead of Twilio form body `params.MessageSid`)

### Phase 5B — Facebook Messenger ✅ (Session 20 part 6)

**DB changes:** `org_channel_type` ENUM: 'messenger'; `org_channels.provider_token TEXT`; `org_channel_capabilities`: `messenger_enabled` + `messenger_page_id`; `message_routing_policies.messenger_fallback_to_sms`; `leads.messenger_psid TEXT` + index; `messenger_msg` wallets for all 11 orgs

**`executor_messenger`** — Graph API `POST /v21.0/me/messages`; per-org `org_channels.provider_token`; 3-step fallback_policy resolver; capability gate + SMS fallback; PSID guard (step 1.8 — fails task if `leads.messenger_psid=null`); 24h window expiry → audited `channel_fallback_triggered` + SMS fallback (refunds `messenger_msg`); terminal error codes 551/190 = no retry; token key `messenger_msg`; delivery_attempts pre/post-send

**`webhook_inbound` (facebook_messenger):** GET = hub challenge (`FACEBOOK_VERIFY_TOKEN`); POST = `X-Hub-Signature-256` HMAC-SHA256 (`FACEBOOK_APP_SECRET`); delivery/read watermark → `delivery_attempts` updates; inbound text → PSID lookup → interaction + delivery_attempts(received) + replyRouter; no PSID / ambiguous → audit_events (same pattern as all channels)

**Env vars:** `FACEBOOK_PAGE_ACCESS_TOKEN`, `FACEBOOK_PAGE_ID`, `FACEBOOK_VERIFY_TOKEN`, `FACEBOOK_APP_SECRET`

**Per-org page:** `org_channels(channel='messenger', provider_token='{token}', metadata={"page_id":"123"}, is_default=true, status='active')`

**PSID auto-link:** Implemented in Session 21 (see below).

### Session 21 Completed ✅ (2026-03-07)

**Item 1 — Delivery status dashboard (all 5 channels + health badge):**
- All 3 portals: replaced old 3-channel table with `_buildDeliveryHTML(data)` helper
- Covers: sms, whatsapp, rcs, messenger, voice
- Columns: Channel (icon+label), Sent, Delivered, Read, Failed, Health badge
- Health badge: Excellent (0% fail), Normal (<5%), Elevated (>5%), Degraded (>20%)
- Active channel filter: shows only channels with data; falls back to all 5 if no data

**Item 2 — Messenger PSID auto-link:**
- On inbound Messenger: resolve org from page_id via `org_channels(channel='messenger',is_default=true)`
- Among unlinked leads in that org (`messenger_psid IS NULL, is_dnc=false`): exactly 1 → `UPDATE leads SET messenger_psid = psid`
- Audit actions: `messenger_psid_linked`, `messenger_psid_ambiguous`, `messenger_psid_no_match`
- Shared platform page (FACEBOOK_PAGE_ID env) → audit `no_match` (can't infer org)

**Item 3 — Channel Infrastructure widget (all 3 portals):**
- New card "Channel Infrastructure" (fa-tower-broadcast, cyan) after Delivery Status card
- Per channel (SMS/WhatsApp/RCS/Messenger): Dedicated (green) or Shared (grey) badge + Sender ID
- Dedicated = `org_channels.provider_id` exists; Shared = no provider_id
- CTA: "Upgrade to dedicated numbers →" (billing.html) shown if any channel is shared
- JS: `_buildInfraHTML(channels)` shared helper; wrappers `loadDashInfraStatus`/`agLoadInfraStatus`/`entLoadInfraStatus`

**Item 4 — Admin operational controls (admin.html):**
- `loadChannelSenders`: enhanced with Health (7d failure rate badge) and Toggle (Enable/Disable) columns
- `toggleChannelStatus(btn)`: updates `org_channels.status` active↔disabled
- New panel P8c: "Channel Fallback Events" — queries `audit_events WHERE action='channel_fallback_triggered'`, last 7 days, table with Time/Org/Channel/Reason/Fallback To

**Item 5 — Message thread/context routing hardening:**
- `message_threads` table: `(org_id, lead_id, channel, from_identifier, to_identifier, last_message_at)`
- UNIQUE index: `(from_identifier, to_identifier, channel)` — routing key
- `webhook_inbound` SMS/WhatsApp path: thread-first lookup before phone lookup
  - Resolves shared-number ambiguity: same phone on 2 orgs → thread wins unambiguously
  - Thread upsert after successful routing (updates `last_message_at`)
- RLS: `is_org_member` SELECT policy

### ✅ Completed — Sessions 22–24: Institutional-Grade Hardening (All 6 Steps)

1. **Platform Kill Switch** ✅ — `platform_control_flags` table (7 rows seeded); `enforcePlatformKillSwitchFor*` in `_shared/security.ts`; 3-layer enforcement (campaign_ticker + dispatcher + all 6 executors); admin P10 panel in `admin.html` (toggle + mandatory reason + audit); audit: `platform_flag_enabled/disabled`
2. **Global Rate Limiter** ✅ — `rate_limit_buckets` table + indexes; `check_and_increment_rate_limit_v1` atomic dual-scope RPC; `RATE_LIMIT_DEFAULTS` in `security.ts` (sms 30/1000, voice 5/50, email/wa/rcs/messenger 30/500); enforced in all 6 executors BEFORE token consumption — rate-limited tasks rescheduled 60s out (NOT terminal); admin P11 monitor panel; fail-open on RPC error, fail-closed on limit exceeded; audit: `rate_limit_blocked_org`, `rate_limit_blocked_platform`
3. **Dead-Letter Queue** ✅ — `execution_dead_letters` table (snapshot + resolution fields); `execution_policy_v1` updated: MAX_ATTEMPTS_EXCEEDED → `set_status='dead_lettered'` (was `failed_permanent`); dispatcher `applyPolicyToTask`: inserts DLQ snapshot after task update, original task preserved at `status='dead_lettered'` — full forensic record intact; admin P12 panel with Inspect modal / Retry (creates fresh task, attempt=0) / Cancel; "Show resolved" toggle; audit: `execution_dead_lettered`, `execution_dead_letter_retry_requested`, `execution_dead_letter_cancelled`
4. **Provider Webhook Event Store** ✅ — `provider_webhook_events` table (UNIQUE on `provider, provider_event_id`); `persistWebhookEvent` / `markWebhookProcessed` / `markWebhookFailed` helpers in `webhook_inbound/index.ts`; 7 event types instrumented: `sms_inbound` / `whatsapp_inbound` / `whatsapp_status` (Twilio), `vapi_end_of_call` / `vapi_transcript` (VAPI), `rbm_inbound` / `rbm_delivery_receipt` (RBM), `messenger_inbound` (Facebook); idempotency gate on `already_processed=true` → return 200 immediately (prevents double token settlement, double routing); VAPI end-of-call gated because it settles voice tokens; `messageSid` hoisted to outer scope (fixes latent `params` block-scope bug in WA delivery_attempts); admin P13 panel with provider/status/time filters + summary counts + Inspect modal; `webhook_inbound` redeployed with `--no-verify-jwt` (was missing — caused Facebook GET verification 401)
5. **Channel Health Monitor** ✅ — `channel_health_current` (single table; `org_id IS NULL` = platform row, org UUID = org row); two partial unique indexes: `(org_id, channel) WHERE org_id IS NOT NULL` and `(channel) WHERE org_id IS NULL`; `compute_channel_health_v1()` PL/pgSQL function (UPSERT from `delivery_attempts` over last 1h); pg_cron job #14 every 5min; thresholds: excellent(<1%), normal(<3%), elevated(<7%), degraded(≥7%), unknown(no data); `delivery_attempts.sent_at` index added; dashboard: new "Channel Health" card reads from `channel_health_current` (canonical badge); existing "Delivery Status" 7-day card no longer shows client-computed badge (removed — single source of truth); admin P14: platform-level table + degraded/elevated orgs breakdown
6. **Idempotency Guard for Executors** ✅ — `UNIQUE INDEX delivery_attempts_task_attempt_uidx ON delivery_attempts (task_id, attempt_number) WHERE task_id IS NOT NULL`; all 6 executors: pre-send INSERT with `attempt_number: task.attempt ?? 1`; on 23505 unique_violation → idempotent skip (return 200) — prevents double-send on dispatcher retry / network timeout; executor_sms + executor_email + executor_voice: delivery_attempts fully added for the first time (tracking + idempotency); executor_whatsapp + executor_rcs + executor_messenger: delivery_attempts existing, now include `attempt_number` + 23505 guard; all 6 redeployed

### ✅ Session 25 Completed (2026-03-09) — Cancel Flow + Data Deletion

**Bugs fixed this session:**
- `initiate-cancellation` + `confirm-cancellation` deployed with `--no-verify-jwt` (gateway was rejecting user JWTs)
- Cancellation email: changed from `billing@` → `support@getsalescloser.com` (confirmed working); moved before `execute-refund` so Razorpay latency can't block delivery
- Number purchase always excluded from refund (Twilio is non-refundable regardless of provision status); removed `numberRefund` logic
- Currency fixed to USD (`$` / `en-US`) throughout cancel.html (was `₹` / `en-IN`)
- Post-cancellation step 3 now mode-aware: immediate → 45s countdown + redirect to `index.html`; end-of-term → dashboard button
- Error messages throughout cancel flow now show the actual server error (not generic fallback)

**New feature — Delete My Data:**
- `export-and-delete-org-data` edge function: exports leads + interactions + appointments as CSV attachments (Resend), deletes all org data
- `cancel.html` step 3: "Delete My Data" button (both modes) → confirmation popup → calls function
- Immediate: CSV sent + data deleted immediately
- End of term: CSV backup sent now + deletion scheduled for `service_ends_at`
- DB: `data_deletion_requested` + `data_deletion_processed_at` added to `subscription_cancellations`
- pg_cron job #16 (`scheduled-data-deletions`, daily 2am UTC): `process_scheduled_data_deletions()` fires `export-and-delete-org-data` for end-of-term orgs past their end date

**E2E tests confirmed this session:**
- ✅ D1 — Credit top-up: payment → "Credits Added!" → wallet balance updated
- ✅ D2 — Low balance alert: email received from `support@getsalescloser.com`
- ✅ D3 — Number purchase: $110 payment → provisioning queue → admin provisions Twilio number → `org_channels` created
- ✅ E1 — Cancel immediate: 3-step flow works; `cancellation_status='cancelled_immediate'`; redirect to `index.html`; cancellation email confirmed pending (email sender fix deployed this session)
- ⚠️ E2 — Cancel end-of-term: flow complete, not yet re-tested after email fix

**Known state for next session:**
- Test org (`4c4ae696-de66-4b32-833c-b656454437d6` / personal-org) has been reset: `cancellation_status=NULL`, `org_services.status=active`, `subscription_contracts.status=active`
- `recover-payment` function live: `payment.html` stores `razorpay_payment_id` in `payment_attempts.provider_ref`; `success.html` auto-recovers on timeout — no more manual intervention needed
- Dynamic pricing on `number_request_checkout.html`: SMS-only=$90, Voice-only=$90, Both=$110
- Admin provisioning: reads channel from original purchase (no dropdown); supports 'both' → provisions sms + voice in sequence

---

### ⚠️ NEXT SESSION — START HERE: E2E Testing (Resume from Group E)

**Do these first thing. Run every item in order. Note ✅ or ❌ with the exact error for any failure.**

#### Group E — Subscription Cancellation (finish first)
- [ ] **Confirm cancellation email received**: Re-test immediate cancel → confirm email from `support@getsalescloser.com` arrives with correct refund details
- [ ] **Cancel — end of term**: 3-step flow → choose "Cancel at end of billing period" → confirm → `organizations.service_ends_at` set; services still active; cancellation email received
- [ ] **Delete My Data — immediate**: After immediate cancel, click "Delete My Data" → confirm popup → CSV export email arrives with 3 attachments; `leads` table empty for org; `data_deletion_processed_at` populated
- [ ] **Delete My Data — end of term**: After end-of-term cancel, click "Delete My Data" → CSV backup email arrives now; `data_deletion_requested=true`; actual deletion deferred to `service_ends_at`

#### Group A — Core SMS Pipeline (do next — everything else depends on SMS)
- [ ] **Mirror Test**: Open `dashboard.html` → complete onboarding step 2 → enter your phone → verify AI intro SMS received within 60s; check `delivery_attempts` row with `status='sent'`
- [ ] **SMS outbound**: Create a lead → let decision engine + dispatcher run → executor_sms fires → verify SMS received + `delivery_attempts(status='sent', provider_message_id=<sid>)` populated
- [ ] **SMS inbound reply**: Reply to the SMS above → verify `interactions(type='sms', direction='inbound')` row created + AI response SMS fires back
- [ ] **Idempotency guard — SMS**: Manually invoke executor_sms twice with the same `task_id` → second call must return `{skipped:true, reason:'duplicate_invocation'}` (HTTP 200); only 1 `delivery_attempts` row for that `(task_id, attempt_number)`

#### Group B — Widget & Lead Capture
- [ ] **widget_inbound — name stopword filter**: Open `chat.html?org=<id>` → type "Hello" → AI asks for name → reply with a stopword like "okay" or "yes" → AI asks again (stopword correctly rejected)
- [ ] **widget_inbound — last-10-digit dedup**: Submit the same phone number from two different chat sessions → only 1 lead row created; second session reuses existing lead
- [ ] **widget_inbound — email capture when no booking**: Use an org with no `cal_link` set + architect service inactive → steer conversation to appointment intent → AI asks for email instead of dropping a booking link

#### Group C — Email Pipeline
- [ ] **Email outbound**: Create an email `execution_task` → dispatch → verify email arrives in inbox + `delivery_attempts(status='sent')` row written
- [ ] **Deploy AI card lock**: Log in as a user whose org has sentinel service INACTIVE → open `dashboard.html` → verify "Deploy AI" card shows the locked/upgrade state (not the embed code)

#### Group F — Automations & Scheduled Jobs
- [ ] **cron_handoff_brief**: Insert test row into `appointments` with `status='scheduled'` at `NOW() + 7 minutes` → wait for pg_cron #9 (fires every 5min) → verify brief SMS/email received with GPT-generated summary of last interactions
- [ ] **Weekly ROI email**: Invoke `cron_weekly_roi` manually via Supabase Functions console → verify styled ROI email received in org owner's inbox with correct 7-day metrics

#### Group G — WhatsApp Channel
- [ ] **WhatsApp outbound (sandbox)**: Confirm `TWILIO_WA_FROM_NUMBER` is set (sandbox: `+14155238886`) → create `execution_task(channel='whatsapp')` for a lead → dispatch → verify WA message received on sandbox-joined device; `delivery_attempts(status='sent')` row written
- [ ] **WhatsApp delivery callback**: Twilio sends `MessageStatus=delivered` webhook → verify `delivery_attempts.status='delivered'` + `delivered_at` populated
- [ ] **WhatsApp SMS fallback**: Set `org_channel_capabilities.whatsapp_enabled=false` + `whatsapp_fallback_to_sms=true` → dispatch WA task → SMS received instead
- [ ] **WhatsApp inbound**: Lead texts sandbox WA number → `interactions(type='whatsapp', direction='inbound')` + AI reply sent back

#### Group H — Facebook Messenger
- [ ] **Messenger webhook verification**: ✅ Already confirmed live
- [ ] **Messenger PSID auto-link**: Lead messages Facebook Page → `leads.messenger_psid` populated; `audit_events(action='messenger_psid_linked')` row exists
- [ ] **Messenger outbound**: PSID linked → dispatch `execution_task(channel='messenger')` → message in Facebook inbox; `delivery_attempts(status='sent')`
- [ ] **Messenger 24h window SMS fallback**: Expired 24h window → task channel rewritten to `'sms'`; `audit_events(action='channel_fallback_triggered')`

#### Group I — Platform Hardening (Admin Panels)
- [ ] **Platform kill switch**: admin.html P10 → toggle SMS ON → task blocked with `PLATFORM_KILL_SWITCH` → toggle OFF → SMS succeeds
- [ ] **Dead-letter queue**: Force max_attempts exhaustion → `execution_dead_letters` row → admin P12 Retry → fresh task created
- [ ] **Webhook event store**: Inbound event → admin P13 → `provider_webhook_events` row with correct provider + status='processed'
- [ ] **Channel health monitor**: Send messages → wait 5min → `channel_health_current` rows; dashboard badges not all "Unknown"
- [ ] **Rate limiter admin panel**: Admin P11 loads bucket counts; (optional) exhaust org limit

#### Group J — Multi-Tenant Flows
- [ ] **Agent invite E2E**: Agency admin invites → agent receives email → claims invite → lands on `agent_dashboard.html`
- [ ] **Agent human takeover**: Takeover → manual SMS sent → Resume AI → AI resumes on next inbound
- [ ] **Enterprise leaderboard**: `enterprise_admin.html` leaderboard loads with agent stats

---

## Supabase Direct Access
PAT + service role key in Claude memory: `supabase-access.md`
```bash
curl -s -X POST "https://api.supabase.com/v1/projects/klbwigcvrdfeeeeotehu/database/query" \
  -H "Authorization: Bearer {PAT}" -H "Content-Type: application/json" \
  -d '{"query": "SQL;"}'
```

---

## Known Gotchas

1. **`api_keys` column names**: `api_key` (not `key`), `name` (not `label`) — check all frontend code touching this table
2. **`decision_plans` INSERT**: must include `plan: {}` (jsonb, NOT NULL); no `status` or `metadata` columns
3. **`leads` INSERT**: must include `profile_id: currentUser.id` (NOT NULL)
4. **`billing_intents` UPDATE**: blocked by RLS from client side — always use `mark_intent_awaiting_bank` RPC
5. **`create_checkout_intent`** uses `members` table (legacy) — patched in Session 14 to fall back to `org_members`
6. **`.maybeSingle()` on multi-row results**: throws PGRST116 → use `.limit(1)` returning array then `[0]`
7. **Role pages** need `requireOnboarding: false` in `requireAuth()` or new users get blank screen
8. **`admin.html` JWT**: must pass `_adminToken` explicitly in `global.headers` and in `functions.invoke()` headers
9. **`executor_sms` force_content**: tasks with `metadata.force_content` skip AI generation — used by human takeover
10. **`widget_inbound` history**: capped at 20 turns; each content truncated to 1000 chars — do not increase without measuring token cost
