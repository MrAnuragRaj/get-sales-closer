# CLAUDE.md — GetSalesCloser Project Guide

> Last updated: 2026-03-12 (Revenue Doctor Session 9 — verified) | Full session history → `docs/SESSIONS.md`

**Live URL**: https://www.getsalescloser.com (Vercel) | **Supabase**: https://klbwigcvrdfeeeeotehu.supabase.co
**Admin email**: anurag@yogmayaindustries.com | **Admin password**: AdminGSC2026

---

## Tech Stack

| Layer | Choice |
|---|---|
| Frontend | Vanilla HTML5 + Tailwind CSS (CDN) + Vanilla ES6+ JS (no build step) |
| Backend | Supabase (PostgreSQL + Auth + Storage + Edge Functions) |
| AI | OpenAI GPT-4o-mini (intent/chat/upsell), GPT-4o (knowledge brain — law/medical) |
| Voice | VAPI | SMS | Twilio | Email | Resend |
| Payments | Razorpay (live key in payment.html) | Hosting | Vercel |
| Icons | FontAwesome 6.4.0 (CDN) | Fonts | Google Fonts — Inter |

---

## File Map

| File | Purpose | Status |
|---|---|---|
| `index.html` | Landing page, ROI calculator, dynamic pricing engine | ✅ |
| `login.html` | Auth (OTP + OAuth + Email/Password) + invitation claim + role routing | ✅ |
| `auth.js` | Central auth guard — `requireAuth()` pattern | ✅ |
| `dashboard.html` | Solo user command center — leads, AI persona, deploy widget, API keys, Mirror Test, Live Wire, Credit Wallet, Delivery Status, Channel Infrastructure | ✅ Session 21 |
| `agency_admin.html` | Agency portal — seat mgmt, invites, AI persona, Credit Wallet, Channel Infrastructure | ✅ Session 21 |
| `enterprise_admin.html` | Enterprise command — leaderboard, agents, overseer, Credit Wallet, Channel Infrastructure | ✅ Session 21 |
| `agent_dashboard.html` | Agent view — leads, takeover/manual reply/resume AI, pending actions, Live Wire | ✅ Session 18 |
| `admin.html` | Finance command — bank transfers, entitlements, prompt editor, deals, Channel Sender Mgmt, Provisioning Queue, Kill Switch, Rate Limits, Dead-Letter Queue, Webhook Store, Channel Health | ✅ Session 24 |
| `revenue_doctor.html` | Revenue Doctor — generate + view diagnostic reports, buy bundles, share/export | ✅ RD Session 9 |
| `number_request_checkout.html` | $110 dedicated number bundle purchase flow | ✅ Session 20 |
| `cancel.html` | 3-step subscription cancellation + Delete My Data | ✅ Session 25 |
| `sentinel.html` | Instant Sentinel — lead list + CRM modal + conversion probability | ✅ |
| `pricing.html` | New user plan selector → `create_checkout_intent` | ✅ |
| `billing.html` | Upgrade/manage plan for existing subscribers | ✅ |
| `payment.html` | Razorpay checkout + bank transfer | ✅ |
| `success.html` | Post-payment verification (polls billing_intents) | ✅ |
| `Voice Liaison.html` | Call logs + sentiment + Replay button | ✅ |
| `Knowledge Brain.html` | PDF upload + text rules + read/delete view | ✅ |
| `App Architect.html` | Appointment scheduling viewer | ✅ |
| `embed.js` / `chat.html` | Embeddable chat widget + hosted Smart Link chat | ✅ |

---

## Edge Functions

| Function | Key Notes |
|---|---|
| `executor_sms` | Twilio SMS; `force_content` bypass; per-org FROM number |
| `executor_email` | Resend email |
| `executor_voice` | VAPI; billing lock guard; per-org phone_number_id |
| `executor_whatsapp` | Twilio WhatsApp; capability gate; SMS fallback |
| `executor_rcs` | Google RBM; WebCrypto SA→OAuth2 JWT; SMS fallback |
| `executor_messenger` | Graph API v21.0; PSID guard; 24h window SMS fallback |
| `webhook_inbound` | Twilio SMS/WA/VAPI/RBM/Messenger; `--no-verify-jwt`; 128KB guard |
| `hook_inbound` | CRM ingestion (GHL/Zapier/Make/Apollo/HubSpot/Generic); `api_keys` auth |
| `widget_inbound` | AI chat widget; persona injection; history capped at 20 turns |
| `webhook-razorpay` | Razorpay payment webhook |
| `send-agent-invite` | Invitation email (Resend); `--no-verify-jwt` |
| `send-welcome-email` | Welcome email on onboarding; `--no-verify-jwt` |
| `generate-upsell-insight` | GPT-4o-mini upsell copy; `--no-verify-jwt` |
| `cron_handoff_brief` | Pre-meeting SMS/email brief; pg_cron #9 `*/5 * * * *` |
| `cron_weekly_roi` | Weekly ROI email; pg_cron #10 `0 8 * * 1` |
| `intent_ai` | GPT-4o-mini intent classifier (13 labels) |
| `knowledge_brain` | GPT-4o-mini (general) / GPT-4o (law, medical) |
| `initiate-cancellation` | Feedback + prorated refund quote (1h expiry); `--no-verify-jwt` |
| `confirm-cancellation` | Validates quote; immediate/end_of_term cancel; `--no-verify-jwt` |
| `execute-refund` | Idempotent Razorpay refund via `payment_attempts.provider_ref` |
| `export-and-delete-org-data` | CSV export (leads/interactions/appointments via Resend) + deletion |
| `run-low-balance-alerts` | 24h debounce; email+SMS per token key; `--no-verify-jwt` |
| `create-checkout-intent` | Razorpay subscription checkout |
| `create-credit-topup-order` | Credit top-up; `doctor_report` bundles (5/$79, 10/$149, 20/$249) |
| `create-number-purchase-order` | $110 bundle: number+setup+voice 100min+SMS 2000msg |
| `fulfill-paid-order` | Idempotent credit grant; `credit_wallet_add_v1`; syncs `token_wallets` for `doctor_report` |
| `fulfill-number-request` | Grants voice_min+sms_msg; creates provision_request; emails admin |
| `revenue-doctor-generate` | GPT-4o diagnostic; 40s timeout; 3/min rate limit; enterprise team intelligence |
| `revenue-doctor-reports` | List/fetch saved reports |
| `connect-facebook-page` | FB OAuth for per-org Messenger page token |
| `org_channels_*` (5 fns) | Channel management |
| `campaign_ticker`, `decision_engine`, `execution_planner`, `execution-dispatcher`, `task_sweeper` | Core automation pipeline |
| `invoice-reminder-worker` | `REMINDER_DRY_RUN=false` (live) |

**Shared modules** (`_shared/`): `db.ts`, `brain.ts`, `persona_builder.ts`, `reply_router.ts`, `intent_ai.ts`, `intent_rules.ts`, `conversation_state.ts`, `security.ts`, `retry_policy.ts`, `strike_time.ts`, `revenue_adapters.ts`, `health_scorer.ts`, `doctor_payload_builder.ts`, `pii_scrubber.ts`, `team_attention.ts`, `guardrails/`

---

## Database — Reference Schema

### All Tables
**Core:** `profiles`, `leads`, `interactions`, `appointments`, `voice_usage`, `lead_timeline_events`, `lead_actions`, `org_members`, `org_services`, `org_settings`, `billing_intents`, `payment_attempts`, `knowledge_base`, `security_events`, `execution_tasks`, `voice_calls`, `notifications`, `campaigns`, `campaign_leads`, `org_channels`, `org_channel_provision_requests`, `conversation_state`, `active_org_prompts` (VIEW), `decision_plans`, `organizations`, `org_invitations`, `manual_action_requests`, `org_billing_profiles`, `org_prompts`, `api_keys`, `beta_interest`, `app_admins`, `members` (legacy), `platform_channels`

**Credits:** `credit_wallets`, `credit_ledger`, `credit_alert_state`, `orders`, `order_lines`, `idempotency_keys`, `usage_rating_events`, `usage_settlements`

**Cancellation:** `subscription_contracts`, `cancellation_feedback`, `refund_quotes`, `subscription_cancellations`, `refund_executions`

**Channels:** `org_channel_capabilities`, `message_routing_policies`, `delivery_attempts`, `message_threads`

**Hardening:** `platform_control_flags`, `rate_limit_buckets`, `execution_dead_letters`, `provider_webhook_events`, `channel_health_current`

**Revenue Doctor:** `revenue_doctor_reports`, `doctor_report_metrics`

### Key Columns

| Column | Table | Notes |
|---|---|---|
| `is_admin` | `profiles` | Platform admin flag |
| `phone` | `profiles` | Closer's mobile for meeting alert SMS |
| `org_type` | `organizations` | NULL / 'agency' / 'enterprise' |
| `cancellation_status` | `organizations` | NULL / cancelled_immediate / cancelled_end_of_term |
| `service_ends_at` | `organizations` | End-of-term cancellation effective date |
| `role` | `org_members` | NULL / 'agency_admin' / 'enterprise_admin' / 'enterprise_agent' |
| `assigned_to` | `leads` | UUID → auth.users; NULL = solo |
| `ai_paused` | `leads` | Blocks AI routing (set by Takeover) |
| `messenger_psid` | `leads` | Facebook Messenger PSID |
| `fallback_policy` | `org_channels` | allow_shared / fail_task / admin_override |
| `provider_token` | `org_channels` | Per-org Facebook page access token |

### `api_keys` Columns (exact — easy to get wrong)
`id`, `org_id`, `api_key` (**NOT** `key`), `name` (**NOT** `label`), `created_at`, `last_used_at`

### `execution_tasks` Key Columns
`id`, `plan_id` (NOT NULL), `lead_id`, `org_id`, `channel`, `status`, `attempt`, `max_attempts`, `scheduled_for`, `executed_at`, `last_error`, `metadata` (JSONB), `locked_by`, `locked_until`, `provider`, `provider_id`, `actor_user_id`, `ai_generation_locked`

### Key RPCs
`consume_tokens_v1` · `grant_tokens_core_v1` · `credit_wallet_add_v1` · `settle_voice_call_tokens_v2` · `is_org_cancelled_v1` · `is_kill_switch_enabled_v1` · `enforce_rate_limit_v1` · `execution_policy_v1` · `resolve_inbound_org_channel_v1` · `approve_bank_transfer` · `mark_intent_awaiting_bank` · `create_agency_enterprise_deal` · `approve_agency_enterprise_deal` · `get_agent_leaderboard`

### pg_cron Jobs

| ID | Schedule | Target |
|---|---|---|
| 8 | daily 3am UTC | cleanup-conversation-state (90d TTL) |
| 9 | `*/5 * * * *` | `cron_handoff_brief` |
| 10 | `0 8 * * 1` | `cron_weekly_roi` |
| 11 | `* * * * *` | `process_pending_activations()` |
| 12 | `*/15 * * * *` | `run-low-balance-alerts` |
| 13 | `0 4 * * *` | `run_wallet_ledger_reconciliation()` |
| 14 | `*/5 * * * *` | `compute_channel_health_v1()` |
| 16 | daily 2am UTC | `process_scheduled_data_deletions()` |
| 17 | `5 0 1 * *` | `refresh_doctor_report_credits()` |

### Storage Buckets
`logos` (company branding), `documents` (Knowledge Brain PDFs)

---

## Architecture Patterns

### Auth Guard
All protected pages: `requireAuth({ onAuthenticated: (profile, user, sb) => {} })`
- Requires: `<script src="auth.js">`, `<div id="auth-loader">` (visible), `<div id="page-content">` (hidden)
- Role pages (`agency_admin.html`, `enterprise_admin.html`, `agent_dashboard.html`) need `requireOnboarding: false`
- Exception: `pricing.html` + `payment.html` use inline auth-loader pattern (no auth.js)

### Entitlement Check
```js
const { data: svc } = await sb.from('org_services').select('status')
  .eq('org_id', membership.org_id).eq('service_key', 'sentinel').maybeSingle();
if (svc?.status !== 'active') window.location.href = 'billing.html?lock=sentinel';
```
Service keys: `sentinel` | `voice` | `brain` | `architect`

### Token System
- Voice: 5 tokens pre-debit → settled via `settle_voice_call_tokens_v2`
- SMS/Email/WA/RCS/Messenger: 1 token each → `consume_tokens_v1(p_idempotency_key: task_id)`
- Refund on failure: `grant_tokens_core_v1`
- `consume_tokens_v1` reads `token_wallets` (runtime layer) — NOT `credit_wallets` (display layer)

### Executor Guard Order (frozen)
`platform kill switch → org kill switch → org cancellation → rate limit → channel capability → binding/fallback resolution → token/billing → delivery_attempt INSERT (idempotency 23505 guard) → send → delivery_attempt UPDATE`

### Human Takeover Flow
1. Agent clicks "Takeover" → `leads.ai_paused = true`
2. Agent types → `execution_tasks` with `metadata.force_content = text`
3. `executor_sms` detects `force_content` → skips AI, sends directly
4. Agent clicks "Resume AI" → `leads.ai_paused = false`

### Credit Purchase — doctor_report Special Case
`fulfill-paid-order` must call **both** `credit_wallet_add_v1` (display layer) **and** `grant_tokens_core_v1(scope='org')` for `doctor_report`. `consume_tokens_v1` reads `token_wallets` — if only `credit_wallets` is updated, quota appears added but generation fails at quota check.

---

## Email Address Convention

| Address | Use |
|---|---|
| `hello@getsalescloser.com` | `send-welcome-email` — new user onboarding |
| `support@getsalescloser.com` | `send-agent-invite`, `executor_email`, `cron_handoff_brief`, `cron_weekly_roi`, cancellation emails |
| `billing@getsalescloser.com` | `invoice-reminder-worker`, partial payment alerts |

---

## Revenue Doctor — Current State

**Files:** `revenue_doctor.html` · `revenue-doctor-generate/index.ts` · `revenue-doctor-reports/index.ts`
**Shared:** `revenue_adapters.ts` · `health_scorer.ts` · `doctor_payload_builder.ts` · `pii_scrubber.ts` · `team_attention.ts`

| Session | What | Status |
|---|---|---|
| RD 1–7 | DB + shared modules + edge fns + viewer + dashboard widgets + hardening | ✅ |
| RD 8 | Buy bundles (5/$79, 10/$149, 20/$249), share link, export PDF/MD, staged loading, age indicator | ✅ |
| RD 9 | Enterprise Team Intelligence — per-agent rollup, 6 flags, priority score, 3 new UI sections | ✅ Verified |
| RD 10 | E2E testing of full Revenue Doctor flow end-to-end | ⬜ Next |

**Key facts:**
- Token key: `doctor_report` scope=org; monthly reset pg_cron #17; enterprise=999, voice=10
- Quota reads `token_wallets` (NOT `credit_wallets`); enterprise shows "Unlimited" when balance ≥ 900
- Enterprise team sections (`team_overview`, `users_requiring_attention`, `coaching_priorities`) present only when `org_type='enterprise'`; old reports without these keys render cleanly
- Agent eligibility: `org_members WHERE role='enterprise_agent'` + `profiles(full_name, email)`; min 10 leads + 5 convs to rank
- No new DB schema in RD Session 9 — pure code changes (4 files)

---

## Active E2E Test Status

| Group | Status | Notes |
|---|---|---|
| H — Messenger | ✅ Complete | Full round-trip verified |
| E — Cancellation | ✅ Complete | Immediate, end-of-term, Delete My Data |
| G — WhatsApp | ✅ Complete | Outbound, callbacks, SMS fallback, inbound AI |
| I — Platform Hardening | ✅ Complete | Kill switch, dead-letter, webhook store, health, rate limiter |
| J — Multi-Tenant | ✅ Complete | Agent invite, takeover/resume, leaderboard |
| A — SMS Pipeline | ⚠️ BLOCKED | Awaiting Twilio USA number approval |
| B — Widget | ⚠️ BLOCKED | Test after A |
| C — Email | ⚠️ BLOCKED | Test after A |
| F — Automations | ⚠️ BLOCKED | Test after A |
| RD — Revenue Doctor | ⬜ Next | Session RD 10 — E2E full flow |

**When Twilio USA approval arrives:** test Groups A → B → C → F in order.

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

1. **`api_keys` columns**: `api_key` (not `key`), `name` (not `label`)
2. **`decision_plans` INSERT**: must include `plan: {}` (jsonb NOT NULL); no `status` or `metadata` columns
3. **`leads` INSERT**: must include `profile_id: currentUser.id` (NOT NULL)
4. **`billing_intents` UPDATE**: blocked by RLS from client — always use `mark_intent_awaiting_bank` RPC
5. **`.maybeSingle()` on multi-row results**: throws PGRST116 → use `.limit(1)` then `[0]`
6. **Role pages** need `requireOnboarding: false` in `requireAuth()`
7. **`admin.html` JWT**: must pass `_adminToken` in both `global.headers` and `functions.invoke()` headers; read fresh from `localStorage` on every call (expires after 1h)
8. **`executor_sms` force_content**: tasks with `metadata.force_content` skip AI — used by human takeover
9. **`widget_inbound` history**: capped at 20 turns; each content truncated to 1000 chars
10. **Supabase JS v2 `.catch()`**: not a function on `PostgrestBuilder` — use `.then(undefined, handler)` instead
11. **`consume_tokens_v1` params**: `p_scope`, `p_user_id`, `p_amount` (not `p_quantity`); returns `{status:'ok'}` on success
12. **`grant_tokens_core_v1` params**: `p_scope`, `p_user_id`, `p_amount`, `p_metadata` (not `p_note`)
