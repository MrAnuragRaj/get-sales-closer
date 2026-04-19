# Launch Verification Pack
> GetSalesCloser — Execution Pipeline
> Generated: 2026-04-02 | Use before first production traffic

---

## How to Use

For each scenario: run the **Before SQL** to capture baseline state, execute the **Manual Test**, then run the **After SQL** and compare against **Expected Result**. Any deviation matching the **Failure Signature** requires a fix before launch.

---

## 1. Decision Engine Idempotency

### Before SQL
```sql
-- Capture existing plan count for a given lead
SELECT COUNT(*) AS plan_count
FROM decision_plans
WHERE lead_id = '<lead_id>';
```

### Manual Test
1. Send the same inbound webhook payload twice within 30 seconds (simulate Twilio retry).
2. Both requests must include identical `lead_id` and `trigger`.

### Expected Result
- Only one `decision_plans` row created.
- Second call returns HTTP 200 with the existing plan JSON.
- `execution_tasks` count stays the same after the second call.

### Failure Signature
```sql
SELECT COUNT(*) FROM decision_plans
WHERE lead_id = '<lead_id>'
AND created_at > NOW() - INTERVAL '2 minutes';
-- Count > 1 = idempotency broken
```

---

## 2. All 6 Executors — delivery_attempt Flow

### Before SQL
```sql
-- No delivery_attempt should exist for this task yet
SELECT id, status, attempt_number
FROM delivery_attempts
WHERE task_id = '<task_id>';
-- Expected: 0 rows
```

### Manual Test
1. Create an execution_task for each channel (sms, email, voice, whatsapp, rcs, messenger).
2. Invoke each executor via `supabase functions invoke executor_<channel> --body '{"task_id":"..."}'`.
3. Watch for delivery.

### Expected Result per Channel
```sql
SELECT da.status, da.provider_message_id, et.status AS task_status
FROM delivery_attempts da
JOIN execution_tasks et ON et.id = da.task_id
WHERE da.task_id = '<task_id>';

-- SUCCESS: da.status = 'sent', et.status = 'succeeded'
-- DECLINED (DNC/terminal): et.status = 'skipped_terminal', da = no row or 'failed'
-- FAILURE:  da.status = 'failed', et.status = 'failed'
```

### Failure Signature
```sql
-- Task marked succeeded without delivery_attempt = 'sent'
SELECT et.id, et.status, da.status AS da_status
FROM execution_tasks et
LEFT JOIN delivery_attempts da ON da.task_id = et.id
WHERE et.status = 'succeeded'
AND (da.id IS NULL OR da.status != 'sent')
AND et.created_at > NOW() - INTERVAL '1 hour';
-- Any rows here = delivery/task status mismatch
```

---

## 3. Dispatcher Timeout Handling

### Before SQL
```sql
SELECT id, status, locked_by, locked_until
FROM execution_tasks
WHERE id = '<task_id>';
```

### Manual Test
1. Set `EXECUTOR_TIMEOUT_MS` to 100ms temporarily (or use a task that intentionally times out).
2. Dispatch the task.
3. Check whether the executor completed despite the timeout.

### Expected Result
- If executor sent the message (delivery_attempt.status = 'sent'): task marked `succeeded`.
- If executor did not send: task returned to `pending` with retry scheduling.
- Never: task stuck in `running` after lease expires.

### Failure Signature
```sql
-- Tasks stuck in 'running' past their locked_until
SELECT id, channel, locked_until, status
FROM execution_tasks
WHERE status = 'running'
AND locked_until < NOW()
AND updated_at < NOW() - INTERVAL '5 minutes';
-- Any rows = lease not being recovered
```

---

## 4. task_sweeper — Retry and Dead-Letter Behavior

### Before SQL
```sql
SELECT id, status, attempt, max_attempts, last_error, metadata->>'sweeper_total_failures' AS total_failures
FROM execution_tasks
WHERE id = '<task_id>';
```

### Manual Test
1. Create a task pointing to a deliberately broken executor URL (force network failure).
2. Let the sweeper run 5+ cycles.
3. Observe exponential backoff and eventual dead-letter.

### Expected Result
```sql
-- After 5 failures:
SELECT status, last_error, metadata
FROM execution_tasks
WHERE id = '<task_id>';
-- status = 'dead_lettered'
-- last_error starts with 'SWEEPER_DEAD_LETTER:'
-- metadata.sweeper_total_failures = 5

-- Backoff schedule (approximate):
-- Failure 1 → scheduled_for = +30s
-- Failure 2 → scheduled_for = +60s
-- Failure 3 → scheduled_for = +120s
-- Failure 4 → scheduled_for = +240s
-- Failure 5 → dead_lettered
```

### Failure Signature
```sql
-- Tasks retrying forever without dead-letter
SELECT id, status, metadata->>'sweeper_total_failures' AS failures
FROM execution_tasks
WHERE status IN ('pending', 'running')
AND CAST(metadata->>'sweeper_total_failures' AS INT) >= 5;
-- Any rows = dead-letter ceiling not working
```

---

## 5. DNC / Halt Behavior

### Before SQL
```sql
-- Confirm lead is in DNC state
SELECT cs.stage, cs.last_intent, l.id AS lead_id
FROM conversation_state cs
JOIN leads l ON l.id = cs.lead_id
WHERE l.id = '<lead_id>';
-- stage should be 'dnc'
```

### Manual Test
1. Send a message with intent=unsubscribe for a lead via webhook_inbound.
2. Confirm `conversation_state.stage = 'dnc'`.
3. Attempt to dispatch a new task for the same lead (sms, email, voice, whatsapp, rcs, messenger).

### Expected Result
- All 6 executors return HTTP 200 with `status=skipped_terminal`.
- `execution_tasks.status = 'skipped_terminal'`.
- No delivery_attempt inserted.
- No Twilio/Resend/VAPI API call made.

### Failure Signature
```sql
-- A DNC lead received an outbound message
SELECT da.id, da.channel, da.status, da.created_at
FROM delivery_attempts da
JOIN leads l ON l.id = da.lead_id
WHERE l.id = '<dnc_lead_id>'
AND da.status = 'sent'
AND da.created_at > NOW() - INTERVAL '10 minutes';
-- Any rows = DNC violation — CRITICAL
```

---

## 6. updateConversationState Writes

### Before SQL
```sql
SELECT stage, last_intent, memory_json, updated_at
FROM conversation_state
WHERE lead_id = '<lead_id>';
-- Note current values
```

### Manual Test
1. Dispatch an outbound SMS task for a lead.
2. Lead has had prior inbound message with intent=request_meeting.
3. Check conversation_state after task succeeds.

### Expected Result
```sql
SELECT stage, last_intent, memory_json, updated_at
FROM conversation_state
WHERE lead_id = '<lead_id>';
-- stage progressed (e.g. outreach → meeting_requested)
-- last_intent = 'request_meeting' (or the intent from the task)
-- updated_at > task executed_at
```

### Failure Signature
```sql
-- conversation_state never updated after task execution
SELECT et.id, et.executed_at, cs.updated_at
FROM execution_tasks et
LEFT JOIN conversation_state cs ON cs.lead_id = et.lead_id
WHERE et.status = 'succeeded'
AND et.channel = 'sms'
AND et.executed_at > NOW() - INTERVAL '1 hour'
AND (cs.updated_at IS NULL OR cs.updated_at < et.executed_at);
-- Any rows = memory not being updated after send
```

---

## 7. Growth Engine Feature Flags

### Verification Queries
```sql
-- Growth Engine should not have any auto-published content
-- (all flags default False, so publish_queue should be empty or only manual items)
SELECT status, COUNT(*) FROM growth.publish_queue GROUP BY status;

-- No variants should be in 'queued' state without explicit human approval
SELECT cv.id, cv.status, cv.platform, cv.created_at
FROM growth.content_variants cv
WHERE cv.status = 'queued'
AND cv.approved_by IS NULL
AND cv.created_at > NOW() - INTERVAL '24 hours';
-- Any rows with approved_by IS NULL = auto-posting bypassed (should not happen)
```

### Manual Test
Set `GE_AUTO_POSTING_ENABLED=false` (default). Run the content pipeline for a test org with `posting_mode=auto`. Confirm variant lands in `approved` state, NOT `queued` — i.e. auto-enqueue is blocked.

### Expected Result
- variant.status = 'approved' (waiting for human action)
- No publish_queue entry created

### Failure Signature
```sql
SELECT cv.status, pq.status AS queue_status
FROM growth.content_variants cv
JOIN growth.publish_queue pq ON pq.variant_id = cv.id
WHERE cv.created_at > NOW() - INTERVAL '1 hour'
AND pq.created_at > NOW() - INTERVAL '1 hour';
-- Any rows when GE_AUTO_POSTING_ENABLED=false = flag bypass
```

---

## 8. Observability Queries

Run these at any time to get a live health snapshot of the execution system.

```sql
-- 8a. Task counts by status
SELECT status, COUNT(*) AS count
FROM execution_tasks
GROUP BY status
ORDER BY count DESC;

-- 8b. Delivery attempts by status
SELECT status, channel, COUNT(*) AS count
FROM delivery_attempts
GROUP BY status, channel
ORDER BY channel, status;

-- 8c. Tasks stuck in pending > 15 minutes (should be scheduled for a future time)
SELECT id, channel, status, scheduled_for, attempt, last_error
FROM execution_tasks
WHERE status = 'pending'
AND scheduled_for < NOW() - INTERVAL '15 minutes'
ORDER BY scheduled_for ASC
LIMIT 20;

-- 8d. Tasks with multiple retries (potential systemic failures)
SELECT id, channel, status, attempt, max_attempts, last_error,
       metadata->>'sweeper_total_failures' AS sweeper_failures
FROM execution_tasks
WHERE attempt > 1
AND status IN ('pending', 'running', 'failed')
AND updated_at > NOW() - INTERVAL '24 hours'
ORDER BY attempt DESC
LIMIT 20;

-- 8e. Recent dead-lettered tasks (last 24h)
SELECT id, channel, last_error, metadata->>'sweeper_total_failures' AS failures,
       metadata->>'sweeper_last_error_category' AS error_category,
       updated_at
FROM execution_tasks
WHERE status = 'dead_lettered'
AND updated_at > NOW() - INTERVAL '24 hours'
ORDER BY updated_at DESC;

-- 8f. Orphaned delivery_attempts (pending > 10 min — sweeper should catch these)
SELECT da.id, da.task_id, da.channel, da.attempt_number, da.updated_at,
       et.status AS task_status
FROM delivery_attempts da
JOIN execution_tasks et ON et.id = da.task_id
WHERE da.status = 'pending'
AND da.updated_at < NOW() - INTERVAL '10 minutes';

-- 8g. Task/delivery_attempt status mismatch (critical: task succeeded but delivery not sent)
SELECT et.id, et.channel, et.status AS task_status, da.status AS da_status,
       et.executed_at, da.updated_at
FROM execution_tasks et
JOIN delivery_attempts da ON da.task_id = et.id
WHERE et.status = 'succeeded'
AND da.status != 'sent'
AND et.executed_at > NOW() - INTERVAL '24 hours';
```
