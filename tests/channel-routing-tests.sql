-- ============================================================
-- Channel Routing & Fallback Policy — Regression Test Suite
-- ============================================================
-- Run each test block individually via the Supabase Management API:
--   curl -s -X POST "https://api.supabase.com/v1/projects/klbwigcvrdfeeeeotehu/database/query" \
--     -H "Authorization: Bearer <PAT>" \
--     -H "Content-Type: application/json" \
--     -d '{"query": "<SQL from one test block>"}'
--
-- After each test: call the relevant executor via functions.invoke or curl,
-- then run the VERIFY block to check audit_events + task status.
-- Clean up with the TEARDOWN block after each test.
-- ============================================================

-- ============================================================
-- TEST 1 — SMS Fallback: allow_shared
-- Preconditions:
--   org has a dedicated SMS channel row that is now 'disabled'
--   fallback_policy = 'allow_shared'
-- Expected:
--   task succeeds via shared Twilio number
--   audit_events row created: action='channel_fallback_triggered', reason='allow_shared'
-- ============================================================

-- SETUP
DO $$
DECLARE
  v_org_id UUID;
  v_lead_id UUID;
  v_plan_id UUID;
  v_task_id UUID;
  v_member_id UUID;
BEGIN
  -- Use first org
  SELECT id INTO v_org_id FROM organizations LIMIT 1;

  -- Insert a disabled SMS channel with allow_shared policy
  INSERT INTO org_channels (org_id, channel, provider, from_e164, is_default, status, fallback_policy, created_at, updated_at)
  VALUES (v_org_id, 'sms', 'twilio', '+19990001111', true, 'disabled', 'allow_shared', now() - interval '1 day', now())
  ON CONFLICT DO NOTHING;

  -- Pick an existing lead or create one
  SELECT id INTO v_lead_id FROM leads WHERE org_id = v_org_id AND phone IS NOT NULL LIMIT 1;

  -- Pick or create a decision_plan
  INSERT INTO decision_plans (org_id, lead_id, plan) VALUES (v_org_id, v_lead_id, '{}') RETURNING id INTO v_plan_id;

  -- Get a real actor_user_id
  SELECT user_id INTO v_member_id FROM org_members WHERE org_id = v_org_id LIMIT 1;

  -- Create a pending SMS task
  INSERT INTO execution_tasks (org_id, lead_id, plan_id, channel, status, scheduled_for, max_attempts, actor_user_id, metadata)
  VALUES (v_org_id, v_lead_id, v_plan_id, 'sms', 'pending', now(), 3, v_member_id, '{"source":"test_1_sms_allow_shared"}')
  RETURNING id INTO v_task_id;

  RAISE NOTICE 'TEST 1 SETUP: org_id=%, lead_id=%, task_id=%', v_org_id, v_lead_id, v_task_id;
END $$;

-- ACTION: invoke executor_sms with task_id from above (run via curl or Supabase dashboard)
-- SELECT id FROM execution_tasks WHERE metadata->>'source' = 'test_1_sms_allow_shared' ORDER BY created_at DESC LIMIT 1;

-- VERIFY (run after invoke)
SELECT
  'TEST 1 VERIFY' AS test,
  t.status AS task_status,
  ae.action AS audit_action,
  ae.reason AS audit_reason,
  ae.before_state->>'org_sender' AS org_sender,
  ae.after_state->>'fallback_policy' AS fallback_policy,
  (ae.after_state->>'shared')::boolean AS used_shared
FROM execution_tasks t
JOIN audit_events ae ON ae.object_id = t.id AND ae.action = 'channel_fallback_triggered'
WHERE t.metadata->>'source' = 'test_1_sms_allow_shared'
ORDER BY t.created_at DESC LIMIT 1;

-- Expected: task_status='succeeded', audit_action='channel_fallback_triggered', audit_reason='allow_shared', used_shared=true
-- Also verify count:
SELECT COUNT(*) AS fallback_audit_events_for_test_1
FROM audit_events
WHERE action = 'channel_fallback_triggered'
  AND before_state->>'channel' = 'sms'
  AND reason = 'allow_shared';
-- Expected: >= 1

-- TEARDOWN
DELETE FROM audit_events WHERE action = 'channel_fallback_triggered' AND object_id IN (
  SELECT id FROM execution_tasks WHERE metadata->>'source' = 'test_1_sms_allow_shared'
);
DELETE FROM execution_tasks WHERE metadata->>'source' = 'test_1_sms_allow_shared';
DELETE FROM org_channels WHERE from_e164 = '+19990001111';


-- ============================================================
-- TEST 2 — SMS Fallback: fail_task
-- Preconditions:
--   org has a dedicated SMS channel row that is 'disabled'
--   fallback_policy = 'fail_task'
-- Expected:
--   task status = 'failed'
--   NO token consumed (resolution happens before consume_tokens_v1)
--   audit_events row: action='channel_fallback_triggered', reason='fail_task'
-- ============================================================

-- SETUP
DO $$
DECLARE
  v_org_id UUID;
  v_lead_id UUID;
  v_plan_id UUID;
  v_task_id UUID;
  v_member_id UUID;
BEGIN
  SELECT id INTO v_org_id FROM organizations LIMIT 1;

  INSERT INTO org_channels (org_id, channel, provider, from_e164, is_default, status, fallback_policy, created_at, updated_at)
  VALUES (v_org_id, 'sms', 'twilio', '+19990002222', true, 'disabled', 'fail_task', now() - interval '1 day', now())
  ON CONFLICT DO NOTHING;

  SELECT id INTO v_lead_id FROM leads WHERE org_id = v_org_id AND phone IS NOT NULL LIMIT 1;
  INSERT INTO decision_plans (org_id, lead_id, plan) VALUES (v_org_id, v_lead_id, '{}') RETURNING id INTO v_plan_id;
  SELECT user_id INTO v_member_id FROM org_members WHERE org_id = v_org_id LIMIT 1;

  INSERT INTO execution_tasks (org_id, lead_id, plan_id, channel, status, scheduled_for, max_attempts, actor_user_id, metadata)
  VALUES (v_org_id, v_lead_id, v_plan_id, 'sms', 'pending', now(), 3, v_member_id, '{"source":"test_2_sms_fail_task"}')
  RETURNING id INTO v_task_id;

  RAISE NOTICE 'TEST 2 SETUP: org_id=%, task_id=%', v_org_id, v_task_id;
END $$;

-- ACTION: invoke executor_sms with task_id

-- VERIFY
SELECT
  'TEST 2 VERIFY' AS test,
  t.status AS task_status,
  t.last_error,
  ae.action AS audit_action,
  ae.reason AS audit_reason
FROM execution_tasks t
LEFT JOIN audit_events ae ON ae.object_id = t.id AND ae.action = 'channel_fallback_triggered'
WHERE t.metadata->>'source' = 'test_2_sms_fail_task'
ORDER BY t.created_at DESC LIMIT 1;

-- Expected: task_status='failed', last_error contains 'CHANNEL_FALLBACK_POLICY_FAIL_TASK', audit_reason='fail_task'
SELECT COUNT(*) AS fail_task_audit_events
FROM audit_events
WHERE action = 'channel_fallback_triggered' AND reason = 'fail_task';
-- Expected: >= 1

-- TEARDOWN
DELETE FROM audit_events WHERE action = 'channel_fallback_triggered' AND object_id IN (
  SELECT id FROM execution_tasks WHERE metadata->>'source' = 'test_2_sms_fail_task'
);
DELETE FROM execution_tasks WHERE metadata->>'source' = 'test_2_sms_fail_task';
DELETE FROM org_channels WHERE from_e164 = '+19990002222';


-- ============================================================
-- TEST 3 — Voice Fallback: allow_shared
-- Preconditions:
--   org has a disabled voice channel row (vapi_phone_number_id set)
--   fallback_policy = 'allow_shared'
--   VAPI_PHONE_NUMBER_ID env var is set (shared)
-- Expected:
--   task proceeds using shared VAPI phone number
--   audit_events row: action='channel_fallback_triggered', channel='voice', reason='allow_shared'
-- ============================================================

-- SETUP
DO $$
DECLARE
  v_org_id UUID;
  v_lead_id UUID;
  v_plan_id UUID;
  v_member_id UUID;
BEGIN
  SELECT id INTO v_org_id FROM organizations LIMIT 1;

  INSERT INTO org_channels (org_id, channel, provider, vapi_phone_number_id, from_e164, is_default, status, fallback_policy, created_at, updated_at)
  VALUES (v_org_id, 'voice', 'vapi', 'phnum_old_org_id', '+19990003333', true, 'disabled', 'allow_shared', now() - interval '1 day', now())
  ON CONFLICT DO NOTHING;

  SELECT id INTO v_lead_id FROM leads WHERE org_id = v_org_id AND phone IS NOT NULL LIMIT 1;
  INSERT INTO decision_plans (org_id, lead_id, plan) VALUES (v_org_id, v_lead_id, '{}') RETURNING id INTO v_plan_id;
  SELECT user_id INTO v_member_id FROM org_members WHERE org_id = v_org_id LIMIT 1;

  INSERT INTO execution_tasks (org_id, lead_id, plan_id, channel, status, scheduled_for, max_attempts, actor_user_id, metadata)
  VALUES (v_org_id, v_lead_id, v_plan_id, 'voice', 'pending', now(), 3, v_member_id, '{"source":"test_3_voice_allow_shared"}');

  RAISE NOTICE 'TEST 3 SETUP done';
END $$;

-- ACTION: invoke executor_voice with task_id

-- VERIFY
SELECT
  'TEST 3 VERIFY' AS test,
  t.status AS task_status,
  ae.action AS audit_action,
  ae.before_state->>'org_sender' AS org_phone_number_id,
  ae.after_state->>'fallback_policy' AS fallback_policy,
  ae.before_state->>'channel' AS channel
FROM execution_tasks t
LEFT JOIN audit_events ae ON ae.object_id = t.id AND ae.action = 'channel_fallback_triggered'
WHERE t.metadata->>'source' = 'test_3_voice_allow_shared'
ORDER BY t.created_at DESC LIMIT 1;

-- Expected: audit_action='channel_fallback_triggered', channel='voice', fallback_policy='allow_shared'
SELECT COUNT(*) AS voice_fallback_audits
FROM audit_events
WHERE action = 'channel_fallback_triggered' AND before_state->>'channel' = 'voice';
-- Expected: >= 1

-- TEARDOWN
DELETE FROM audit_events WHERE action = 'channel_fallback_triggered' AND object_id IN (
  SELECT id FROM execution_tasks WHERE metadata->>'source' = 'test_3_voice_allow_shared'
);
DELETE FROM execution_tasks WHERE metadata->>'source' = 'test_3_voice_allow_shared';
DELETE FROM org_channels WHERE vapi_phone_number_id = 'phnum_old_org_id';


-- ============================================================
-- TEST 4 — Shared WhatsApp Inbound Routing
-- Preconditions:
--   platform_channels row exists: provider='twilio', channel='whatsapp', from_e164='+14155238886'
--   A lead exists with a known phone number
-- Expected:
--   resolve_inbound_org_channel_v1 returns status='ok', source='platform'
--   lead lookup succeeds if phone is unique
-- ============================================================

-- Verify platform_channels row exists
SELECT
  'TEST 4: platform_channels check' AS test,
  provider::text, channel::text, from_e164, status::text
FROM platform_channels
WHERE provider::text = 'twilio' AND channel::text = 'whatsapp';
-- Expected: 1 row, from_e164='+14155238886', status='active'

-- Simulate resolve_inbound_org_channel_v1 call for WA inbound
SELECT resolve_inbound_org_channel_v1(
  'twilio',         -- p_provider
  'whatsapp',       -- p_channel
  '+14155238886',   -- p_to_e164 (shared WA sender number)
  null              -- p_provider_number_id
) AS resolution;
-- Expected: {"status":"ok","source":"platform","org_id":null,"channel":"whatsapp",...}

-- Verify lead lookup would work for a known lead phone
-- Replace '+91XXXXXXXXXX' with a real lead phone in your DB
SELECT
  'TEST 4: lead lookup' AS test,
  id AS lead_id, org_id, phone
FROM leads
WHERE phone = (SELECT phone FROM leads WHERE phone IS NOT NULL LIMIT 1)
LIMIT 3;
-- Expected: exactly 1 row → inbound routes correctly; 2+ rows → ambiguity logged


-- ============================================================
-- TEST 5 — Inbound Ambiguity Logging
-- Preconditions:
--   Two leads in different orgs share the same phone number
-- Expected:
--   audit_events row: action='inbound_route_ambiguous'
--   message dropped (no interaction created)
-- Note: This test verifies DB state; the webhook itself must be triggered via curl.
-- ============================================================

-- SETUP: insert duplicate phone lead in a second org
DO $$
DECLARE
  v_org1 UUID;
  v_org2 UUID;
  v_lead1_phone TEXT;
BEGIN
  SELECT org_id INTO v_org1 FROM leads WHERE phone IS NOT NULL LIMIT 1;
  SELECT id INTO v_org2 FROM organizations WHERE id != v_org1 LIMIT 1;
  SELECT phone INTO v_lead1_phone FROM leads WHERE org_id = v_org1 AND phone IS NOT NULL LIMIT 1;

  -- Insert duplicate lead in org2 with same phone
  INSERT INTO leads (org_id, profile_id, name, phone, status)
  SELECT v_org2, (SELECT user_id FROM org_members WHERE org_id = v_org2 LIMIT 1),
         'Test Ambiguous Lead', v_lead1_phone, 'new'
  WHERE v_lead1_phone IS NOT NULL;

  RAISE NOTICE 'TEST 5 SETUP: duplicate phone % in orgs % and %', v_lead1_phone, v_org1, v_org2;
END $$;

-- ACTION: send a POST to webhook_inbound?source=twilio simulating an inbound SMS/WA
-- from the duplicate phone number to the shared platform number.
-- The webhook will hit the cross-org lookup, find 2 leads, and log ambiguity.

-- VERIFY (run after webhook call)
SELECT
  'TEST 5 VERIFY' AS test,
  action,
  after_state->>'phone' AS phone,
  after_state->>'channel' AS channel,
  after_state->>'candidate_org_ids' AS candidate_org_ids,
  created_at
FROM audit_events
WHERE action = 'inbound_route_ambiguous'
ORDER BY created_at DESC LIMIT 3;
-- Expected: 1 row with action='inbound_route_ambiguous', candidate_org_ids contains 2 org IDs

SELECT COUNT(*) AS ambiguity_events
FROM audit_events WHERE action = 'inbound_route_ambiguous';
-- Expected: >= 1

-- TEARDOWN: remove duplicate lead
DELETE FROM leads WHERE name = 'Test Ambiguous Lead' AND status = 'new';


-- ============================================================
-- SUMMARY VERIFICATION (run anytime)
-- Check total fallback audit events by type
-- ============================================================
SELECT
  action,
  reason,
  before_state->>'channel' AS channel,
  COUNT(*) AS event_count
FROM audit_events
WHERE action IN ('channel_fallback_triggered', 'inbound_route_ambiguous', 'inbound_route_no_lead')
GROUP BY action, reason, before_state->>'channel'
ORDER BY action, reason;
