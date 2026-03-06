# CLAUDE.md — GetSalesCloser Project Guide

> Last updated: 2026-03-06 (Session 19) | Full session history → `docs/SESSIONS.md`

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
| `create-checkout-intent` | ✅ | Razorpay checkout intent |
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

## ⚠️ NEXT SESSION — START HERE (Sprint 6)

### Session 19 Completed ✅
- API Key column audit fixed (all 3 dashboards: `api_key`, `name`)
- Growth Intelligence card added to `dashboard.html` + `enterprise_admin.html`
- Enterprise admin Remove Agent: lead reassignment required before deletion
- Email sender addresses standardized (see Email Address Convention above)
- `send-welcome-email` function created + deployed; called from `dashboard.html` onboarding paths
- `invoice-reminder-worker` FROM hardcoded to `billing@getsalescloser.com`
- `knowledge_base.org_id` column added; `brain.ts` reads text_rules by org_id
- `process_pdf_knowledge` edge function created (PDF → GPT-4o-mini → content_text)
- Service activation root cause fixed: `process_pending_activations()` SQL fn + pg_cron job #11 (every minute)
- anurag@getsalescloser.com: all 4 services manually activated; embed.js widget on index.html
- Orphaned activation_jobs (2 records) marked `failed` (org didn't exist)

### Item 1 — API Key Column Audit (VERIFY FIRST)
The `api_keys` DB columns are `api_key` + `name`. Check that the CRM Webhook card in `dashboard.html`, `agency_admin.html`, `enterprise_admin.html` uses correct column names when querying and inserting. If using `key` or `label` anywhere → fix before testing.

```js
// CORRECT query pattern:
const { data: keyRow } = await sb.from('api_keys')
  .select('id, api_key, name, created_at, last_used_at')
  .eq('org_id', currentOrgId).maybeSingle();
// CORRECT insert pattern:
await sb.from('api_keys').insert({ org_id: currentOrgId, name: 'Default' });
```

### Item 2 — AI Insights Dashboard (Sprint 6 main feature)
Add analytics card to `dashboard.html` (and enterprise_admin.html) showing:
- Total leads captured via Site Liaison (`source = 'site_liaison'` OR `source = 'hook_inbound'`)
- Conversion rate for widget leads vs manual leads
- Weekly new leads trend (last 4 weeks — simple bar sparkline)
- Top performing source breakdown (pie/bar)
Query pattern: `leads` table filtered by `org_id` + `created_at >= 28 days ago`, group by source and week.
Do NOT add AI API calls — pure DB aggregation.

### Item 3 — Manual E2E Checklist (widget_inbound)
These need live testing (can't be automated):
- [ ] Mirror Test: enter your phone in onboarding step 2 → verify SMS received
- [ ] widget_inbound: name stopword filter works (say "my name is Durgesh and I need help" → only "Durgesh" captured)
- [ ] widget_inbound: last-10-digit dedup (same number twice → 1 lead row)
- [ ] widget_inbound: email collected when org has no cal_link + architect inactive
- [ ] Deploy AI card: shows lock state when sentinel inactive
- [ ] cron_handoff_brief: create a test appointment 7 min from now → verify SMS/email received

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
