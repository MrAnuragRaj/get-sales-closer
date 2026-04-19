# GetSalesCloser — Technical Audit
> Generated: 2026-04-02 | Scope: Execution Pipeline · Status Fields · Memory · Prompts · RPCs · Growth Engine

---

## Section 1 — Execution Pipeline Reliability

### Pipeline Stages
`webhook_inbound / hook_inbound → decision_engine → execution_planner → execution-dispatcher → executors → task_sweeper`

---

### 1.1 Silent Failures and Stuck Tasks

**webhook_inbound / hook_inbound**

- `hook_inbound/index.ts` — `last_used_at` update for API key is fire-and-forget: `.then(() => {})`. If this fails, API key usage tracking silently drifts. Not a flow-blocking issue but hides abuse patterns.

**decision_engine**

- `decision_engine/index.ts:24` — Returns a hardcoded plan (single SMS channel). No idempotency guard. If the function is called twice for the same inbound event (e.g. webhook retry), two `decision_plans` are created for the same lead, which causes `execution_planner` to expand tasks twice → double execution. Fix: insert decision_plan with `ON CONFLICT (lead_id, created_at_bucket)` or check for existing plan before inserting.

**execution_planner**

- `execution_planner/index.ts:59–77` — Expands tasks using retry offset schedule without validating that the channel is supported for the org. Tasks for unsupported channels are created, dispatched, and then immediately dead-lettered by the executor after consuming a token check. Fix: validate channel capability before task creation.

**execution-dispatcher**

- `execution-dispatcher/index.ts:400–407` — Unknown channel (e.g. typo) causes immediate `failed_permanent` with no alerting. The task is silently lost. Fix: log alert + emit an `audit_event` before marking permanent.
- `execution-dispatcher/index.ts` — No abort controller / timeout for the executor invocation itself beyond the 15 s `EXECUTOR_TIMEOUT_MS` constant. If the executor hangs (e.g. Twilio API stall), the dispatcher waits 15 s then marks the task failed. But the executor itself may still be running in the background completing the send. Risk: double-send if executor finishes after dispatcher has already rescheduled a retry.

**executor_voice**

- `executor_voice/index.ts:250–255` — Idempotency check verifies `provider_id IS NOT NULL` but does not confirm the VAPI call is still alive. If VAPI cancelled or expired the call mid-flight, executor returns 200 success. The task is marked `succeeded` but no call was made.
- `executor_voice/index.ts:527–531` — Race on provider_id link: `.or('provider_id.is.null,provider_id.eq.${callId}')`. If another concurrent worker already wrote a different `callId`, the update silently no-ops. The task appears to succeed but is permanently orphaned from the VAPI call. No retry or alert triggered.
- No delivery_attempt row is written for voice tasks. All other executors use `delivery_attempts` for idempotency (23505 guard). Voice has no equivalent. A crashed executor that restarted mid-task will issue a second VAPI call with no guard.

**executor_messenger**

- `executor_messenger/index.ts:477–483` — On network error: increments attempt counter but releases lock without verifying `locked_by = worker_id`. Another worker that has since leased the task is now at risk of double-executing from an incorrect attempt counter.

**executor_rcs**

- `executor_rcs/index.ts:572–581` — Computes `nextStatus` from error category but does not differentiate permanent vs retryable provider errors before incrementing the attempt counter. Permanent 4xx errors consume all retry slots unnecessarily.

**task_sweeper**

- `task_sweeper/index.ts:70–76` — On dispatch error the sweeper logs `console.error` and continues to the next task. There is no backoff or circuit breaker. If a systemic error hits (e.g. executor cold-start timeout), all tasks in the batch fail silently, are re-queued, and the same loop repeats.

---

### 1.2 Missing Timeout Logic

| Location | Issue |
|---|---|
| All executors | `consume_tokens_v1` RPC call has no abort signal / timeout. Hangs indefinitely if DB is slow. |
| `executor_sms/email/whatsapp/rcs/messenger` | External provider API calls (Twilio, Resend, RBM, Graph) have no application-level timeout — rely only on provider defaults. |
| `voice_turn/index.ts:161–164` | OpenAI timeout is 8 s. GPT-4o-mini with a full context window can easily exceed this. Tight against VAPI 20 s tool timeout; any slow day causes voice turn to drop. |
| `execution-dispatcher` | 15 s executor timeout is too short for voice executor which fetches 15 turns of history before calling VAPI. |

---

### 1.3 Idempotency Gaps

| Location | Status |
|---|---|
| `executor_sms/email/whatsapp/rcs/messenger` | Correctly use `UNIQUE(task_id, attempt_number)` on `delivery_attempts`; 23505 returns 200 idempotently. ✅ |
| `executor_voice` | No delivery_attempt row written. No 23505 guard. Double-call risk on retry. ❌ |
| `decision_engine` | No guard against duplicate plan creation for same inbound event. ❌ |
| `widget_inbound:337–356` | Writes to interactions without checking for duplicate from retried request. ❌ |
| `hook_inbound` | Inbound CRM events have no dedup check by external event ID. ❌ |

---

### 1.4 Race Conditions / Double-Send Risks

1. **executor_voice provider_id race** — Two workers leasing the same task (clock skew on `locked_until`) each initiate VAPI calls. Both succeed. Both try to write `provider_id`. One write wins; the other call is orphaned and never terminated.
2. **decision_engine duplicate plans** — Webhook retry within the same second creates two plans; planner expands both; two task sets dispatched for the same lead.
3. **executor_messenger attempt counter race** — Concurrent lock release without `WHERE locked_by = worker_id` guard allows a new worker to see an inflated attempt count and skip retry.

---

### 1.5 Concrete Fixes

| Fix | Location | Action |
|---|---|---|
| Voice idempotency | `executor_voice` | Insert delivery_attempt row before VAPI call; catch 23505 and return 200 |
| voice provider_id race | `executor_voice:527–531` | Add `WHERE status='running' AND locked_by='<worker_id>' AND provider_id IS NULL` to the UPDATE |
| Token RPC timeout | All executors | Wrap `consume_tokens_v1` with `AbortController` + 8 s timeout; fail closed (mark `paused_insufficient_funds`) |
| decision_engine dedup | `decision_engine` | Insert decision_plan with `ON CONFLICT (lead_id) DO NOTHING`; check rowcount before proceeding |
| task_sweeper backoff | `task_sweeper:70–76` | Track consecutive failures per task; if same task fails 3 sweeps in a row, dead-letter it |
| Executor timeout | `execution-dispatcher` | Raise `EXECUTOR_TIMEOUT_MS` to 30 000 ms; add per-channel timeout config |
| OpenAI voice timeout | `voice_turn:161–164` | Raise to 12 s; add streaming fallback if response is incomplete at 10 s |

---

## Section 2 — Status Field Audit

### 2.1 All Status Values in Use

**execution_tasks.status**
`pending` · `running` · `succeeded` · `failed` · `paused_insufficient_funds` · `failed_permanent` · `skipped_terminal` · `dead_lettered` · `blocked` · `failed_security_policy` · `blocked_billing_lock`

**delivery_attempts.status**
`pending` · `sent` · `failed`

**conversation_state.stage**
`outreach` · `engaged` · `qualified` · `meeting_requested` · `callback_requested` · `booked` · `closed` · `dnc`

**growth — publish_queue.status**
`pending` · `locked` · `published` · `failed` · `blocked_approval` · `blocked_auth` · `cancelled`

**growth — content_variants.status**
`draft` · `approved` · `queued` · `published` · `failed` · `rejected` · `needs_review` *(referenced in approval_engine.py:214, 560 but never explicitly set)*

---

### 2.2 Inconsistencies and Mismatches

**execution_tasks vs delivery_attempts decoupled**
`executor_sms:386–397`: Twilio returns 200 OK but body parse fails → `delivery_attempts.status = 'failed'` while `execution_tasks.status = 'succeeded'`. Reporting shows "task succeeded" but message was not delivered. These two status fields are never reconciled.

**delivery_attempts "sent" is not final delivery**
"sent" means the provider API accepted the payload, not that the recipient received it. There is no `delivered` or `read` status. Dashboards that display "sent" imply higher confidence than the data supports.

**conversation_state.stage not synchronised with DNC events**
`voice_turn:422–454` calls `apply_lead_halt_and_cancel` but does NOT update `conversation_state.stage` to `dnc`. The stage stays `engaged` even after the lead is halted. Any future inbound message triggers re-engagement instead of a graceful rejection.

**growth variant "needs_review" is orphaned**
`approval_engine.py:214, 560` checks `status NOT IN ('published', 'needs_review', 'rejected')` but no code path ever writes `needs_review` to the database. Rows can never be in this state, making the guard dead code — but if a manual DB edit writes it, it will silently block re-processing.

**execution_tasks has no explicit "failed_retryable" status**
Tasks that fail transiently are kept in `failed` with `attempt < max_attempts` and rescheduled by the sweeper. But the status label `failed` is shared between "will retry" and "give up" states. Consumers that read `failed` cannot distinguish the two.

---

### 2.3 Unenforced Transitions

No DB-level constraint enforces the execution_tasks state machine. The following invalid transitions are possible:
- `succeeded → pending` (re-queue a completed task)
- `pending → succeeded` (bypass running/lock phase)
- `dead_lettered → running` (resurrect without explicit admin action)
- `failed_permanent → running` (same)

The growth variant table has the same issue — no transition guard beyond application-layer checks.

---

### 2.4 Proposed Unified Status Model

```typescript
// execution_tasks — lifecycle
enum TaskStatus {
  PENDING           = 'pending',           // created, awaiting lease
  RUNNING           = 'running',           // leased by worker
  SUCCEEDED         = 'succeeded',         // provider accepted
  FAILED_RETRYABLE  = 'failed_retryable',  // transient; will retry
  FAILED_PERMANENT  = 'failed_permanent',  // no retry
  BLOCKED_SECURITY  = 'blocked_security',  // security gate
  BLOCKED_BILLING   = 'blocked_billing',   // insufficient balance
  SKIPPED_TERMINAL  = 'skipped_terminal',  // lead DNC / cancelled
  DEAD_LETTERED     = 'dead_lettered',     // exceeded max_attempts
}

// delivery_attempts — provider-level
enum DeliveryStatus {
  PENDING           = 'pending',           // queued, not yet sent
  SENT              = 'sent',              // provider API accepted
  DELIVERED         = 'delivered',         // provider confirmed delivery
  FAILED_TRANSIENT  = 'failed_transient',  // retryable at provider
  FAILED_PERMANENT  = 'failed_permanent',  // permanent provider error
}

// growth — content_variants
enum VariantStatus {
  DRAFT             = 'draft',
  APPROVED          = 'approved',
  QUEUED            = 'queued',
  LOCKED            = 'locked',            // reserved by publisher
  PUBLISHED         = 'published',
  FAILED            = 'failed',
  REJECTED          = 'rejected',
  NEEDS_REVIEW      = 'needs_review',      // human flag (must be set explicitly)
}
```

**Migration action:** rename existing `failed` in execution_tasks to `failed_retryable` / `failed_permanent` based on `attempt < max_attempts`. Add a DB CHECK constraint for allowed values on all three tables.

---

## Section 3 — Conversation Memory System

### 3.1 What Is Stored and Where

| Store | Content | TTL |
|---|---|---|
| `conversation_state` | `stage`, `memory_json` (facts), `last_intent`, `updated_at` | 90 days (pg_cron #8 cleanup) |
| `interactions` | Raw inbound/outbound text, channel, created_at | No automatic TTL |
| `brain.ts` context | Builds from interactions (8 turns) + memory_json | In-flight only |
| `widget_inbound` history | 20 most recent turns | In-flight only |
| `voice_turn` history | 15 most recent turns | In-flight only |

---

### 3.2 Where Memory Can Go Stale or Be Lost

**memory_json is never updated by executors**
`conversation_state.ts` exposes an `updateConversationState` function that can write to `memory_json`. A grep of the execution pipeline (executor_sms, executor_email, executor_whatsapp, executor_messenger, executor_rcs) shows zero calls to this function. The memory extraction logic exists but is never invoked. `memory_json` stays empty for all leads.

**History window too shallow for multi-day conversations**
`brain.ts` fetches 8 interactions. A lead who exchanges 4 messages per day will lose day-1 context by day 3. Qualification signals ("has budget", "timeline is Q2") discussed early are invisible to the AI by mid-funnel.

**No staleness timestamp on individual memory facts**
`memory_json` stores facts like `has_discussed_budget: true` with no timestamp. There is no way to know if a fact is 5 minutes or 60 days old. If a lead initially declines ("no budget") then re-engages months later, the old negative signal persists and biases the AI.

**Preference changes create conflicting queued tasks**
`widget_inbound` extracts `preferred_contact` from the last user message. If a lead says "text me" then "actually call me", `preferred_contact` is updated to `voice`. But existing SMS execution_tasks already queued for this lead are not cancelled. `cancel_pending_retries_channel` is only called inside executors (on DNC / halt), not on preference change.

**voice_turn DNC does not update conversation_state.stage**
`voice_turn:422–454` calls `apply_lead_halt_and_cancel` and halts the call. `conversation_state.stage` remains `engaged`. The next inbound SMS or widget message sees stage=engaged and proceeds with normal sales flow, bypassing the opt-out.

---

### 3.3 Incorrect Assumptions in Memory Extraction

`widget_inbound:239–240` scans `userMessages` (the full unsent message list) to check for lead capture signals, but `history` fed to OpenAI is capped at 20 turns. The lead capture scan and the AI prompt see different datasets, which can cause the system to ask for information it already has.

---

### 3.4 Recommended Memory Strategy

These are minimal, targeted improvements — not a redesign:

1. **Call `updateConversationState` after every successful send.** Inside each executor, after marking the task succeeded, extract and persist at minimum: `last_channel`, `last_sent_at`, `message_count`. This is one additional DB call per execution.

2. **Timestamp each memory fact.** Change `memory_json` from `{ key: value }` to `{ key: { value, updated_at } }`. When building context in `brain.ts`, discard facts older than 30 days. No schema change required — just a convention change.

3. **Update `conversation_state.stage = 'dnc'` on halt.** In `voice_turn` after `apply_lead_halt_and_cancel`, and in any executor that detects an unsubscribe intent, write the stage update. This is a one-line fix per location.

4. **On preference change, cancel conflicting queued tasks.** In `widget_inbound` when `preferred_contact` changes, call `cancel_pending_retries_channel` for the old channel before updating the memory. Same pattern already used in DNC flow.

5. **Latest wins, oldest discarded.** When a user sends contradictory signals (first "no budget", later "yes let's talk price"), always take the most recent value. Implement as: on memory_json write, compare `updated_at`; only overwrite if new timestamp is newer.

---

## Section 4 — System Prompt and Persona Architecture

### 4.1 Current Prompt Construction by Channel

**brain.ts (SMS, Email, WhatsApp, RCS, Messenger)**
1. `MASTER_SYSTEM_PROMPT` — zero-tolerance guardrails (no legal/medical/financial advice)
2. Industry-specific RULES constraint block
3. `buildPersonaBlock(settings)` — org persona
4. Custom prompt from `org_channels.system_prompt`
5. KNOWLEDGE block — `knowledge_base` rows + `memory_json` facts
6. CONTEXT block — lead name, intent, conversation type
7. Email-only: subject line constraint appended

**widget_inbound**
1. `buildPersonaBlock(settings)` — same function
2. Custom instructions from `active_org_prompts` (if present)
3. SITE LIAISON DIRECTIVE — collect name/phone/email goal
4. Phone number format instruction
5. No `MASTER_SYSTEM_PROMPT` guardrails
6. No knowledge_base fetch
7. No intent passed to prompt

**voice_turn**
1. `seedSystemPrompt` — injected at call initiation time by `executor_voice` (built separately, not at turn time)
2. `policyWrapper` — generic brevity/truthfulness/unsubscribe instructions
3. No `buildPersonaBlock` call at turn time
4. No knowledge_base integration
5. No industry constraint block
6. No intent classification used

---

### 4.2 Behavioral Inconsistencies

| Capability | SMS/Email | Widget | Voice |
|---|---|---|---|
| Legal/medical guardrails | Yes (MASTER_SYSTEM_PROMPT) | No | No |
| Industry constraints | Yes | No | No |
| knowledge_base context | Yes | No | No |
| persona via buildPersonaBlock | Yes | Yes | No (seed only) |
| Conversation history | 8 turns | 20 turns | 15 turns |
| Intent routing | Yes | No | No |
| Unsubscribe detection | Relies on intent_ai | None | Yes (explicit) |

**Critical gap — safety guardrails missing in voice and widget.** A voice call can give legal or medical advice without the zero-tolerance warning present in brain.ts. For a platform targeting law and medical firms, this is a compliance risk.

**knowledge_base gap in widget and voice.** Org-uploaded documents (Knowledge Brain PDFs, text rules) are completely absent from widget and voice context. An org that loads its pricing, FAQ, and intake procedures into the knowledge base gets that information only on SMS/email, not on the channels most likely to have a live human asking questions.

---

### 4.3 Proposed Unified Prompt Builder

Implement a single shared function in `_shared/prompt_builder.ts`. All channels call it; channel-specific blocks are additive.

```typescript
// _shared/prompt_builder.ts
export async function buildSystemPrompt(args: {
  sb: SupabaseClient;
  org_id: string;
  channel: "sms" | "email" | "voice" | "whatsapp" | "messenger" | "rcs" | "widget";
  intent?: string;
  isFirstMessage?: boolean;
}): Promise<string> {
  const [settings, knowledge, customPrompt] = await Promise.all([
    fetchOrgSettings(args.sb, args.org_id),
    fetchKnowledgeBase(args.sb, args.org_id),
    fetchActiveOrgPrompt(args.sb, args.org_id),
  ]);

  const blocks: string[] = [];

  // 1. Always-on safety guardrails (from MASTER_SYSTEM_PROMPT)
  blocks.push(MASTER_GUARDRAILS);

  // 2. Industry constraints (from settings.industry)
  blocks.push(buildIndustryConstraints(settings.industry));

  // 3. Persona
  blocks.push(buildPersonaBlock(settings));

  // 4. Channel-specific constraints
  if (args.channel === "voice")   blocks.push(VOICE_CONSTRAINTS);
  if (args.channel === "widget")  blocks.push(WIDGET_LIAISON_DIRECTIVE);
  if (args.channel === "email")   blocks.push(EMAIL_SUBJECT_CONSTRAINT);

  // 5. Knowledge base (all channels)
  if (knowledge.length) blocks.push(buildKnowledgeBlock(knowledge));

  // 6. Custom org prompt
  if (customPrompt) blocks.push(customPrompt);

  return blocks.join("\n\n");
}
```

`voice_turn` should call this at turn time using the org_id from the call context, replacing the pre-baked seed approach. The seed can remain for call initiation greetings, but per-turn generation should use the unified builder.

---

## Section 5 — RPC and Database Dependencies

### 5.1 All RPCs Called and Their Status

| RPC | Called From | Defined in Repo? | Failure Mode if Missing |
|---|---|---|---|
| `fetch_due_tasks` | `execution-dispatcher`, `task_sweeper` | No (DB-only) | No tasks dispatched; queue silently stalls |
| `execution_policy_v1` | `execution-dispatcher` | No (DB-only) | All tasks default to `failed_permanent` (null policy) |
| `is_kill_switch_enabled_v1` | `security.ts` | No (DB-only) | Fail-open: all execution continues even if switch is on |
| `is_org_cancelled_v1` | `security.ts` | No (DB-only) | Fail-open: cancelled orgs continue to execute |
| `is_lead_terminal` | `executor_voice`, `executor_sms` (indirect) | No (DB-only) | Fail-open: DNC'd leads continue receiving messages |
| `cancel_pending_retries_channel` | `executor_sms`, `executor_email`, `executor_voice` | No (DB-only) | No retry cancellation on terminal state; duplicate sends possible |
| `check_and_increment_rate_limit_v1` | `security.ts` | No (DB-only) | Fail-open: rate limits not enforced |
| `consume_tokens_v1` | All executors | No (DB-only) | Fail-open: execution proceeds without token debit |
| `grant_tokens_core_v1` | Multiple executors (refund on failure) | No (DB-only) | Users charged for failed sends, no refund |
| `apply_lead_halt_and_cancel` | `voice_turn` | No (DB-only) | DNC not applied; lead continues to receive messages |
| `settle_voice_call_tokens_v2` | `executor_voice` | No (DB-only) | Voice minutes not settled; tokens not debited |
| `approve_bank_transfer` | `admin.html` client | No (DB-only) | Bank approvals fail silently |
| `admin_grant_growth_engine` | `admin.html` | No (DB-only) | GE entitlement grant fails silently |
| `admin_get_growth_metrics` | `admin.html` | No (DB-only) | Founder Dashboard shows blank |
| `create_agency_enterprise_deal` | `admin.html` | No (DB-only) | Deals can't be created via admin |

---

### 5.2 Shape Mismatch Risks

**execution_policy_v1 (execution-dispatcher:568–572)**
Code handles both array and object returns:
```typescript
const policy = Array.isArray(policyRes)
  ? (policyRes?.[0]?.execution_policy_v1 ?? policyRes?.[0] ?? null)
  : (policyRes?.execution_policy_v1 ?? policyRes ?? null);
```
If RPC returns `null` or an unexpected shape, `policy?.apply` is `undefined`. `applyPolicyToTask` then defaults to `failed_permanent` for all tasks. A DB migration that changes the return shape silently kills all execution.

**is_lead_terminal (executor_voice:224–225)**
Accesses `term?.[0]?.is_terminal` and `term[0].reason`. If RPC returns an object instead of an array (possible if DB function signature changes), this throws a null-dereference crash on every voice task.

**consume_tokens_v1 — inconsistent field access**
`executor_sms:297–299` checks `consumeRes.status`. `executor_rcs:383` destructures `{ allowed, reason }`. If the RPC returns a unified `{ status, reason }` shape, the rcs executor's `allowed` field is always `undefined` — silently treating every token check as failed.

---

### 5.3 How to Make RPC Dependencies Safer

**Short term (no infra changes):**

1. Define TypeScript interfaces for every RPC return shape in `_shared/db.ts`. Add a thin wrapper that validates the response before returning. Any shape mismatch throws a typed error instead of a silent null.

```typescript
interface ExecutionPolicyResult {
  apply: "allow" | "block" | "dead_letter";
  reason?: string;
}
function assertExecutionPolicy(raw: unknown): ExecutionPolicyResult {
  if (!raw || typeof (raw as any).apply !== "string") {
    throw new Error("execution_policy_v1 returned unexpected shape");
  }
  return raw as ExecutionPolicyResult;
}
```

2. All security-gate RPCs (`is_kill_switch_enabled_v1`, `is_org_cancelled_v1`, `is_lead_terminal`) should **fail closed** on error, not fail open. Current code has no error handling on these calls.

3. Align `consume_tokens_v1` response field access. All executors should check `consumeRes.status === 'ok'`, not `consumeRes.allowed`. Pick one convention and apply it everywhere.

**Medium term:**

4. Add a startup health check that calls each critical RPC with a dummy org_id and verifies the return shape matches the expected interface. Run this on every deploy.

5. Version RPCs by name (`execution_policy_v2`, etc.) rather than modifying in place. Old callers continue to work until explicitly migrated.

---

## Section 6 — Growth Engine Pipeline

### 6.1 Content Getting Stuck in Invalid State

**queue_worker.py — variant status not reverted on max retries**
`queue_worker.py:280–293`: `_finalize_variant()` is only called on publish success (transitions variant to `published`). If a publish attempt fails and `attempt_count >= max_attempts`, the queue entry is marked `failed`, but `content_variants.status` stays `queued`. The UI shows the variant as queued indefinitely. Fix: on final failure, explicitly set `content_variants.status = 'failed'`.

**queue_worker.py — stale lock recovery delay**
`queue_worker.py:126–146`: Stale locks are recovered only at the start of each poll cycle (every 30 s). If a worker crashes while holding a lock, the content item is stuck for up to 5 minutes (lock TTL). No alerting on stale lock detection. Fix: emit a warning log with `org_id` + `variant_id` when a stale lock is reset.

**approval_engine.py — "needs_review" status never written**
`approval_engine.py:214, 560` checks for `status NOT IN ('published', 'needs_review', 'rejected')` as a guard. But `needs_review` is never set by any code path. The guard is dead but if a future developer adds `needs_review` logic, this would silently block re-queuing. Fix: either remove `needs_review` from the guard or implement the write path.

---

### 6.2 Race Conditions and Partial Failure

**approval_engine.py — mode check not atomic with enqueue decision**
`approval_engine.py:138–166`: `handle_pipeline_completion()` fetches `posting_mode` inside the function. If the org's mode is changed between the pipeline completing and this function being called (e.g. admin toggles mode via API mid-run), the wrong decision is made. An item that should require approval auto-enqueues, or vice versa. Fix: read `posting_mode` and make the enqueue decision within a single DB transaction.

**approval_engine.py — cancellation races with lock**
`approval_engine.py:566–589`: `cancel_queued_variants()` only cancels items with `status='pending'`. If an item has just been locked (`status='locked'`) by the queue worker, it will NOT be cancelled and the edit/rejected version of a variant will still publish. Fix: cancel `status IN ('pending', 'locked')` and add a re-check in the queue worker before executing a locked item.

**approval_engine.py — no prior-state check on status update**
`approval_engine.py:196–231`: Most UPDATE calls do not include `WHERE status = '<expected_prior_status>'`. Two concurrent workers or API calls can each read the same item in state A and both write state B independently. Fix: add prior-state WHERE clause to all status transitions.

**worker.py — no graceful shutdown for in-flight fetches**
`worker.py:44–70`: The shutdown signal is checked between items in the loop, but if `fetch_new_tasks()` is mid-execution when shutdown is signalled, those fetched items are neither processed nor released. They stay locked until TTL recovery. Fix: check the shutdown flag immediately after the fetch returns; if set, release all locks before exiting.

---

### 6.3 Missing Error Handling

**worker.py — unhandled exception loop**
`worker.py:59`: `except Exception as exc: log.error(...)` then continues. If the same root cause (e.g. DB connection down) causes every cycle to fail, the loop spins indefinitely with no backoff and no alerting. Fix: track consecutive error count; apply exponential backoff after 3 consecutive failures; emit an alert at 10.

**publishers — no per-publisher timeout**
Each publisher (`linkedin.py`, `facebook.py`, `instagram.py`) makes HTTP requests to platform APIs. There is no `timeout` parameter on the HTTP client calls. A stalled provider API will hang the worker indefinitely. Fix: add `timeout=30` to all `httpx` / `requests` calls in publishers.

**queue_worker.py — asset fallback is silent**
`queue_worker.py:347–391`: Falls back through 4 levels of asset resolution with no log warning. If a production post goes out with a fallback image instead of the intended brand template, there is no trace of why. Fix: log a warning at each fallback step with the variant_id.

---

### 6.4 What to Disable for Initial Launch

| Component | Risk | Action |
|---|---|---|
| `approval_engine.py` AUTO mode | Auto-enqueues content without human review | Default `posting_mode = MODE_APPROVAL` for all orgs at launch; do not expose mode toggle in UI |
| Engagement pipeline | `worker.py:16` engagement job is commented out; partially implemented executors | Keep disabled; do not uncomment until full end-to-end test passes |
| Carousel and stat_card image templates | Pillow rendering untested on Railway environment | Enable `quote_card` only; gate others behind a feature flag |
| X (Twitter) publisher | `x.py` — API v2 write access requires Elevated tier; most orgs won't have it | Disable at platform level; show "coming soon" |
| Direct access_token storage in `org_channels` | Tokens stored in plain JSONB; visible in Supabase dashboard | Acceptable for beta; before GA, move to Supabase Vault and store only vault ref |
| Per-turn voice token debiting | High-turn calls (10+ turns) can consume large token amounts unexpectedly | Add a `MAX_TURNS_PER_CALL = 8` hard cap in `voice_turn`; disable per-turn debit during beta |

---

*End of Audit — 6 sections · generated from live codebase reading*
