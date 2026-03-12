# GetSalesCloser — Full Session History

> Archive of all completed work, migrations, bug fixes, and session notes.
> For current project state, see `/CLAUDE.md`.

---

## Revenue Doctor — Session 9 (2026-03-12) — Enterprise Team Intelligence

**New file:** `_shared/team_attention.ts`
- Per-agent rollup from `leads.assigned_to` + `interactions.user_id` (2 targeted parallel queries)
- 6 flag types per lead per agent: `slow_response` (>4h after inbound), `no_response`, `high_intent_loss`, `pricing_leak`, `booking_weakness`, `one_sided` (≥3 agent msgs, ≤1 lead reply)
- Priority score = `25*slow + 20*no_response + 20*high_intent + 15*pricing + 10*booking + 10*one_sided + min(10, leads/2)`
- Buckets: `immediate_attention` (≥60), `coaching` (35-59), `top_performer` (<35 + deals>0), `insufficient_data` (<10 leads or <5 convs)
- Returns `TeamAttentionResult` with bucketed arrays + `windowSummary`

**`doctor_payload_builder.ts`:** Added `teamAttention?: TeamAttentionResult` to `DiagnosticPayload`. `buildDiagnosticPayload` new optional params: `leads?`, `isEnterprise?`, `memberMap?`. `buildTeamAttention` runs concurrently with `buildConversationIntelligence` in `Promise.all`.

**`revenue-doctor-generate/index.ts`:**
- Fetches `organizations.org_type` in parallel with membership check (step 3)
- Enterprise: fetches `org_members WHERE role='enterprise_agent'` + `profiles(full_name, email)` → builds `memberMap`
- `ReportContent` extended with optional `team_overview`, `users_requiring_attention`, `coaching_priorities`
- `buildTeamPromptSection()` appended to LLM prompt when `p.teamAttention` present — includes structured flag data + exact JSON schema instructions for 3 new keys

**`revenue_doctor.html`:** Three new render functions (`renderTeamOverview`, `renderUsersRequiringAttention`, `renderCoachingPriorities`). Three conditional sections after Expected Revenue Impact — emit `''` when keys absent (backward compatible with old reports).

**Verified (runtime):** Enterprise org `53298e00` generated report `8cff918d` — `has_team_overview=true`, `has_users_requiring_attention=true`, `has_coaching_priorities=true`. Prior report `b3de1c30` (pre-RD9) — all three `false`. Zero DB schema changes.

---

## Revenue Doctor — Session 8 (2026-03-11) — Monetization Polish

**Buy More Reports flow:**
- `create-credit-topup-order`: added `doctor_report` token key; fixed SKUs (not unit pricing): `DOCTOR_REPORT_BUNDLES = {5:79, 10:149, 20:249}`; bundle validation + `unit_amount = bundle_price / qty`
- `fulfill-paid-order`: after `credit_wallet_add_v1`, calls `grant_tokens_core_v1(scope='org')` for `doctor_report` to sync `token_wallets` (runtime layer — what `consume_tokens_v1` reads)
- `revenue_doctor.html` `#buy-modal`: 3 bundle cards (5/$79, 10/$149 POPULAR, 20/$249 BEST VALUE); `openBuyModal/closeBuyModal/selectBundle/purchaseBundle()`; `#buy-reports-btn` in navbar when quota=0; error state CTA in generate modal

**Info modal (`#info-modal`):** 3-section static content explaining what Revenue Doctor does; `?` button in navbar

**Staged loading UX:** 4 stages with named indicators (`#stage-0` to `#stage-3`); progress bar `#gen-progress`; `startStageProgress/stopStageProgress/updateStageUI()` advancing on 9s intervals (5%→20%→45%→65%→85%)

**Share link:** `history.replaceState(null,'','?report='+reportId)` on `selectReport()`; boot reads `new URLSearchParams(location.search).get('report')` to auto-load; `copyShareLink()` with clipboard + 2s label feedback

**Export:** `exportMarkdown()` builds full `.md` from `_currentReport`; `exportPdf()` calls `window.print()`; `no-print` CSS class hides all nav/header buttons from PDF

**Age indicator:** In `loadDashRevenueDoctor()` and `entLoadRevenueDoctor()`: `daysAgo` computed from `last.generated_at`; `ageLabel` = "Today/Yesterday/N days ago"; stale warning (yellow triangle) when `daysAgo > 14`

---

## Revenue Doctor — Sessions 1–7 (2026-03-10) — Foundation Through Hardening

**Sessions 1–3 (DB + Adapters + Scorer):**
- Tables: `revenue_doctor_reports` (full report store), `doctor_report_metrics` (flat metrics for trending), `token_wallets` (runtime quota), `token_ledger`
- `_shared/revenue_adapters.ts`: `fetchLeadFacts`, `fetchConversationFacts`, `fetchChannelFacts`, `fetchFunnelFacts`, `fetchCampaignFacts`; `buildDateWindow()`; all org-scoped; safety caps (5k/10k rows)
- `_shared/health_scorer.ts`: `scoreLeadResponse`, `scoreConversationQuality`, `scoreChannelHealth`, `scoreConversionHealth`, `computeOverallScore`, `generateWarnings`; prev-period delta support
- `_shared/doctor_payload_builder.ts`: intelligent sampling (3-tier: questions/drop-off/other); GPT-4o-mini conversation classification (7 objections, 7 intents); funnel + automation insights; PII-scrubbed evidence samples; `buildDiagnosticPayload()`
- `_shared/pii_scrubber.ts`: regex scrub for phone/email/name patterns; `truncateExcerpt()`

**Sessions 4–5 (Edge Functions + Viewer):**
- `revenue-doctor-generate`: auth → membership → entitlement (voice service) → quota → rate limit → credit consume → 5 adapters parallel → scorer → payload builder → GPT-4o prompt → persist
- `revenue-doctor-reports`: list + fetch saved reports by org
- `revenue_doctor.html`: full-page viewer; report list sidebar; generate modal; health snapshot bars; 9-section report renderer

**Session 6 (Dashboard Integration):**
- `dashboard.html`: Revenue Doctor card — last report summary, score, generate button, quota badge; `loadDashRevenueDoctor()`
- `enterprise_admin.html`: same card; `entLoadRevenueDoctor()`

**Session 7 (Hardening):**
- 40s `AbortController` timeout on OpenAI fetch; refund + 504 on `AbortError`
- `request_id = crypto.randomUUID()` at handler start; included in all logs + report row
- `generation_duration_ms` tracked from before LLM loop to after
- Rate limit: count `revenue_doctor_reports WHERE generated_at > NOW()-60s`; 429 if ≥3
- `validateReportContent()`: checks 8 required sections; `MAX_LLM_ATTEMPTS=2` retry loop; refund + 422 if both invalid
- `refresh_doctor_report_credits()` SQL function: writes to BOTH `credit_wallets` (display) AND `token_wallets` (runtime); idempotency via `idempotency_key` TEXT; pg_cron #17 `5 0 1 * *`
- Token allotment: enterprise (`org_type='enterprise'`) = 999, voice plan = 10

---

## Session 27 — 2026-03-10 (Bug Fixes + E2E Final)

**Bug fixes:**
- `executor_whatsapp`: switched from `brain.ts` → `widget_inbound` logic (same as Messenger); added outbound interaction logging
- `webhook_inbound`: `whatsapp_status` events now call `markWebhookProcessed()` — no more stuck pending events
- `admin.html`: `getAdminToken()` reads fresh JWT from `localStorage` on every call — fixes expiry after 1h
- `enterprise_admin.html` + `agency_admin.html`: agent invite reads fresh JWT from `localStorage`
- `agency_admin.html`: removed non-existent `org_members.created_at` column from Client Users query
- `admin.html` Channel Sender Management: removed non-existent `org_channels.provider_id`; reads `metadata.page_id` for Messenger

**Facebook Page OAuth:**
- `connect-facebook-page` edge function + `fb-callback.html`
- "Facebook Page" card added to all 3 portals; OAuth flow stores `provider_token` + `metadata.page_id` in `org_channels`

**Test data fix:** Test lead phone corrected `+16391055535` → `+916391055535` (India format for WhatsApp)

**E2E status at session end:** Groups H/E/G/I/J ✅ complete. Groups A/B/C/F ⚠️ blocked on Twilio USA number.

---

## Session 26 — 2026-03-10 (E2E Testing G3–H3)

**G4 — WhatsApp inbound pipeline (4 bugs fixed):**
1. `webhook_inbound`: Twilio signature validation used `x-forwarded-host` → fixed using `SUPABASE_URL` env var
2. `webhook_inbound`: `actor_user_id` + `plan_id` never resolved before `replyRouter` → tasks silently dropped; fixed by parallel-resolving from `org_members` + `decision_plans`
3. `reply_router.ts`: `replyChannel` hardcoded to `"sms"` for all intents → fixed with channel-aware variable
4. `executor_whatsapp`: `StatusCallback` URL unset → Twilio 21609; fixed by appending `SUPABASE_URL`-based URL

**Supabase JS v2 fix:** `.catch()` not a function on `PostgrestBuilder` → global replace `.catch(()=>{})` → `.then(undefined, ()=>{})`

**Latency fixes:**
- Instant dispatch trigger: `on_execution_task_insert` AFTER INSERT → `net.http_post` to `execution-dispatcher`; worst-case latency 63s → ~5s
- `executor_voice`: parallelized 4 startup checks + brain context fetches (~500ms saved)
- `brain.ts buildContext` + `generateMessage`: all DB queries parallel via `Promise.all` (~400ms saved)

**H — Facebook Messenger setup (from scratch):**
- `org_channel_provider` ENUM: added `meta`; `org_channels` row inserted with `provider_token`, `metadata.page_id`
- `org_channel_capabilities`: `messenger_enabled=true`, `messenger_page_id` set
- Facebook App: Live mode + page subscription (`POST /{page_id}/subscribed_apps`); message/deliveries/reads fields
- `leads.messenger_psid` linked to test lead; 4 duplicate test leads DNC'd

**`executor_messenger` bugs fixed (3 rounds):**
- `generateMessage` wrong param names → correct `BrainParams`; wrong return field `.message` → `.content`
- `consume_tokens_v1`: missing `p_scope`/`p_user_id`; `p_quantity` → `p_amount`
- `grant_tokens_core_v1`: missing `p_scope`/`p_user_id`; `p_quantity` → `p_amount`; `p_note` → `p_metadata`

**AI quality fixes:**
- `executor_messenger` + `executor_sms`: load latest inbound interaction as `user_query`; use `task.metadata.intent_trace` as intent
- `brain.ts buildContext`: load last 8 turns (both inbound+outbound); format as `User:`/`You:` turns
- `brain.ts generateMessage`: detect `hasOutbound` → inject "do NOT re-introduce yourself" instruction
- Both executors: write outbound interaction after successful send

---

## Session 25 — 2026-03-09 (Cancel Flow Fixes + Data Deletion)

**Cancel flow fixes:**
- `initiate-cancellation` + `confirm-cancellation` redeployed with `--no-verify-jwt`
- Cancellation email: `billing@` → `support@getsalescloser.com`; moved before `execute-refund` to prevent Razorpay latency blocking delivery
- Number purchase always excluded from refund (Twilio non-refundable); `numberRefund` logic removed
- Currency fixed to USD (`$` / `en-US`) throughout `cancel.html`
- Step 3 mode-aware: immediate → 45s countdown → `index.html`; end-of-term → dashboard button
- All error messages now show actual server error (not generic fallback)

**New feature — Delete My Data:**
- `export-and-delete-org-data` edge function: exports leads+interactions+appointments as CSV attachments (Resend); deletes all org data
- `cancel.html` step 3: "Delete My Data" button → confirmation popup → calls function
- Immediate: CSV sent + deleted now. End of term: CSV sent now, deletion at `service_ends_at`
- DB: `data_deletion_requested TIMESTAMPTZ` + `data_deletion_processed_at TIMESTAMPTZ` on `subscription_cancellations`
- pg_cron #16 (`scheduled-data-deletions`, daily 2am UTC): `process_scheduled_data_deletions()` fires for end-of-term orgs past end date

**Payment recovery:**
- `payment.html` now stores `razorpay_payment_id` in `payment_attempts.provider_ref`
- `recover-payment` edge function live: `success.html` auto-recovers on timeout — no more manual intervention
- Dynamic pricing on `number_request_checkout.html`: SMS-only=$90, Voice-only=$90, Both=$110

**E2E verified (D1, D2, D3, E1):** Credit top-up, low balance alert, number purchase, cancel immediate all confirmed working.

---

## Sessions 22–24 — 2026-03-08 (Institutional-Grade Hardening)

### Step 1 — Platform Kill Switch ✅
- `platform_control_flags` table (7 rows seeded); `enforcePlatformKillSwitchFor*` in `security.ts`
- 3-layer enforcement: `campaign_ticker` + `execution-dispatcher` + all 6 executors
- `admin.html` P10 panel: toggle + mandatory reason + audit trail
- Audit: `platform_flag_enabled` / `platform_flag_disabled`

### Step 2 — Global Rate Limiter ✅
- `rate_limit_buckets` table + indexes; `check_and_increment_rate_limit_v1` atomic dual-scope RPC
- `RATE_LIMIT_DEFAULTS`: sms 30/1000, voice 5/50, email/wa/rcs/messenger 30/500
- Enforced in all 6 executors BEFORE token consumption; rate-limited → reschedule 60s (NOT terminal)
- `admin.html` P11 monitor panel; fail-open on RPC error; audit: `rate_limit_blocked_org`, `rate_limit_blocked_platform`

### Step 3 — Dead-Letter Queue ✅
- `execution_dead_letters` table; `execution_policy_v1`: `MAX_ATTEMPTS_EXCEEDED` → `dead_lettered`
- Dispatcher inserts DLQ snapshot; original task preserved at `status='dead_lettered'`
- `admin.html` P12: Inspect modal / Retry (creates fresh task, attempt=0) / Cancel / "Show resolved" toggle
- Audit: `execution_dead_lettered`, `execution_dead_letter_retry_requested`, `execution_dead_letter_cancelled`

### Step 4 — Provider Webhook Event Store ✅
- `provider_webhook_events` table; UNIQUE on `(provider, provider_event_id)`
- `persistWebhookEvent` / `markWebhookProcessed` / `markWebhookFailed` helpers in `webhook_inbound`
- 7 event types: `sms_inbound`, `whatsapp_inbound`, `whatsapp_status` (Twilio), `vapi_end_of_call`, `vapi_transcript` (VAPI), `rbm_inbound`, `rbm_delivery_receipt` (RBM), `messenger_inbound` (Facebook)
- `already_processed=true` gate → return 200 immediately (prevents double token settlement)
- `webhook_inbound` now requires `--no-verify-jwt` (was missing — caused Facebook GET 401)
- `admin.html` P13: provider/status/time filters + summary counts + Inspect modal

### Step 5 — Channel Health Monitor ✅
- `channel_health_current` (single table; `org_id IS NULL` = platform row)
- Two partial unique indexes: `(org_id, channel) WHERE org_id IS NOT NULL` and `(channel) WHERE org_id IS NULL`
- `compute_channel_health_v1()` PL/pgSQL UPSERT from `delivery_attempts` over last 1h; pg_cron #14 every 5min
- Thresholds: excellent(<1%), normal(<3%), elevated(<7%), degraded(≥7%), unknown(no data)
- Dashboard: "Channel Health" card reads from table (canonical badge); old client-computed badge removed
- `admin.html` P14: platform-level table + degraded/elevated orgs breakdown

### Step 6 — Idempotency Guard for Executors ✅
- `UNIQUE INDEX delivery_attempts_task_attempt_uidx ON delivery_attempts (task_id, attempt_number) WHERE task_id IS NOT NULL`
- All 6 executors: pre-send INSERT with `attempt_number: task.attempt ?? 1`; on 23505 unique_violation → skip (return 200)
- `executor_sms` + `executor_email` + `executor_voice`: `delivery_attempts` added for first time (tracking + idempotency)

---

## Sessions 20–21 — 2026-03-07 (Credits, Multi-Channel, Cancellation)

### Credit Substrate (Session 20)
- **Tables:** `credit_wallets`, `credit_ledger`, `credit_alert_state`, `orders`, `order_lines`, `idempotency_keys`, `audit_events`, `usage_rating_events`, `usage_settlements`
- **RPCs:** `credit_wallet_add_v1` (atomic increment), `run_wallet_ledger_reconciliation()` (drift detection), `consume_tokens_v1`, `grant_tokens_core_v1`
- **`credits.js`** shared module: `initCreditWallet`, `showTopupModal`, wallet card, low-balance flash banner; `Credits.refresh()` + `visibilitychange` listener
- Token pricing (frozen): voice_min=$0.20/min (alert<10), sms_msg=$0.01 (alert<100), ai_credit=$0.01/30 (alert<5000), wa_msg=$0.01 (alert<100)

### Personalized Number ($110 bundle, Session 20)
- `create-number-purchase-order`: 4 order lines (number_fee, setup_fee, credit_voice, credit_sms); `intent_source='number_purchase'`
- `fulfill-number-request`: idempotent; amount integrity check; grants voice_min+sms_msg via ledger; creates `org_channel_provision_requests(status='payment_received')`; emails admin
- `admin.html` Provisioning Queue: lists requests; Provision modal → `org_channels_purchase`; marks `succeeded`
- `executor_sms` + `executor_voice`: per-org FROM number/VAPI phone_number_id lookup from `org_channels`

### Cancel Subscription (Session 20)
- **Tables:** `subscription_contracts` (backfilled, 2 real + 6 ambiguous), `cancellation_feedback`, `refund_quotes`, `subscription_cancellations`, `refund_executions`
- **Organizations columns:** `cancellation_status`, `service_ends_at`
- **RPC:** `is_org_cancelled_v1(p_org_id UUID) RETURNS BOOLEAN`
- **Edge functions:** `initiate-cancellation`, `confirm-cancellation`, `execute-refund`
- **3-layer enforcement:** `campaign_ticker` + `execution-dispatcher` + all executors
- **`cancel.html`:** 3-step: feedback → refund preview → confirm; modes: immediate (45s countdown → index.html) / end_of_term (dashboard button)
- Refund exclusions (frozen): top-ups always excluded; number purchase always excluded (Twilio non-refundable)

### WhatsApp (Session 20)
- Tables: `org_channel_capabilities`, `message_routing_policies`, `delivery_attempts` (all seeded)
- `executor_whatsapp`: capability gate → `whatsapp_fallback_to_sms` policy; `delivery_attempts` logging; token key `wa_msg`
- `webhook_inbound`: WA status callback → `delivery_attempts`; WA inbound → `interactions(type='whatsapp')` + `replyRouter`
- `platform_channels(twilio, whatsapp, +14155238886)` inserted for shared WA inbound routing

### RCS / Google RBM (Session 20)
- `executor_rcs`: Google RBM Business Communications API; Google SA → OAuth2 JWT via WebCrypto; device capability fallback to SMS on 403/404; token key `rcs_msg`
- `webhook_inbound google_rbm`: Pub/Sub push envelope; `agentEvent` → delivery_attempts; `userEvent` → replyRouter

### Facebook Messenger (Session 20)
- `executor_messenger`: Graph API v21.0; per-org `org_channels.provider_token`; PSID guard; 24h window → SMS fallback; terminal 551/190
- `webhook_inbound facebook_messenger`: GET hub challenge; POST X-Hub-Signature-256; watermark receipts; PSID inbound routing

### Routing Hardening (Session 20)
- `org_channels.fallback_policy` TEXT DEFAULT 'allow_shared' (allow_shared / fail_task / admin_override)
- 3-step outbound resolution in all executors: active is_default → fallback_policy → shared/fail/admin
- Resolution BEFORE token consumption — `fail_task` never wastes a token
- `tests/channel-routing-tests.sql`: 5 regression tests

### Session 21 — Delivery Status, PSID Auto-Link, Channel Infrastructure
- Delivery Status: `_buildDeliveryHTML` covers 5 channels + health badge (Excellent/Normal/Elevated/Degraded); all 3 portals
- PSID auto-link: inbound Messenger → resolve org from page_id → single unlinked lead → `UPDATE leads.messenger_psid`; audit: `messenger_psid_linked/ambiguous/no_match`
- Channel Infrastructure card: dedicated vs shared badge per channel; `_buildInfraHTML` helper; all 3 portals
- `admin.html`: Channel Sender Management + Health + Toggle columns; new Channel Fallback Events panel
- `message_threads` table: UNIQUE on `(from_identifier, to_identifier, channel)`; thread-first lookup in SMS/WA inbound path

---

## Session 19 — 2026-03-06 (Sprint 6)

- `api_keys` table: `generate_api_key()` function; UI in all 3 dashboards; `last_used_at` updated by `hook_inbound`
- API key audit: `audit_events` table; hook_inbound logs each call with org_id + lead outcome
- Growth Intelligence card: `dashboard.html` + `agency_admin.html` + `enterprise_admin.html`; `generate-upsell-insight` edge function
- `send-welcome-email` edge function: Welcome email (Resend, `hello@getsalescloser.com`); called from `dashboard.html` on `onboarding_completed` transition
- Email address convention established: hello@/support@/billing@
- PDF pipeline: `knowledge_brain` edge function updated to handle `.pdf` uploads; `documents` Storage bucket created
- Service activation fix: `org_services` INSERT on `approve_agency_enterprise_deal` + `fulfill-paid-order`

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
