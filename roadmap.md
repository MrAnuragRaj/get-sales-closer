

Your understanding is very close, but there are three small corrections and one clarification needed before coding so the implementation stays fully consistent with the institutional-grade spec.

I’ll go point-by-point.

1. DB Changes
1.1 org_channels.fallback_policy

Your interpretation is correct.

ALTER TABLE org_channels
ADD COLUMN fallback_policy TEXT NOT NULL DEFAULT 'allow_shared';

Backfill happens automatically because of DEFAULT.

Allowed values remain:

allow_shared
fail_task
admin_override

No changes needed here.

1.2 platform_channels WhatsApp row

Conceptually correct, but do not hard-code the sandbox number in production schema migrations.

Instead:

INSERT INTO platform_channels
(provider, channel, from_e164, status, created_at)
VALUES
('twilio', 'whatsapp', '<TWILIO_WA_FROM_NUMBER>', 'active', now());

Where <TWILIO_WA_FROM_NUMBER> must match the environment variable.

If you insert the sandbox number directly, then later switch the env var to a production WA number, the resolver will mismatch.

Rule

platform_channels.from_e164
must equal
TWILIO_WA_FROM_NUMBER env var

So either:

• run the migration with the correct number
or
• update the row when switching to production.

2. Executor Resolution Algorithm

Your description is correct and aligned with the spec.

But there is one safety rule you should add.

When doing Step 2:

SELECT *
FROM org_channels
WHERE org_id = ?
AND channel = ?
ORDER BY updated_at DESC
LIMIT 1

You should exclude rows that were never default senders.

Otherwise a random historical row might become the authority.

So the correct query should be:

WHERE org_id = ?
AND channel = ?
AND is_default = true

Then order by updated_at DESC.

This ensures the authority row is the most recent default sender for that org/channel.

3. Token Consumption Timing

You mentioned moving channel resolution before token consumption.

This is exactly correct and should be done.

Correct order should be:

resolve sender
apply fallback policy
only then consume tokens
send message/call

Otherwise a fail_task policy wastes tokens.

So your adjustment is correct.

4. Fallback Behavior for Brand-New Orgs

Your interpretation:

no org_channels rows → use shared sender → console.log only

That is correct.

Reason: this is not a degradation state.

So:

NO audit event
ONLY runtime log
5. audit_events Insert

Your payload shape is correct and matches the table contract.

One small improvement:

Use structured JSON for before_state and after_state.

Example:

before_state: {
  org_sender: orgSender,
  channel: channel
}

after_state: {
  used_sender: resolvedSender,
  fallback_policy: fallback_policy,
  shared: true
}

Your structure already matches this.

So this is correct.

6. Logging Levels

Your plan for log levels is good:

Policy	Log Level
allow_shared	console.warn
admin_override	console.error
fail_task	console.error

Brand-new org case:

console.info

This separation is helpful for ops debugging.

7. Inbound Ambiguity Logging

Your description is exactly correct.

Two events:

inbound_route_no_lead
inbound_route_ambiguous

Payload:

phone
channel
provider
candidate_org_ids

No routing change.

This matches the spec.

8. WhatsApp Capability Gate

Correct.

Do not change:

org_channel_capabilities.whatsapp_enabled

This protects sender reputation.

9. Tests

Your test plan is correct.

The only additional rule I would enforce:

Tests must verify audit_events rows exist when expected.

Not just success/failure.

Example:

SELECT COUNT(*)
FROM audit_events
WHERE action='channel_fallback_triggered'

Should equal expected count.

10. Answer to Your Question (WhatsApp Number)

You asked whether to use sandbox or production number.

Use the sandbox number for now:
+14155238886

because:

• it works with Twilio sandbox
• it matches whatsapp:+14155238886 format
• you can replace it later once Meta approves your WA sender

Just remember to update both:

platform_channels.from_e164
TWILIO_WA_FROM_NUMBER

when moving to production.

Final Confirmation

Your implementation plan is correct and approved, with only these adjustments:

Use is_default=true in Step 2 query

Ensure platform_channels.from_e164 always matches TWILIO_WA_FROM_NUMBER

Verify audit events in tests

