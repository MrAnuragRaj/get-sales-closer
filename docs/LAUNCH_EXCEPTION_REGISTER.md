# Launch Exception Register
> GetSalesCloser — Pre-Launch Accepted Risks
> Date: 2026-04-02 (updated 2026-04-02 Session 35) | Status: APPROVED FOR LAUNCH

Each entry: accepted risk, why it is operationally manageable, and what milestone resolves it.

---

## EX-01 — SMS / WhatsApp DNC Enforcement Relies on SQL Gate Only (Pre-2026-04-02)

**Status:** RESOLVED in this session. `is_lead_terminal` application-layer check now added to both channels.

---

## EX-02 — Voice Call Settlement Is Asynchronous (No conversation_state update at task completion)

**Accepted gap:** `executor_voice` does not call `updateConversationState` at task completion. Voice delivery is asynchronous — the call outcome (intent, content) only becomes available via the VAPI webhook (`webhook_inbound`) after the call ends.

**Why acceptable:** The conversation state write for voice correctly happens in `webhook_inbound` after call completion with real intent data. Writing state at call initiation would use incorrect/assumed intent.

**Monitoring:** `voice_calls` table + VAPI dashboard provide call outcome. Webhook processing logs provide intent confirmation.

**Resolution milestone:** Group A/Voice E2E tests (Session GE) — verify webhook_inbound correctly updates conversation_state post-call.

---

## EX-03 — No Top-Level Unhandled Exception Handler in 5/6 Executors

**Accepted gap:** Only `executor_sms` has a top-level try/catch that writes `UNHANDLED_EXECUTOR_CRASH` to `last_error`. The other 5 executors (email, voice, whatsapp, rcs, messenger) would return HTTP 500 without writing to `last_error` on an unexpected runtime error (e.g. Deno API throw, JS engine error).

**Why acceptable:** The `task_sweeper` treats any non-200 response from an executor as a failure and applies exponential backoff + dead-letter. The task will not be silently lost. `last_error` would be null until the next attempt sets it. Operational impact: one retry cycle before the error is visible.

**Resolution milestone:** Add `runExecutor()` pattern to all 5 remaining executors in the next hardening sprint.

---

## EX-04 — WhatsApp / Messenger conversation_state Update Happens Inside widget_inbound

**Accepted gap:** `executor_whatsapp` and `executor_messenger` delegate AI generation to `widget_inbound`. The `updateConversationState` call happens inside `widget_inbound` (for inbound sessions) but the outbound task dispatch path may not trigger it in all cases.

**Why acceptable:** For outbound AI-generated messages, `widget_inbound` processes the last inbound message and returns a reply — it runs its own intent detection and state update internally. The memory fields that matter (`stage`, `last_intent`) are primarily driven by inbound messages, not outbound sends.

**Monitoring:** Run observability query 8c (stale conversation_state) after WhatsApp/Messenger sends in Group G and H E2E tests.

**Resolution milestone:** Group G (WhatsApp) and H (Messenger) E2E re-verification after conversation_state consistency work.

---

## EX-05 — RCS Token API Was Using Wrong Params (Pre-2026-04-02)

**Status:** RESOLVED in this session. All `grant_tokens_core_v1` refund calls in `executor_rcs` have been corrected (`p_quantity`→`p_amount`, `p_note`→`p_metadata`). The `consume_tokens_v1` call has been corrected (`p_quantity`→`p_amount`, added `p_scope`, `p_user_id`).

**Impact was:** RCS token refunds were silently failing. All 5 refund paths (missing config, auth failure, network error, capability failure, RBM API error) were calling the RPC with wrong param names, causing the RPC to silently no-op. Tokens were being lost on every RCS failure. Consume call was also malformed — RCS token billing was broken.

**Resolution milestone:** RCS E2E test (part of Group A when Twilio number arrives) — verify token balance changes correctly on send + failure.

---

## EX-06 — RCS generateMessage Was Using Wrong API (Pre-2026-04-02)

**Status:** RESOLVED in this session. `executor_rcs` was calling `generateMessage` with `{orgId, leadId, actorUserId, planId}` and accessing `brainResult.message`. The correct API is `{task_id, org_id, lead, channel, intent, user_query}` with `brainResult.content`. AI generation for RCS was likely returning errors silently.

---

## EX-07 — Orphaned delivery_attempts Require Sweeper to Recover

**Accepted gap:** If an executor crashes between inserting a `delivery_attempt` (status='pending') and updating it to 'sent'/'failed', the row can be orphaned in 'pending' state indefinitely. The task_sweeper now runs `recoverOrphanedDeliveryAttempts()` every cycle to detect and resolve these.

**Why acceptable:** The recovery runs every minute (sweeper pg_cron frequency) with a 10-minute threshold. Maximum exposure window is 11 minutes. No message is lost — the orphan is detected, marked 'failed', and the task can retry normally.

**Monitoring:** Observability query 8f detects orphans in real time.

**Resolution milestone:** No specific milestone — the sweeper recovery is the permanent mechanism.

---

## EX-08 — Growth Engine Auto-Posting Off by Default, Engagement Fully Disabled

**Accepted state (intentional):** `AUTO_POSTING_ENABLED=False`, `ENGAGEMENT_EXECUTION_ENABLED=False` in `launch_flags.py`. Content pipeline runs in approval/suggestion_only mode. No autonomous public posting or engagement actions can occur.

**What this means:** Growth Engine in Beta delivers content suggestions and requires human approval before any post goes live. Zero risk of unintended public actions.

**Resolution milestone:** After full end-to-end Growth Engine testing (Group GE), flip `AUTO_POSTING_ENABLED=True` only for orgs explicitly opted into auto mode via `org_growth_settings.posting_mode='auto'`.

---

## EX-09 — Twilio USA Number Pending Approval (Groups A/B/C/F Blocked)

**Accepted gap:** SMS, Widget, Email, and Automation E2E groups cannot be tested until Twilio approves the US number. Core pipeline logic is implemented and audited.

**Why acceptable:** All executor guard logic, token flows, delivery_attempt idempotency, and DNC enforcement are in place. The blocker is external regulatory approval, not a code deficiency.

**Resolution milestone:** Upon Twilio US number approval — run Groups A→B→C→F in sequence.

---

## EX-10 — voice_call_initiated_but_link_failed (Pre-2026-04-02)

**Status:** RESOLVED in Session 35. Previously: task was failed and token was refunded when `provider_id` link failed despite a real VAPI call — this would have caused duplicate calls on retry + incorrect refund.

**Fix applied:** When `callId` exists but DB link fails, `executor_voice` now marks the task `succeeded` (no refund, no retry). The `link_failed: true` flag is written to task metadata for ops visibility. Token debit stands because the call was real.

**Monitoring:** Search logs for `event: "voice_call_initiated_but_link_failed"` after any voice campaign.

---

## EX-11 — Session 35 Critical Blocker Batch (Pre-2026-04-02)

**Status:** ALL RESOLVED in Session 35. The following critical items were fixed:

1. **decision_engine race condition** — DB UNIQUE constraint on `(lead_id, trigger)` applied; INSERT-first pattern replaces read-then-insert.
2. **delivery_attempt non-23505 abort** — All 6 executors now abort and refund if delivery_attempt INSERT fails for any reason other than 23505.
3. **Messenger DNC bypass** — `is_lead_terminal` guard added to `executor_messenger` (was the only executor missing it).
4. **Dispatcher blind 2xx trust** — Dispatcher now verifies `delivery_attempts.status='sent'` before marking task succeeded.
5. **task_sweeper missing channels** — WhatsApp, RCS, Messenger routing added to `executorUrl()`.
6. **SMS/Email config validation order** — Twilio credentials and Resend API key checks moved before token debit.
7. **Voice partial success contradiction** — Link failure with real `call_id` now marks succeeded (not failed+refund).
8. **WhatsApp refund params** — Both refund calls corrected: added `p_scope`, `p_user_id`, replaced `p_reason` with `p_metadata`.
9. **RCS ai_generation_locked permanent fail** — Changed to 60s backoff (`status='pending'`, `scheduled_for=+60s`).
10. **Memory corruption via outbound text** — All executor `updateConversationState` calls now pass `""` as content, preventing `extractFacts()` from analyzing AI-generated outbound messages.
