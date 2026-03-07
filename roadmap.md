# Institutional-Grade Hardening Plan
## Final Reliability / Safety / Observability Layer

> Last synced: Session 21 (2026-03-07)
> Status: Ready to implement. All prerequisites confirmed in place.

### Claude's Modifications to This Plan (acknowledged below)

1. **Admin panel numbering shifted** — `admin.html` already has P9 "Rate Limit & Security". New panels will be P10 (Platform Control Flags), P11 (Rate Limit Monitor), P12 (Dead Letter Queue), P13 (Provider Webhook Events). Existing P9 stays unchanged.

2. **Rate limiter RPC** — `enforce_rate_limit_v1` already exists in the DB. Will check its signature before deciding to extend it or create the new `check_and_increment_rate_limit_v1`. Will not duplicate if the existing RPC can be reused atomically.

3. **`channel_health_current` primary key** — `(org_id, channel)` fails when `org_id IS NULL` (platform-level rows). Fix: add a `'platform'` sentinel UUID constant OR treat platform-level rows separately in upsert logic. Will implement with `COALESCE(org_id, '00000000-0000-0000-0000-000000000000')` or a conditional upsert to avoid PK NULL issue.

4. **`dead_lettered` task status** — Must verify `execution_tasks.status` ENUM allows this value; if not, `ALTER TYPE` before dispatcher code is written.

5. **Health thresholds** — Plan says excellent < 1%, normal < 3%, elevated < 7%, degraded ≥ 7%. The existing delivery dashboard uses a different scale (excellent = 0%, normal < 5%, elevated > 5%, degraded > 20%). I will use the **roadmap thresholds** for the automated monitor (more sensitive for ops), and leave the dashboard badge scale unchanged (user-facing, less noisy). Both are correct for their context.

---

## Scope

Implement the remaining institutional-grade hardening items:

Platform Kill Switch

Global Rate Limiter

Dead-Letter Queue (DLQ)

Provider Webhook Event Store

Channel Health Monitor Automation

This plan assumes the current system already has:

ledger-backed credits

order/billing flows

personalized numbers

cancellation/refunds

SMS / Voice / WhatsApp / RCS / Messenger

fallback policies

delivery_attempts

audit_events

message_threads

delivery status dashboard

admin operational controls

This hardening layer must not disrupt existing architecture. It must extend it safely.

0. Non-Negotiable Implementation Rules

Claude Code must follow these rules while implementing:

0.1 No architectural shortcuts

Do not bypass:

audit_events

delivery_attempts

existing fallback policy logic

executor guard chains

token consumption / refund logic

0.2 Additive changes only

Prefer:

new tables

new functions

new checks in dispatcher/executors

new admin panels

Avoid breaking current working flows.

0.3 All new safety actions must be observable

Every new system-level intervention must produce:

structured runtime log

audit_events row if operationally important

0.4 System-wide guard order

For every outbound execution, after this hardening work the order must be:

platform kill switch check

org cancellation / org restriction check

rate-limit check

channel capability check

binding/fallback resolution

token / billing mode check

send

delivery_attempt logging

usage rating / settlement

channel health metrics update

That order must be consistent across all executors.

1. Platform Kill Switch
Goal

Provide an emergency stop mechanism for the entire platform or specific channels.

This is for:

provider outage

spam attack

broken rollout

billing bug

compliance incident

major webhook malfunction

1.1 Schema

Create table:

create table if not exists public.platform_control_flags (
  flag_name text primary key,
  enabled boolean not null default false,
  reason text null,
  updated_by uuid null,
  updated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

Seed rows:

insert into public.platform_control_flags(flag_name, enabled, reason)
values
  ('global_execution_pause', false, null),
  ('sms_sending_disabled', false, null),
  ('voice_sending_disabled', false, null),
  ('whatsapp_sending_disabled', false, null),
  ('rcs_sending_disabled', false, null),
  ('messenger_sending_disabled', false, null),
  ('email_sending_disabled', false, null)
on conflict (flag_name) do nothing;
1.2 Runtime policy
Global flag

If:

global_execution_pause = true

Then:

campaign ticker must not create new execution tasks

dispatcher must not lease execution tasks

executors must refuse execution immediately

Channel-specific flag

If:

<channel>_sending_disabled = true

Then:

tasks for that channel are blocked

fallback should not automatically jump to another channel unless routing policy explicitly allows that fallback

audit and logs must record the block

1.3 Enforcement points

Add checks to:

campaign_ticker

Before creating any execution task:

read flags

if blocked, skip creation

write operational log

execution-dispatcher

Before leasing:

read flags

if blocked, do not lease task

set task status to something explicit if appropriate, e.g.:

blocked_platform_pause

blocked_channel_pause

executors

At executor entry:

check flags again

fail safely if blocked

no token consumption

write audit if task was already committed for execution

This triple-layer enforcement mirrors the cancellation system and must be done similarly.

1.4 Admin controls

Add new section in admin.html:

P9 — Platform Control Flags

Show:

flag name

enabled/disabled toggle

reason

last updated at

updated by

Actions:

enable flag

disable flag

enter reason required when enabling

Every toggle writes:

audit_events

structured runtime log

1.5 Audit actions

Use actions such as:

platform_flag_enabled

platform_flag_disabled

platform_execution_blocked

2. Global Rate Limiter
Goal

Protect:

Twilio

Vapi

Google RBM

Meta Graph

your own infrastructure

Prevent:

spam bursts

accidental loops

channel abuse

provider suspension

2.1 Schema

Create table:

create table if not exists public.rate_limit_buckets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid null,
  scope text not null,             -- 'org' | 'platform'
  channel text not null,           -- sms | voice | whatsapp | rcs | messenger | email
  window_start timestamptz not null,
  sent_count integer not null default 0,
  blocked_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

Indexes:

create index if not exists idx_rate_limit_buckets_scope_channel_window
on public.rate_limit_buckets(scope, channel, window_start desc);

create index if not exists idx_rate_limit_buckets_org_channel_window
on public.rate_limit_buckets(org_id, channel, window_start desc);
2.2 Limits to implement now

Freeze initial defaults:

Per-org per minute

sms: 60

whatsapp: 40

rcs: 30

messenger: 50

voice: 20

email: 100

Platform per minute

Use safe defaults first:

sms: 1000

whatsapp: 500

rcs: 300

messenger: 500

voice: 120

email: 5000

These can later be moved to config.

2.3 Enforcement logic

Before execution send:

calculate current window:

truncate to minute

increment/check org bucket

increment/check platform bucket

if either exceeded:

do not send

do not consume token

mark task blocked/retryable

write audit/log if severe

Status behavior

If rate-limited:

prefer status like:

blocked_rate_limit_org

blocked_rate_limit_platform

Optional:

retry later if task policy allows

move to DLQ after repeated blocks if permanent

2.4 DB function

Create controlled RPC, e.g.:

check_and_increment_rate_limit_v1(
  p_org_id uuid,
  p_channel text,
  p_org_limit int,
  p_platform_limit int
)
returns jsonb

Return shape:

{
  "allowed": true,
  "org_count": 12,
  "platform_count": 155,
  "window_start": "..."
}

or

{
  "allowed": false,
  "reason": "org_limit_exceeded"
}

This function must be atomic to avoid race conditions.

2.5 Admin UI

Add section in admin.html:

P10 — Rate Limit Monitor

Show:

per channel org blocks in last 24h

platform blocks in last 24h

top orgs hitting limits

current rolling counts if practical

2.6 Audit / logs

Actions:

rate_limit_blocked_org

rate_limit_blocked_platform

Use structured runtime logs too.

3. Dead-Letter Queue (DLQ)
Goal

Never silently lose execution tasks.

Any task that exhausts retries or fails in unrecoverable ways must land in a reviewable queue.

3.1 Schema

Create table:

create table if not exists public.execution_dead_letters (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null,
  org_id uuid null,
  channel text not null,
  payload jsonb not null default '{}'::jsonb,
  failure_reason text not null,
  failure_count integer not null default 0,
  last_error text null,
  original_status text null,
  moved_at timestamptz not null default now(),
  moved_by text not null default 'system',
  metadata jsonb not null default '{}'::jsonb
);

Indexes:

create index if not exists idx_execution_dead_letters_org_moved_at
on public.execution_dead_letters(org_id, moved_at desc);

create index if not exists idx_execution_dead_letters_channel_moved_at
on public.execution_dead_letters(channel, moved_at desc);
3.2 Trigger conditions

A task moves to DLQ when:

attempt >= max_attempts

executor returns unrecoverable error

malformed payload

missing required provider config after retries

persistent routing failure

repeated webhook/state mismatch

Do not DLQ on first temporary rate-limit block unless policy says so.

3.3 Dispatcher behavior

When task is moved:

copy task snapshot into execution_dead_letters

mark task terminal, e.g.:

dead_lettered

write audit_events

structured runtime log

3.4 Admin UI

Add section in admin.html:

P11 — Dead Letter Queue

Columns:

moved_at

org

channel

failure_reason

failure_count

last_error

task id

Actions:

inspect payload

retry task

cancel permanently

Retry action should:

create new execution task or reset safely

not mutate original destructively without trace

write audit event

3.5 Audit actions

execution_dead_lettered

execution_dead_letter_retry_requested

execution_dead_letter_cancelled

4. Provider Webhook Event Store
Goal

Store raw provider webhooks before/while processing them so:

every event is replayable

debugging is possible

event idempotency is stronger

provider lifecycle is auditable

This applies to:

Twilio

Vapi (if applicable)

Google RBM

Facebook Messenger / Meta

4.1 Schema

Create table:

create table if not exists public.provider_webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  source text null,                    -- twilio_sms, twilio_whatsapp, google_rbm, facebook_messenger, vapi, etc.
  event_type text not null,
  provider_event_id text null,
  payload jsonb not null,
  signature_verified boolean not null default false,
  processed boolean not null default false,
  processed_at timestamptz null,
  processing_error text null,
  received_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

Index / uniqueness:

create unique index if not exists uq_provider_webhook_event
on public.provider_webhook_events(provider, provider_event_id)
where provider_event_id is not null;
4.2 Flow

For every inbound webhook:

receive request

verify signature if applicable

derive:

provider

event_type

provider_event_id

insert into provider_webhook_events

if duplicate unique event id, skip duplicate processing safely

process business logic

mark processed = true

if processing fails, record processing_error

This should happen in:

Twilio status callbacks

Twilio inbound message events

Google RBM Pub/Sub events

Facebook Messenger webhooks

any other provider callback

4.3 Important rule

Do not stop writing to delivery_attempts.
This table is in addition to delivery_attempts, not a replacement.

provider_webhook_events = raw provider truth

delivery_attempts = normalized business/runtime state

4.4 Admin visibility

Add section in admin.html:

P12 — Provider Webhook Events

Show:

provider

event_type

provider_event_id

received_at

processed yes/no

processing error

Filters:

provider

processed/unprocessed

last 24h / 7d

4.5 Audit actions

Only write audit on exceptional conditions:

provider_webhook_processing_failed

provider_webhook_duplicate_detected if useful

Normal webhook events can remain in provider_webhook_events without spamming audit_events.

5. Channel Health Monitor Automation
Goal

Move from passive dashboard health badges to actual automated channel health monitoring.

Current system already has:

delivery status dashboard

failure-rate health badge in 7-day view

Now add:

periodic aggregation

persistent channel health state

automatic degradation awareness

future ability to bias routing/fallback

5.1 Schema

Create table:

create table if not exists public.channel_health_metrics (
  id uuid primary key default gen_random_uuid(),
  org_id uuid null,
  channel text not null,
  window_start timestamptz not null,
  window_end timestamptz not null,
  sent_count integer not null default 0,
  delivered_count integer not null default 0,
  read_count integer not null default 0,
  failed_count integer not null default 0,
  failure_rate numeric(8,4) not null default 0,
  latency_p95_ms numeric(12,2) null,
  health_status text not null, -- excellent | normal | elevated | degraded
  created_at timestamptz not null default now()
);

Indexes:

create index if not exists idx_channel_health_metrics_org_channel_window
on public.channel_health_metrics(org_id, channel, window_start desc);

Optionally add a current-state cache table:

create table if not exists public.channel_health_current (
  org_id uuid null,
  channel text not null,
  health_status text not null,
  failure_rate numeric(8,4) not null default 0,
  sent_count integer not null default 0,
  delivered_count integer not null default 0,
  failed_count integer not null default 0,
  latency_p95_ms numeric(12,2) null,
  calculated_at timestamptz not null default now(),
  primary key (org_id, channel)
);
5.2 Calculation cadence

Run every 5 minutes.

Window:

rolling 1 hour for live health

optionally keep 24h and 7d aggregation separately

5.3 Health rules

Freeze first-pass mapping:

excellent

failure_rate < 1%

normal

failure_rate >= 1% and < 3%

elevated

failure_rate >= 3% and < 7%

degraded

failure_rate >= 7%

If latency data is available, downgrade one band if p95 latency crosses threshold.

These thresholds can be tuned later.

5.4 Aggregation source

Use delivery_attempts.

Per org + channel:

count outbound attempts

delivered / read / failed / undelivered

calculate failure rate

derive health status

Do not include inbound events in failure-rate calculations unless explicitly needed.

5.5 Use of health state

Initially:

power dashboard widget

power admin health badges

surface internal warnings

Later:

routing bias

fallback preferences

upsell triggers

Do not change routing automatically yet unless explicitly asked.

5.6 UI updates
Org portals

Existing delivery dashboard can read from:

aggregated current state table if implemented
instead of recalculating every time

Admin

Add health panel:

top degraded orgs by channel

channels with elevated/degraded status

last recalculated time

5.7 Alerting

When health transitions:

normal → elevated

elevated → degraded

Write:

structured runtime log

optional internal alert row / admin warning

audit only if you want persistent operational incident history

Suggested audit action:

channel_health_degraded

Use sparingly to avoid noise.

6. Cross-Cutting Integration Points
6.1 Executors to update

All executors must check:

platform kill switch

rate limiter

existing org cancellation

existing fallback / capability logic

Affected:

executor_sms

executor_voice

executor_whatsapp

executor_rcs

executor_messenger

optionally email executor if it exists in same pattern

6.2 Dispatcher to update

execution-dispatcher must:

honor platform kill switch

optionally pre-check rate limit if you want early block

move exhausted tasks to DLQ

write appropriate status codes

6.3 webhook_inbound to update

All webhook paths must:

persist raw provider event in provider_webhook_events

then run current normalization/business logic

6.4 admin.html sections to add

Add these new sections:

P9 Platform Control Flags

P10 Rate Limit Monitor

P11 Dead Letter Queue

P12 Provider Webhook Events

enhance existing health view using channel health monitor data

7. Required Audit Actions

Add/standardize these actions:

platform_flag_enabled

platform_flag_disabled

platform_execution_blocked

rate_limit_blocked_org

rate_limit_blocked_platform

execution_dead_lettered

execution_dead_letter_retry_requested

execution_dead_letter_cancelled

provider_webhook_processing_failed

channel_health_degraded

Keep payloads structured.

8. Required Runtime Logs

Emit structured logs for:

kill switch blocks

rate-limit blocks

DLQ moves

webhook processing failures

health degradation transitions

Log shape should include:

event

org_id if present

channel if present

execution_task_id if present

reason

timestamp

9. Recommended Build Order

Claude Code should implement in this exact order:

Step 1 — Platform Kill Switch

Why first:

fastest safety win

easiest to deploy

lowest regression risk

Step 2 — Global Rate Limiter

Why second:

protects providers/platform before adding more operational complexity

Step 3 — Dead-Letter Queue

Why third:

ensures failed tasks are not lost once stricter controls are added

Step 4 — Provider Webhook Event Store

Why fourth:

improves replay/debug/audit while current channels are already active

Step 5 — Channel Health Monitor Automation

Why fifth:

observability layer on top of already stabilized flows

10. Testing Requirements

Claude Code must add or run tests for each hardening item.

Kill switch tests

global pause blocks all executors

channel-specific pause blocks only that channel

no token consumed when blocked

Rate limiter tests

org limit exceeded blocks send

platform limit exceeded blocks send

allowed requests increment counters atomically

DLQ tests

task exceeding retries moves to DLQ

audit row created

retry action restores execution path safely

Webhook store tests

duplicate provider_event_id does not process twice

unprocessed failure recorded when logic errors

processed flag set on success

Health monitor tests

failure-rate band maps to correct status

aggregation excludes inbound events

current-state table updates correctly

11. Definition of Done

This hardening plan is complete only when:

platform kill switch blocks execution at all required layers

rate limiter enforces org and platform quotas

failed tasks are visible in DLQ and recoverable

raw provider webhooks are stored before/while processing

channel health is computed automatically and visible

all changes have admin visibility where relevant

all safety events are logged/audited appropriately

12. Final Instruction to Claude Code

Implement the remaining institutional-grade hardening layer as an additive extension to the current platform.

Do not redesign existing working channel/order/credit architecture.

Implement the following, in order:

Platform Kill Switch

Global Rate Limiter

Dead-Letter Queue

Provider Webhook Event Store

Channel Health Monitor Automation

For each:

create schema

add backend enforcement

update admin UI

add audit/logging

add tests

Preserve all existing:

credit ledger rules

fallback policy logic

delivery_attempt logging

cancellation enforcement

channel capability gating

shared/dedicated sender behavior

This plan is the final remaining hardening layer needed to make the system institutional-grade within the architecture already built in this chat.