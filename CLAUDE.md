# CLAUDE.md — GetSalesCloser Project Guide

> Last updated: 2026-03-07 (Session 20) | Full session history → `docs/SESSIONS.md`

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
| `dashboard.html` | Solo user command center — leads, AI persona, deploy widget, API keys, Mirror Test onboarding, Live Wire | ✅ Complete (Session 18) |
| `agency_admin.html` | Agency portal — seat mgmt, invites, AI persona, deploy widget, API keys, Live Wire | ✅ Complete (Session 18) |
| `enterprise_admin.html` | Enterprise command — leaderboard, agents, overseer, closed won review, AI persona, deploy widget, API keys, Live Wire | ✅ Complete (Session 18) |
| `agent_dashboard.html` | Agent view — my leads, action panel, takeover/manual reply/resume AI, pending actions, Live Wire | ✅ Complete (Session 18) |
| `admin.html` | Finance command — bank transfers, entitlements, prompt editor, rate limits, partial payment, deals | ✅ Complete |
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
`profiles`, `leads`, `interactions`, `appointments`, `voice_usage`, `lead_timeline_events`, `lead_actions`, `org_members`, `org_services`, `org_settings`, `billing_intents`, `payment_attempts`, `knowledge_base`, `security_events`, `execution_tasks`, `voice_calls`, `notifications`, `campaigns`, `campaign_leads`, `org_channels`, `org_channel_provision_requests`, `conversation_state`, `active_org_prompts` (VIEW), `decision_plans`, `organizations`, `org_invitations`, `manual_action_requests`, `org_billing_profiles`, `org_prompts`, `api_keys`, `beta_interest`, `app_admins`, `members` (legacy)

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

## ⚠️ NEXT SESSION — START HERE (Session 20 / Sprint 7)

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

### E2E Manual Test Checklist (still needs live testing)
- [ ] Mirror Test: enter your phone in onboarding step 2 → verify SMS received
- [ ] widget_inbound: name stopword filter works
- [ ] widget_inbound: last-10-digit dedup
- [ ] widget_inbound: email collected when org has no cal_link + architect inactive
- [ ] Deploy AI card: shows lock state when sentinel inactive
- [ ] cron_handoff_brief: create test appointment 7 min from now → verify SMS/email received
- [ ] Credit top-up: buy 2,000 SMS credits → payment → success.html shows "Credits Added!" → wallet balance updates
- [ ] Low balance alert: manually set wallet below threshold → run-low-balance-alerts → email/SMS received
- [ ] Number purchase: click "Get Your Number" → $110 checkout → payment → success.html shows "72h provisioning" → admin.html Provisioning Queue shows the request → Provision modal → org_channels row created
- [ ] WhatsApp sandbox: set `TWILIO_WA_FROM_NUMBER` → create execution_task with channel='whatsapp' → dispatch → verify WA message received on sandbox; check delivery_attempts row status='sent'
- [ ] WhatsApp status callback: Twilio sends delivered webhook → delivery_attempts.status becomes 'delivered', delivered_at populated
- [ ] WhatsApp SMS fallback: set org_channel_capabilities.whatsapp_enabled=false + whatsapp_fallback_to_sms=true → dispatch WA task → verify SMS received instead + task channel rewritten to 'sms'
- [ ] WhatsApp inbound: lead replies to WA number → interactions row with type='whatsapp' created + delivery_attempts row status='received'

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
