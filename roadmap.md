Below is Part 1 of an institutional-grade build specification you can give directly to Claude Code.
I will break the plan into multiple parts so it remains structured and readable.

Parts will be:

1️⃣ Product Vision + Functional Scope + Pricing Model
2️⃣ System Architecture + Services + Data Model
3️⃣ Automation Engines (Content, Image, Engagement)
4️⃣ Platform Integrations + API Handling
5️⃣ Dashboard UX + Analytics + ROI Tracking
6️⃣ Operational Safety + Rate Limits + Compliance
7️⃣ Deployment + Dev Plan + Claude Code Execution Order
8️⃣ Future Extensions (Video Marketplace + Virtual Models)

If something needs clarification, I will ask questions at the end.

PART 1
PRODUCT VISION, FEATURES, PRICING, AND USER FLOWS
1.1 Product Context

This system is an AI-powered Social Growth Engine integrated with the SaaS platform GetSalesCloser.

GetSalesCloser currently focuses on:

lead capture

instant response

follow-up automation

appointment booking

CRM pipeline

conversion tracking

The Growth Engine extends the platform into a full demand generation system.

New flow becomes:

Audience creation
↓
Content distribution
↓
Engagement automation
↓
Lead capture
↓
Lead response automation
↓
Appointment booking
↓
Sales conversion

The Growth Engine must therefore:

generate content

generate images

distribute posts

automate engagement

track analytics

connect social traffic to leads in GetSalesCloser

1.2 Core Modules

The Growth Engine must include seven core modules.

Module 1 — Brand Brain

Stores the structured marketing identity of a business.

Examples:

brand_name
product_positioning
target_audience
content_pillars
tone_of_voice
cta_rules
forbidden_claims
competitors
keywords

Purpose:

Ensure AI generated content remains brand consistent.

Module 2 — Topic Planner

Every day the system generates content ideas.

Categories:

educational
contrarian insights
founder story
sales psychology
case studies
objection handling
product positioning

Planner generates 8–12 ideas daily.

Then scores ideas based on:

relevance
engagement potential
novelty
alignment with brand pillars
Module 3 — Content Writer

Transforms ideas into platform-specific posts.

Examples:

LinkedIn:

hook
story
insight
soft CTA

X:

thread
short insight
comment-style thought

Facebook:

story + image caption

Instagram:

caption + carousel text
Module 4 — Image Generator

Creates visuals using template rendering.

Image types:

quote cards
carousel slides
insight graphics
statistics graphics

AI art generation should NOT be default.

Use templates with:

brand colors
logo
text layout
consistent typography
Module 5 — Publish Engine

Handles:

scheduling
posting
retries
rate limiting
queue management

Supports:

LinkedIn
X
Facebook Pages
Instagram Business

Reddit intentionally excluded in first release.

Module 6 — Engagement Engine

Handles automated engagement.

Functions:

scan relevant posts
generate replies
generate comments
respond to replies
suggest DM responses

Includes risk scoring before auto posting.

Module 7 — Analytics Engine

Collects performance data.

Metrics include:

impressions
likes
comments
shares
followers gained
engagement rate

Additionally integrates with GetSalesCloser:

click
lead captured
meeting booked
deal closed
revenue generated

This creates true ROI tracking.

1.3 Supported Platforms

Initial supported platforms:

LinkedIn
X
Facebook Pages
Instagram Business

Reddit intentionally excluded for launch.

1.4 Posting Modes

Each organization can choose posting behavior.

Mode 1 — Automation
AI generates content
↓
system publishes automatically
Mode 2 — Approval Workflow
AI generates content
↓
user reviews
↓
user approves
↓
system publishes
Mode 3 — Suggestion Only
AI generates drafts
↓
user copies manually
1.5 Free Tools (Inside Dashboard)

Purpose:

Allow users to experience AI before upgrading.

Free features include:

1 post generation per day
1 image generation per day

Restrictions:

maximum 15 generations per month
manual posting only

Once limit reached:

prompt user to upgrade to automation plan
1.6 Paid Plans (Content Automation)

Plans priced based on content pieces per day.

Important concept:

1 content piece
↓
generates variants for all connected platforms

Example:

1 idea
↓
LinkedIn post
↓
X thread
↓
Facebook post
↓
Instagram caption
Starter Plan

Price:

$199 / month

Includes:

1 content piece per day
platform distribution
image generation
automation toggle
analytics dashboard
Growth Plan

Price:

$299 / month

Includes:

2 content pieces per day
platform distribution
improved analytics
priority AI generation
Scale Plan

Price:

$399 / month

Includes:

3 content pieces per day
advanced analytics
priority processing
1.7 Engagement Automation Plans

Engagement defined as:

1 AI interaction
(comment OR reply OR conversation response)
Engagement Starter

Price:

$99 / month

Includes:

5 engagements per day
safe automation filters
engagement analytics

Monthly max:

150 engagements
Engagement Pro

Price:

$199 / month

Includes:

15 engagements per day
auto comments
auto replies
discussion participation
inbox assistant
engagement analytics

Monthly max:

450 engagements
1.8 Platform Distribution Logic

Users can connect multiple accounts.

Example:

LinkedIn
X
Instagram
Facebook

System automatically distributes posts.

Example:

1 content piece
↓
publish to all connected platforms

Internal logic ensures safe spacing.

1.9 Safety Limits

Maximum platform posting:

LinkedIn:

max 2 posts/day

X:

max 8 posts/day

Instagram:

max 2 posts/day

Facebook:

max 2 posts/day

Internal system cap:

5 content pieces/day
1.10 Engagement Safety

Daily engagement limits:

LinkedIn:

max 10 comments/day

X:

max 30 replies/day

Instagram:

max 10 comments/day

Risk scoring must prevent spam.

1.11 Engagement Targeting

Users define engagement sources:

industry hashtags
competitor accounts
influencers
keywords

The system engages only within those contexts.

1.12 Customer Dashboard

Growth Engine section inside GetSalesCloser UI.

Growth
├── Brand Profile
├── Connected Platforms
├── Content Ideas
├── Drafts
├── Content Calendar
├── Publish Queue
├── Engagement Center
└── Analytics
1.13 Analytics Dashboard

Display metrics:

Content:

posts published
impressions
engagement rate
top posts

Audience:

followers gained
profile visits

Business ROI:

social clicks
leads captured
meetings booked
deals closed
revenue generated
End of Part 1

Next message will contain:

PART 2 — System Architecture + Database Schema + Microservices + Worker Design
PART 2
SYSTEM ARCHITECTURE, DATABASE SCHEMA, MICROSERVICE DESIGN, AND EXECUTION MODEL
2.1 High-Level Architecture

The Growth Engine must be built as a separate microservice from the main GetSalesCloser backend.

Why

This system has a very different workload profile from:

lead routing

billing locks

execution tasks

org-channel messaging

appointment flows

The Growth Engine will handle:

content planning

AI generation

image rendering

scheduling

social publishing

engagement scanning

analytics polling

These concerns should not contaminate the core business-critical execution backend.

2.2 Final Architecture Decision
Main product boundary
GetSalesCloser Core
├── auth
├── orgs
├── billing
├── lead capture
├── execution engine
├── CRM / pipeline
└── growth bridge

Growth Engine Microservice
├── brand brain
├── planner
├── writer
├── image builder
├── publish engine
├── engagement engine
├── analytics collector
└── plan/quota enforcement
2.3 Database Strategy

Growth Engine should use a separate schema inside the existing Supabase/Postgres instance.

Recommended schema name
growth

This gives:

operational separation

easier ACL separation

easier migrations

easier debugging

easier future extraction to standalone service if needed

Core GetSalesCloser remains in public and related schemas.
Growth module tables live under growth.*.

2.4 Integration Boundary Between Core and Growth

The microservice must integrate with GetSalesCloser through a narrow boundary.

Read from Core

orgs

users/memberships

billing entitlement status

connected business metadata

lead attribution events

campaign landing pages / CTA destinations

Write back to Core

UTM / attribution signals

lead-source tagging

ROI summary data for dashboard

usage counters if billing is centralized

Do not couple directly with

execution task queue

message dispatch leasing

billing lock internals

voice/email executor logic

Use clear service/API boundaries.

2.5 Service Topology

Recommended components:

A. Growth API service

Handles:

dashboard requests

draft creation

settings update

channel connection flow

manual approvals

analytics summary endpoints

B. Growth worker service

Handles:

planner jobs

writer jobs

image build jobs

publish queue processing

analytics polling

engagement scanning

retries

C. Optional webhook receiver

Handles:

platform callback webhooks

post publish confirmations

token refresh callbacks

comment/reply events if supported

Initially A and B can be deployed together if needed, but code boundaries should still be separate.

2.6 Suggested Runtime Stack
Language
Python
API framework
FastAPI
DB access
SQLAlchemy or asyncpg/psycopg
Queue pattern
Postgres table-backed queue first
Scheduler
cron or APScheduler in worker
Image rendering
Pillow + template JSON definitions
HTTP client
httpx
Storage
Supabase Storage

This is enough for v1.

2.7 Directory Structure

Claude Code should scaffold the Growth Engine roughly like this:

growth_engine/
├── app/
│   ├── main.py
│   ├── config.py
│   ├── db.py
│   ├── auth_bridge.py
│   ├── entitlements.py
│   ├── quotas.py
│   ├── utils/
│   │   ├── time.py
│   │   ├── crypto.py
│   │   ├── ids.py
│   │   └── logging.py
│   ├── api/
│   │   ├── brand.py
│   │   ├── accounts.py
│   │   ├── ideas.py
│   │   ├── drafts.py
│   │   ├── queue.py
│   │   ├── approvals.py
│   │   ├── engagement.py
│   │   ├── analytics.py
│   │   └── settings.py
│   ├── services/
│   │   ├── brand_brain.py
│   │   ├── planner.py
│   │   ├── writer.py
│   │   ├── image_builder.py
│   │   ├── platform_router.py
│   │   ├── publish_service.py
│   │   ├── engagement_service.py
│   │   ├── analytics_service.py
│   │   ├── risk_scoring.py
│   │   └── attribution_service.py
│   ├── publisher/
│   │   ├── linkedin.py
│   │   ├── x.py
│   │   ├── facebook.py
│   │   └── instagram.py
│   ├── jobs/
│   │   ├── planner_job.py
│   │   ├── writer_job.py
│   │   ├── image_job.py
│   │   ├── publish_job.py
│   │   ├── metrics_job.py
│   │   └── engagement_job.py
│   ├── templates/
│   │   ├── quote_card/
│   │   ├── stat_card/
│   │   ├── carousel/
│   │   └── single_visual/
│   └── prompts/
│       ├── planner_prompts.py
│       ├── writer_prompts.py
│       ├── engagement_prompts.py
│       └── scoring_prompts.py
├── migrations/
├── tests/
└── README.md
2.8 Database Tables

All tables below should live in the growth schema.

2.8.1 growth.brand_profiles

Purpose: canonical brand identity for content generation.

Columns:

id uuid pk
org_id uuid not null
brand_name text not null
product_name text
positioning text
brand_summary text
tone_json jsonb
audience_json jsonb
offer_json jsonb
cta_rules_json jsonb
content_pillars_json jsonb
forbidden_claims_json jsonb
proof_points_json jsonb
keywords_json jsonb
competitors_json jsonb
landing_pages_json jsonb
default_timezone text
created_at timestamptz
updated_at timestamptz

Constraints:

unique on (org_id)

2.8.2 growth.social_accounts

Purpose: connected platform accounts.

Columns:

id uuid pk
org_id uuid not null
platform text not null
account_type text
platform_account_id text not null
display_name text
access_token_encrypted text not null
refresh_token_encrypted text
token_expires_at timestamptz
status text not null
meta_json jsonb
last_sync_at timestamptz
created_at timestamptz
updated_at timestamptz

Recommended unique:

(org_id, platform, platform_account_id)

Status values:

connected
disconnected
error
reauth_required
2.8.3 growth.org_growth_settings

Purpose: settings and operational mode per org.

Columns:

id uuid pk
org_id uuid not null
posting_mode text not null
approval_required boolean not null
daily_content_piece_limit integer not null
daily_engagement_limit integer not null
free_post_generations_used integer not null default 0
free_image_generations_used integer not null default 0
free_generation_period_month date
max_connected_platforms integer not null default 5
posting_windows_json jsonb
platform_distribution_json jsonb
engagement_targets_json jsonb
auto_engagement_enabled boolean not null default false
auto_safe_threshold numeric(5,4)
risk_block_threshold numeric(5,4)
timezone text not null
created_at timestamptz
updated_at timestamptz

Unique:

(org_id)

Posting mode values:

auto
approval
suggestion_only
2.8.4 growth.content_ideas

Purpose: raw idea pipeline.

Columns:

id uuid pk
org_id uuid not null
source text
pillar text
topic text not null
angle text
hook_seed text
score numeric(8,4)
status text not null
planned_for date
created_by text
created_at timestamptz
updated_at timestamptz

Status values:

generated
selected
drafted
queued
published
rejected
archived
2.8.5 growth.content_variants

Purpose: platform-specific content derived from an idea.

Columns:

id uuid pk
org_id uuid not null
idea_id uuid not null references growth.content_ideas(id)
platform text not null
format text not null
title_text text
body_text text
caption_text text
thread_json jsonb
carousel_json jsonb
hashtags_json jsonb
cta_text text
image_spec_json jsonb
status text not null
quality_score numeric(8,4)
created_at timestamptz
updated_at timestamptz

Format values:

post
thread
quote_card
carousel
image_caption
single_visual

Status values:

draft
approved
queued
published
failed
rejected
2.8.6 growth.content_assets

Purpose: rendered images and associated creative assets.

Columns:

id uuid pk
org_id uuid not null
variant_id uuid references growth.content_variants(id)
asset_type text not null
storage_path text not null
mime_type text not null
width integer
height integer
template_name text
meta_json jsonb
created_at timestamptz

Asset types:

quote_card
stat_card
carousel_slide
single_visual
thumbnail
2.8.7 growth.publish_queue

Purpose: canonical publishing queue.

Columns:

id uuid pk
org_id uuid not null
platform text not null
variant_id uuid not null references growth.content_variants(id)
asset_id uuid references growth.content_assets(id)
scheduled_for timestamptz not null
status text not null
attempt_count integer not null default 0
max_attempts integer not null default 5
locked_by text
locked_until timestamptz
last_error text
published_platform_id text
published_url text
idempotency_key text not null
created_at timestamptz
updated_at timestamptz

Status values:

pending
locked
scheduled
published
failed
blocked_quota
blocked_auth
blocked_approval
cancelled

Unique:

(idempotency_key)

2.8.8 growth.publish_logs

Purpose: audit trail of platform publish attempts.

Columns:

id uuid pk
queue_id uuid not null references growth.publish_queue(id)
org_id uuid not null
platform text not null
request_json jsonb
response_json jsonb
http_status integer
success boolean not null
created_at timestamptz
2.8.9 growth.engagement_targets

Purpose: what to scan and engage with.

Columns:

id uuid pk
org_id uuid not null
platform text not null
target_type text not null
target_identifier text not null
target_url text
priority integer not null default 100
status text not null
meta_json jsonb
created_at timestamptz
updated_at timestamptz

Target types:

keyword
hashtag
account
competitor
topic

Status:

active
paused
archived
2.8.10 growth.engagement_opportunities

Purpose: discovered candidate posts/comments worth engaging with.

Columns:

id uuid pk
org_id uuid not null
platform text not null
target_id uuid references growth.engagement_targets(id)
platform_object_id text not null
object_type text not null
author_handle text
object_url text
source_text text
relevance_score numeric(8,4)
priority_score numeric(8,4)
status text not null
created_at timestamptz
updated_at timestamptz

Object types:

post
comment
thread
mention
dm
2.8.11 growth.engagement_actions

Purpose: actual AI-generated engagement records.

Columns:

id uuid pk
org_id uuid not null
platform text not null
opportunity_id uuid references growth.engagement_opportunities(id)
action_type text not null
proposed_text text not null
posted_text text
confidence_score numeric(8,4)
risk_score numeric(8,4)
approval_status text not null
execution_status text not null
platform_action_id text
created_at timestamptz
approved_at timestamptz
posted_at timestamptz

Action types:

comment
reply
dm_reply
discussion_start

Approval status:

not_required
pending
approved
rejected

Execution status:

drafted
queued
posted
failed
cancelled
2.8.12 growth.platform_metrics_daily

Purpose: per-post daily metrics snapshots.

Columns:

id uuid pk
org_id uuid not null
platform text not null
platform_post_id text not null
variant_id uuid references growth.content_variants(id)
metric_date date not null
impressions integer
likes integer
comments integer
shares integer
clicks integer
saves integer
followers_delta integer
profile_visits integer
meta_json jsonb
created_at timestamptz

Unique:

(platform, platform_post_id, metric_date)

2.8.13 growth.social_roi_attribution

Purpose: business value attribution into GetSalesCloser outcomes.

Columns:

id uuid pk
org_id uuid not null
platform text not null
variant_id uuid references growth.content_variants(id)
platform_post_id text
utm_campaign text
utm_source text
utm_medium text
clicks integer
leads_created integer
meetings_booked integer
deals_closed integer
revenue_amount numeric(18,2)
currency text
attribution_window_days integer
created_at timestamptz
updated_at timestamptz
2.8.14 growth.plan_usage_daily

Purpose: enforce entitlements and pricing plan usage.

Columns:

id uuid pk
org_id uuid not null
usage_date date not null
content_pieces_generated integer not null default 0
content_pieces_published integer not null default 0
engagements_executed integer not null default 0
free_post_generations integer not null default 0
free_image_generations integer not null default 0
created_at timestamptz
updated_at timestamptz

Unique:

(org_id, usage_date)

2.9 Index Strategy

Claude Code should add indexes on:

growth.publish_queue(status, scheduled_for)

growth.publish_queue(locked_until)

growth.content_ideas(org_id, status, planned_for)

growth.content_variants(org_id, platform, status)

growth.engagement_opportunities(org_id, platform, status, priority_score desc)

growth.engagement_actions(org_id, platform, created_at desc)

growth.platform_metrics_daily(org_id, metric_date desc)

growth.plan_usage_daily(org_id, usage_date desc)

2.10 Quota Enforcement Model

Plan enforcement must be deterministic and auditable.

Rules
Free tools

1 post generation/day

1 image generation/day

hard stop after 15 total free generation days in a month

Starter

1 content piece/day

Growth

2 content pieces/day

Scale

3 content pieces/day

Engagement Starter

5 engagements/day

Engagement Pro

15 engagements/day

Usage should be checked through growth.plan_usage_daily.

2.11 Content Piece Definition

This is critical.

A content piece is a logical unit of content idea and its platform adaptations.

Example:

1 idea

1 LinkedIn version

1 X version

1 Facebook version

1 Instagram version

optional image variants

This still counts as 1 content piece, not 4 posts for billing purposes.

Internally the system may create multiple content_variants, but entitlement logic counts the source content piece.

2.12 Publishing Workflow State Machine
Draft lifecycle
idea generated
→ idea selected
→ platform variants drafted
→ assets rendered
→ queued
→ published
→ metrics collected
Publish queue lifecycle
pending
→ locked
→ published
or
→ failed
or
→ blocked_approval
or
→ blocked_auth
or
→ blocked_quota
2.13 Approval Workflow Model

If org mode = approval:

drafts are generated

publish queue rows are created with blocked_approval

user approval flips status to pending

If org mode = auto:

queue goes directly to pending

If org mode = suggestion_only:

content drafted but not queued for publishing

2.14 Multi-Tenant Separation

Every single table row must be associated with org_id.

The Growth Engine must treat org_id as the hard tenant boundary for:

content

assets

schedules

engagements

metrics

plan usage

This is non-negotiable.

2.15 Image Generation Decision
Chosen default

Template rendering.

Reason

For business content, template rendering gives:

brand consistency

lower cost

no per-image model charges

better readability

safer outputs

deterministic results

easier testing

Implementation

Use:

Pillow

JSON template configs

font/layout rules

safe overflow handling

brand palette

logo placement

text wrapping

Supported initial templates

quote card

stat card

5-slide carousel

single insight graphic

Optional later

Add AI-generated background art only as a decorative layer if needed.

2.16 API and Worker Separation
API endpoints should cover

brand settings CRUD

connect/disconnect accounts

generate idea now

generate draft now

approve draft

reject draft

queue view

publish history

analytics summary

engagement target CRUD

engagement approval queue

settings update

Worker jobs should cover

daily planning

daily drafting

image rendering

scheduled publish processing

nightly analytics polling

engagement scanning every N hours

2.17 Suggested Cron / Schedule

Initial schedule:

07:30 planner job
08:00 writer job
08:20 image rendering job
Every 15 min publish queue worker
Every 2 hours engagement scanning job
22:30 nightly metrics job
23:00 scoring/learning job

Timezone should be org-aware.

2.18 Logging and Auditability

This must be institutional-grade.

Log:

every publish attempt

every token refresh

every failed auth

every engagement action drafted/posted

every quota block

every approval action

every metrics sync failure

Need enough evidence for debugging and customer support.

END OF PART 2

Next is:

PART 3
CONTENT ENGINE, WRITER SYSTEM, IMAGE SYSTEM, AND ENGAGEMENT AUTOMATION LOGIC

I’ll continue directly.

PART 3
CONTENT GENERATION, WRITING SYSTEM, IMAGE PIPELINE, AND ENGAGEMENT ENGINE
3.1 Content Philosophy

This product must not produce generic “AI slop.”

Content quality must feel:

founder-led

sharp

insight-heavy

business-relevant

conversion-aware

Avoid clichés and filler.

Hard ban phrases

The quality filter should reject content with phrases like:

“in today’s fast-paced world”

“game changer”

“unlock your potential”

“revolutionize your business”

“take your business to the next level”

These are low-trust SaaS clichés.

3.2 Content Pillars

Every idea must map to one of the approved pillars.

Default pillars for GetSalesCloser and similar B2B customers:

founder_journey
sales_psychology
speed_to_lead
automation_roi
objection_handling
case_study_style
market_contrarian
educational_framework

Each org can customize, but the engine should require explicit pillars.

3.3 Topic Planner Logic

Daily planner generates 8–12 ideas.

Recommended mix:

3 educational

2 contrarian

2 founder-story

2 ROI / proof

1 CTA-oriented

1 objection handling

1 industry-specific

Each idea gets:

topic

angle

pillar

hook seed

score

Planner inputs

brand profile

recent top-performing topics

content pillars

connected platforms

recent post history to avoid repetition

optional campaign priority

Planner outputs

Stored in growth.content_ideas.

3.4 Writer System

The writer must create platform-specific variants, not the same text copy-pasted everywhere.

LinkedIn style

Structure:

hook

short narrative

insight

takeaway

soft CTA

X style

Structure:

contrarian take

thread or short post

sharper language

more compact syntax

Facebook style

Structure:

conversational

slightly broader readability

visual-friendly captions

Instagram style

Structure:

caption

image/carousel aligned

short, punchy, visually complementary

3.5 Platform Variant Rules

Each content idea may produce:

LinkedIn

1 long-form post

X

1 short post or 1 thread

Facebook

1 post with caption + image if relevant

Instagram

1 caption + quote card/carousel

This should be configurable.

3.6 Quality Scoring

Before anything is queued, score each variant on:

clarity

novelty

platform fit

CTA quality

non-genericness

readability

repetition vs last 14 days

Store in quality_score.

If below threshold:

regenerate or route to approval/manual review

3.7 Content De-Duplication

System must avoid:

same hook repeated too often

same stat repeated too often

same CTA overuse

same idea too soon

Maintain a similarity check against last 30 days of published content per org.

3.8 CTA Rules

CTA must be configurable by org.

Examples:

book a demo

visit landing page

download guide

follow for insights

comment a keyword

message us

Each post does not need a CTA, but promotional balance should be controlled.

Default ratio:

80% value

20% direct CTA

3.9 Image Builder

Image engine uses deterministic templates.

Template set v1

quote_card

stat_card

carousel_5

single_visual

Template inputs

brand palette

logo

headline

supporting text

footer/CTA

optional icon/shape pack

Rendering rules

safe text wrapping

dynamic font scaling

overflow protection

consistent padding

mobile-readable text size

3.10 Carousel Rules

Carousel generation should:

create slide headlines

ensure narrative continuity

support 4–6 slides

end with a CTA or takeaway

Example:

Slide 1: hook

Slide 2: problem

Slide 3: insight

Slide 4: framework

Slide 5: takeaway / CTA

3.11 Engagement Engine

This engine is for discovering and acting on relevant opportunities.

Workflow

scan target sources

detect opportunities

rank by relevance

generate reply/comment

score confidence and risk

auto-post if allowed

otherwise send to approval queue

3.12 Engagement Definition

One engagement = one action:

comment

reply

discussion response

DM reply if later enabled

Plans

$99: 5 engagements/day

$199: 15 engagements/day

3.13 Engagement Safety Model

Each generated engagement gets:

confidence_score

risk_score

Rules

If:

confidence high

risk low

org auto-engagement enabled

daily cap available

then post automatically.

Else:

queue for review

Risk factors

repetitive text

inflammatory topic

uncertain sarcasm

regulatory claims

competitor attack language

weak contextual relevance

3.14 Engagement Source Model

Users define targets by:

keywords

hashtags

competitor handles

industry creators

brand-relevant accounts

Engine should only engage within declared target universe.

This prevents random spammy behavior.

3.15 Inbox Assistant

Keep initial implementation conservative.

Phase 1:

suggest replies only

Phase 2:

allow auto-safe replies if enabled

Do not make inbox fully autonomous on day 1.

3.16 Analytics Learning Loop

Nightly, the engine should score:

best hooks

best pillars

best platform formats

best CTA styles

weakest content categories

This feedback should influence the next day’s planner.

END OF PART 3

Next is:

PART 4
PLATFORM INTEGRATIONS, AUTH MODEL, API LIMITS, AND PUBLISHING ADAPTERS
PART 4
PLATFORM INTEGRATIONS, AUTH MODEL, PUBLISHING ADAPTERS, AND PLATFORM-SPECIFIC BEHAVIOR
4.1 Supported Platforms at Launch

LinkedIn

X

Facebook Pages

Instagram Business

No Reddit in first release.

4.2 Account Connection Model

Each org connects its own accounts via OAuth where platform permits.

Store encrypted credentials in growth.social_accounts.

Need token refresh support where applicable.

4.3 Publishing Adapter Pattern

Do not hardcode platform logic into the core service.

Use adapter classes:

BasePublisher
├── LinkedInPublisher
├── XPublisher
├── FacebookPublisher
└── InstagramPublisher

Each adapter handles:

auth headers

payload shape

media upload

publish

error parsing

metrics pull

4.4 Publish Service Responsibilities

The core publish service should:

fetch due queue items

acquire lock

check approval state

check entitlements

check platform auth health

route to correct adapter

persist result

update queue state

write publish log

4.5 Idempotency

Every queue item must carry a stable idempotency_key.

If a publish retry occurs, the system must not double-post.

This is institutional-grade mandatory behavior.

4.6 Posting Windows

Users may define allowed posting windows per timezone.

Example:

{
  "linkedin": ["09:00", "17:00"],
  "x": ["10:00", "14:00", "19:00"],
  "facebook": ["12:00"],
  "instagram": ["18:00"]
}

The scheduler should place queued posts into permitted windows only.

4.7 Platform-Safe Rate Guidance

Internal caps should be enforced regardless of plan.

LinkedIn

max 2 posts/day

max 10 engagement comments/day

X

max 8 posts/day

max 30 replies/day

Facebook

max 2 posts/day

Instagram

max 2 posts/day

max 10 comments/day

Plans may entitle content, but platform safety limits always win.

4.8 Error Categories

Adapters should normalize errors into categories:

auth_error
quota_error
rate_limited
invalid_payload
media_upload_failed
platform_rejected
temporary_network_error
unknown_error

This allows better retries and dashboard diagnostics.

4.9 Retry Policy

Recommended publish retry model:

transient network: retry

rate limit: retry later

auth failure: mark blocked_auth

invalid payload: mark failed

approval missing: blocked_approval

Backoff should be controlled.

4.10 Metrics Collection

Each adapter should also support metrics pull where available.

Metrics normalized into:

impressions

likes

comments

shares

clicks

saves

followers_delta

profile_visits where possible

Not every platform exposes every metric. Missing values should remain nullable.

END OF PART 4

Next is:

PART 5
DASHBOARD UX, ROI ANALYTICS, ENTITLEMENTS, AND CUSTOMER EXPERIENCE
PART 5
DASHBOARD UX, ROI ANALYTICS, PLAN ENTITLEMENTS, AND CUSTOMER EXPERIENCE
5.1 Dashboard Placement

Inside GetSalesCloser admin, add new top-level navigation:

Growth

Sections:

Overview

Brand Profile

Accounts

Ideas

Drafts

Calendar

Queue

Engagement

Analytics

Settings

5.2 Overview Page

Must show:

today’s content scheduled

today’s engagement used / remaining

platform connection health

recent post performance

latest leads/revenue influenced by social

This page should immediately communicate value.

5.3 Free Tool Experience

Inside dashboard, provide:

“Generate post”

“Generate image”

Limits:

1 each per day

max 15 active days/month

manual copy/download only

Show meter:

used this month

days remaining

Do not hide the value. Let users feel the product.

5.4 Draft Experience

For each draft show:

content idea

platform variants

asset preview

quality score

suggested posting time

CTA target

Actions:

approve

reject

edit

queue now

save for later

5.5 Calendar View

Users need a monthly/weekly content calendar.

Show:

scheduled posts

approved drafts

pending approval

failed posts

top-performing dates

5.6 Engagement Center

Show:

opportunities found

suggested replies

auto-posted engagements

queued for approval

performance summary

remaining daily cap

For trust, make automation transparent.

5.7 Analytics Design
Layer 1: Social performance

posts published

impressions

likes

comments

shares

follower growth

Layer 2: Engagement performance

engagements executed

profile visits

response rate

discussion starts

Layer 3: Business ROI

social clicks

leads generated

meetings booked

deals closed

revenue influenced

This third layer is your differentiator.

5.8 ROI Attribution Model

Every published post should attach:

utm_source

utm_medium

utm_campaign

org-specific landing page

When traffic enters GetSalesCloser:

preserve attribution

connect lead to source post/variant where possible

Then roll up into growth.social_roi_attribution.

5.9 Customer Messaging / Pricing UX

Do not present upgrades as “you hit a restriction.”

Present them as:

automate more

publish more often

engage more conversations

unlock more reach

This keeps the product from feeling extractive.

5.10 Entitlement Enforcement UX

When blocked:

explain why

show current plan

show what unlocks on upgrade

Examples:

“Today’s content limit reached on Starter”

“Free manual generation available on 15 days/month”

“Auto engagement quota used for today”

END OF PART 5

Next is:

PART 6
OPERATIONAL SAFETY, LOGGING, TESTING, AND INSTITUTIONAL-GRADE HARDENING
PART 6
OPERATIONAL SAFETY, LOGGING, TESTING, FAILURE HANDLING, AND HARDENING
6.1 Safety Principles

This system must be:

multi-tenant safe

quota-safe

idempotent

retry-safe

auditable

explainable to support staff

6.2 Hard Requirements
Must have

idempotent publishing

deterministic quota checks

encrypted tokens

approval state enforcement

tenant isolation

per-platform rate caps

queue locking

publish logs

metrics logs

engagement risk scoring

Must not

double-post on retry

exceed plan quotas

exceed platform caps

allow one org to see another org’s content

auto-engage in undefined target areas

6.3 Locking Model

growth.publish_queue must support leasing:

claim item

set locked_by

set locked_until

complete or release

This prevents duplicate worker execution.

6.4 Support Diagnostics

Need admin-visible diagnostics for:

last token refresh failure

last publish error by platform

queue stuck items

approval backlog

auth re-connect needed

daily quota usage

engagement action failures

6.5 Testing Requirements

Claude Code should create tests for:

entitlement checks

content piece counting

publish queue locking

idempotency

blocked approval behavior

blocked auth behavior

plan usage increments

engagement quota counting

posting mode transitions

image rendering output existence

6.6 Observability

Log structured events:

planner_run_started / completed

writer_run_started / completed

image_render_started / completed

publish_attempt

publish_success

publish_failure

token_refresh_failure

engagement_drafted

engagement_posted

engagement_blocked

metrics_sync_completed

6.7 Migration Discipline

All schema changes under:

growth schema migrations

Do not intermingle with core billing/execution migrations.

END OF PART 6

Next is:

PART 7
CLAUDE CODE EXECUTION PLAN, PHASE ORDER, AND BUILD ROADMAP
PART 7
CLAUDE CODE EXECUTION PLAN, PHASES, IMPLEMENTATION ORDER, AND DELIVERY STRATEGY
7.1 Build Principle

Claude Code should not freeform this project.

It should build in strict phases.

7.2 Phase 1 — Schema + Core Skeleton

Build:

growth schema migrations

all tables

indexes

basic FastAPI app

DB connection layer

config

auth bridge

entitlements module

quotas module

Deliverable:

service boots

schema applied

CRUD for brand profile/settings works

7.3 Phase 2 — Brand + Planner + Writer

Build:

brand profile CRUD

topic planner

content writer

content quality scoring

draft storage

Deliverable:

API can generate ideas and drafts for an org

7.4 Phase 3 — Image Builder

Build:

template system

quote card rendering

stat card rendering

carousel rendering

asset persistence to storage

Deliverable:

drafts can produce visual assets

7.5 Phase 4 — Publish Queue + Adapters

Build:

queue writer

lease/lock processing

publish service

platform adapters

publish logs

retry policy

Deliverable:

end-to-end publishing works for at least one platform, then all four

7.6 Phase 5 — Approval Mode + Auto Mode

Build:

posting mode handling

approval endpoints

blocked_approval lifecycle

suggestion_only behavior

Deliverable:

org can switch between modes and behavior changes correctly

7.7 Phase 6 — Engagement Engine

Build:

engagement targets CRUD

opportunity discovery skeleton

suggestion generation

risk/confidence scoring

daily cap enforcement

auto-post vs approval behavior

Deliverable:

engagement plan works with $99/$199 caps

7.8 Phase 7 — Analytics + ROI

Build:

metrics polling

normalized metrics tables

attribution bridge

dashboard summaries

Deliverable:

users can see performance and business ROI

7.9 Phase 8 — Dashboard Wiring

Build UI surfaces for:

brand

ideas

drafts

queue

approvals

engagement

analytics

settings

Deliverable:

usable customer-facing workflow

7.10 Phase 9 — Hardening

Build:

tests

stuck queue handling

auth failure diagnostics

better error messages

reauth flows

audit summaries

Deliverable:

internal launch-ready v1

7.11 Estimated Timeline
Fast MVP

2–3 days

Solid internal v1

4–6 days

Multi-tenant customer rollout grade

10–15 days

Given your current clarity, Claude Code should target the 4–6 day solid v1 path first.

7.12 What Claude Code Must Not Assume

It must not invent:

plan definitions

quota semantics

posting mode semantics

content piece billing semantics

platform expansion beyond defined scope

video workflows in current version

Those are already decided here.

END OF PART 7

Next is the final optional roadmap section.

PART 8
FUTURE EXTENSION: VIDEO CONTENT MARKETPLACE / MODEL HIRING LAYER
8.1 This is not in v1

Do not build now.

This is a future expansion after:

product-market fit

at least 500 customers

stable recurring revenue

strong trust in Growth Engine

8.2 Future idea summary

Users will be able to create video content by selecting:

real model

virtual model

Real model workflow

browse model catalog

preview short clips

see per-video pricing

choose model

pay

assigned model records content

uploads video

system posts on user’s behalf

Virtual model workflow

browse avatar catalog

choose avatar

choose voice/style

generate scripted video

system publishes

8.3 Why this is powerful

This turns Growth Engine into:

automation software

content production service

creator marketplace

But it adds major operational complexity, so it is explicitly deferred.

FINAL IMPLEMENTATION DECISIONS LOCKED

Claude Code should assume the following are final unless changed later:

Growth Engine is a separate microservice

It uses a separate growth schema

Initial platforms are LinkedIn, X, Facebook, Instagram

No Reddit in v1

No video in v1

Images are template-rendered, not primarily AI-generated

Free dashboard tools:

1 post generation/day

1 image generation/day

up to 15 days/month

manual only

Paid posting plans:

$199 = 1 content piece/day

$299 = 2 content pieces/day

$399 = 3 content pieces/day

One content piece distributes platform variants to all connected platforms

Engagement plans:

$99 = 5 engagements/day

$199 = 15 engagements/day

Posting modes:

auto

approval

suggestion_only

Analytics must include business ROI, not just vanity metrics
GETSALESCLOSER GROWTH ENGINE
FINAL FREEZE-GRADE BUILD SPEC FOR CLAUDE CODE
0. Mission

Build a multi-tenant AI Social Growth Engine as a separate microservice integrated with GetSalesCloser.

This module must let organizations:

generate branded social content

generate branded images

schedule and publish posts

run automated or approval-based workflows

run engagement automation within strict caps

view social analytics

view business ROI from social activity

This is a customer-facing product module, not an internal-only tool.

It must be architected for:

multi-tenancy from day 1

plan enforcement from day 1

future activation of X with zero code changes

future expansion into video workflows

clean separation from the core lead/billing/execution backend

1. LOCKED PRODUCT DECISIONS
1.1 Service boundary

The Growth Engine must run as a separate microservice.

It must not be merged into the main GetSalesCloser execution backend.

1.2 Database strategy

Use a separate schema inside the existing Supabase/Postgres project.

Locked schema name
growth

All new growth-related tables, views, functions, and indexes must live inside growth.*.

Do not mix Growth Engine tables into public unless absolutely necessary for bridge views/functions.

1.3 Multi-tenancy

This system must be fully multi-tenant from day 1.

Every tenant boundary is enforced via:

org_id

Every growth row must belong to an org_id.

No shortcuts for “my own brand first.”
The architecture must be customer-rollout ready now.

1.4 Supported platforms in v1
Active in v1

LinkedIn

Facebook Page

Instagram Business / Creator (via Meta)

Designed but inactive in v1

X

Explicitly excluded from v1

Reddit

YouTube / video workflows

1.5 X decision

The full X system must be architected now, but inactive by configuration.

Meaning:

complete adapter structure should exist

complete DB support should exist

feature flags should exist

dashboard can show “coming soon” or disabled state

enabling X later should require:

env/config activation

credentials setup

no code changes

no schema changes

This is mandatory.

1.6 Meta connection behavior
Backend behavior

Facebook and Instagram must be treated as a bundled Meta connection in background logic.

One Meta OAuth/session/token path should support both.

Frontend behavior

The user must feel like they are connecting them separately.

Meaning:

UI can show separate cards:

Connect Facebook

Connect Instagram

but backend may resolve both through one Meta connection model

The illusion of separate connection is a UX requirement.
The implementation efficiency of bundled backend handling is a technical requirement.

1.7 Draft editing

AI-generated drafts must be fully editable by the user before publishing.

Not limited to:

title

body

CTA

Instead user must be allowed to freely edit:

full post text

captions

thread text

carousel text

CTA

hashtags

image text blocks if applicable

System must preserve edited versions as the publishable source of truth.

1.8 Image strategy

Use template rendering as the primary image engine.

Do not make raw AI art the default

Reason:

more cost-effective

more brand-consistent

more readable

more trustworthy for B2B content

easier to control quality

Use:

Pillow

layout templates

brand colors

logo

text rules

carousel rendering

quote/stat card rendering

Optional future support for AI-generated decorative backgrounds can be added later, but not required in v1.

2. PRODUCT SCOPE
2.1 What this module must do

The system must support:

A. Brand setup

Store per-org marketing identity.

B. Content planning

Generate content ideas daily.

C. Content writing

Create platform-specific text variants.

D. Image generation

Create quote cards, stat cards, carousel slides, and similar branded assets.

E. Publishing

Schedule and publish to connected platforms.

F. Approval workflow

Allow orgs to choose:

auto publishing

approval-first publishing

suggestion-only mode

G. Engagement automation

Generate and optionally post comments/replies within plan caps.

H. Analytics

Show platform performance and business ROI.

2.2 What is explicitly out of scope in v1

Do not build these now:

video generation

video posting marketplace

real/virtual spokesperson workflows

Reddit integration

YouTube integration

TikTok

advanced inbox autonomy

white-label agency portal

cross-org team workspaces beyond basic multi-tenant readiness

These can be future phases.

3. PLAN / PRICING MODEL TO ENFORCE
3.1 Free dashboard tools

These are freemium manual-generation tools inside the dashboard.

Free limits

1 post generation per day

1 image generation per day

manual copy/download only

no automated posting

no scheduling

no engagement automation

Monthly restriction

If user keeps using the free generator repeatedly:

allow usage on a maximum of 15 days per month

then stop further free generation until next monthly cycle

This means:

not 15 posts total

but effectively 15 active days/month of free generation usage

The system must track this deterministically.

3.2 Paid posting plans
Starter
$199/month

Includes:

1 content piece per day

platform distribution to all active connected platforms

image generation

analytics

posting mode toggle support

Growth
$299/month

Includes:

2 content pieces per day

same distribution model

improved analytics

priority generation

Scale
$399/month

Includes:

3 content pieces per day

same distribution model

advanced analytics

priority processing

3.3 Content piece definition

This is a locked billing rule.

One content piece means:

one logical idea that can produce multiple platform variants.

Example:

1 idea

LinkedIn post

Facebook post

Instagram caption

image variant(s)

That still counts as 1 content piece for plan usage.

The system must never count each platform variant as a separate billable piece.

3.4 Engagement plans
Engagement Starter
$99/month

Includes:

5 engagements/day

Engagement Pro
$199/month

Includes:

15 engagements/day

Engagement definition

One engagement = one AI interaction, such as:

one comment

one reply

one discussion response

future DM reply if enabled later

System must track this per org per day.

4. POSTING / ENGAGEMENT MODES
4.1 Posting modes

Per org, support three modes:

auto

AI generates and publishes automatically

approval

AI generates, user reviews/edits/approves, then system publishes

suggestion_only

AI generates drafts only, no scheduling/publishing

These are locked requirements.

4.2 Engagement behavior

Engagement actions should support:

auto-safe mode when allowed

approval-based mode when risk is higher

strict daily cap enforcement

5. PLATFORM STRATEGY
5.1 LinkedIn

Fully active in v1.

Must support:

publishing

comments/replies where feasible in architecture

metrics collection

approval mode

auto mode

5.2 Meta

Meta is active in v1 through:

Facebook Page

Instagram Business / Creator

Important

Backend token/account architecture should be Meta-bundled
but UI should present separate user-facing connection flows/cards.

5.3 X

Architect everything, ship disabled.

Requirements

database support exists

publisher adapter exists

metrics adapter stubs/support exists

UI card exists in disabled/inactive state

feature flag controls activation

when activated later, code changes should not be needed

6. HIGH-LEVEL SYSTEM ARCHITECTURE
6.1 Service topology
Growth API service

Handles:

brand settings

account connection views/state

draft generation endpoints

manual draft editing

approvals

queue inspection

analytics endpoints

engagement target management

Growth worker service

Handles:

planner jobs

writer jobs

image render jobs

publish queue processing

metrics sync

engagement scanning

engagement execution

retries

quota updates

Optional webhook receiver

Can be same service initially, but separate module boundary for:

platform callbacks

token refresh callbacks

publish callbacks

comment/reply callbacks if needed later

6.2 Tech stack

Use:

Python

FastAPI

Postgres/Supabase

Supabase Storage

Pillow

httpx

cron or APScheduler

SQLAlchemy or equivalent robust DB access layer

7. DATABASE DESIGN

All tables must live in growth schema.

Claude Code should implement, at minimum:

growth.brand_profiles

growth.social_accounts

growth.org_growth_settings

growth.content_ideas

growth.content_variants

growth.content_assets

growth.publish_queue

growth.publish_logs

growth.engagement_targets

growth.engagement_opportunities

growth.engagement_actions

growth.platform_metrics_daily

growth.social_roi_attribution

growth.plan_usage_daily

Use the previously defined detailed shapes as the baseline.

Additional note

The schema should preserve enough flexibility for:

disabled X rows existing without active use

Meta-bundled backend relationships

user-edited draft persistence

8. META ACCOUNT MODEL
8.1 Backend requirement

Store Meta connection in a way that one backend auth/token relationship can support:

Facebook Page posting

Instagram publishing

8.2 Frontend requirement

Even though backend is bundled, UI should behave as if user connects separately.

UX behavior

User may see:

“Connect Facebook”

“Connect Instagram”

The frontend should still be able to show:

connected

not connected

partially connected

reconnect needed

But backend may internally map both to one Meta connection session/token.

9. X FEATURE-FLAG DESIGN

This is critical.

9.1 Code architecture requirement

All X-related code must exist, but all runtime behavior must be controlled by config/env/feature flags.

Example design
FEATURE_X_ENABLED=false
When false

no X publishing jobs execute

no X metrics polling executes

UI may show disabled/coming-soon state

no errors should occur from the absence of X credentials

When true later

only configuration/env changes should be needed

no DB migration

no code patch

no structural rewrite

This must be tested.

10. CONTENT GENERATION SYSTEM
10.1 Brand Brain

Each org must have a structured brand profile including:

brand name

product name

positioning

audience

tone

content pillars

CTA rules

forbidden claims

proof points

landing pages

keywords

competitors

This drives planner and writer behavior.

10.2 Planner

Daily planner generates 8–12 content ideas using categories like:

educational

contrarian insight

founder story

ROI/proof

objection handling

product positioning

market commentary

Each idea gets:

topic

angle

pillar

hook seed

score

10.3 Writer

Writer must produce platform-specific variants.

Do not clone the same copy across platforms.

LinkedIn

Hook + narrative + insight + soft CTA

Facebook

Broader conversational caption

Instagram

Caption aligned with image/carousel

X

Fully architected but inactive

10.4 Quality controls

Content should be rejected or regenerated if:

overly generic

repetitive

cliché-heavy

too similar to recent posts

weak platform fit

Include non-genericness filtering.

11. IMAGE SYSTEM
11.1 Required template types

Implement at least:

quote card

stat card

carousel

single insight visual

11.2 Requirements

Images must support:

brand colors

logo

dynamic text wrapping

readable typography

export to storage

linking to specific content variant

11.3 Editable source

If users edit visual text, store the edited text as part of the variant/asset spec.

12. DRAFT EDITING MODEL

This is locked: full editing must be allowed.

User should be able to edit:

full body text

headline/title

CTA

captions

hashtag sets

carousel slide text

image quote/stat text

The system should preserve both:

AI-generated original

user-edited publishable version

Recommended approach:

store original AI output in structured JSON/meta

store edited version as active publish version

13. PUBLISHING WORKFLOW
13.1 Queue-driven model

Publishing must be handled through a queue table with:

lock leasing

idempotency

retries

status transitions

logs

13.2 Status support

Need statuses like:

pending

locked

blocked_approval

blocked_auth

blocked_quota

published

failed

cancelled

13.3 Idempotency

Mandatory. No duplicate post on retry.

14. QUOTA / ENTITLEMENT ENFORCEMENT
14.1 Daily content quota

Per org per day:

Starter = 1 content piece

Growth = 2

Scale = 3

14.2 Daily engagement quota

Per org per day:

$99 engagement = 5

$199 engagement = 15

14.3 Free usage limits

Track free usage by month and by active day.

Need deterministic enforcement so users cannot bypass it.

15. ANALYTICS + ROI
15.1 Social metrics

Track:

posts published

impressions

likes

comments

shares

clicks

profile visits

follower growth where available

15.2 Business ROI

Integrate with GetSalesCloser attribution model.

Need to show:

social clicks

leads created

meetings booked

deals closed

revenue influenced

This is one of the core differentiators and cannot be treated as optional fluff.

16. DASHBOARD REQUIREMENTS

Growth section inside GetSalesCloser should include:

Overview

Brand Profile

Accounts

Ideas

Drafts

Calendar

Queue

Engagement

Analytics

Settings

16.1 Dashboard expectations

Must be customer-facing, not just admin-dev tooling.

16.2 UX expectations

Show upgrade value without feeling exploitative.

For free users:

let them experience real generation

limit usage gracefully

make upgrade message outcome-based

17. SAFETY / HARDENING
17.1 Multi-tenant safety

Every action must be scoped by org_id.

17.2 Publishing safety

Need:

queue lock leasing

auth failure handling

quota blocks

idempotency

publish logs

retry policy

17.3 Engagement safety

Need:

confidence score

risk score

auto-safe thresholds

approval fallback

no random global engagement outside declared targets

17.4 Platform caps

Even if user has quota left, internal safe platform caps should still apply.

18. BUILD PHASE ORDER FOR CLAUDE CODE

Claude Code must build in this order:

Phase 1

Schema + migrations + base service skeleton + settings/brand CRUD

Phase 2

Planner + writer + draft storage + quality scoring

Phase 3

Image rendering engine + asset persistence

Phase 4

Publish queue + LinkedIn + Meta adapters + logs + retries

Phase 5

Approval mode + auto mode + suggestion-only mode

Phase 6

Engagement targets + opportunities + engagement execution + plan caps

Phase 7

Analytics + ROI attribution + dashboard summaries

Phase 8

X full architecture behind feature flag, fully dormant but activatable without code changes

Phase 9

Hardening, testing, diagnostics, stuck queue handling, support visibility

19. TESTING REQUIREMENTS

Claude Code should include tests for:

quota counting

content piece counting logic

free generation day-limit logic

approval mode behavior

suggestion-only behavior

auto mode behavior

idempotent publish behavior

locked queue behavior

Meta-bundled backend + separate-feeling frontend state model

X disabled feature-flag path

X future activation path without code changes

full draft editing persistence

multi-tenant isolation

engagement quota enforcement

20. FUTURE PHASE NOTE

Do not implement now, but keep the system extensible for:

video marketplace

real spokesperson catalog

virtual avatar spokespersons

upload-to-drive workflow

post-on-user’s-behalf video content

This is future phase after significant customer base growth.

21. NON-NEGOTIABLE IMPLEMENTATION PRINCIPLES

Claude Code must follow these principles:

Do not hardcode single-tenant assumptions

Do not put growth tables in public unless bridge-only

Do not make X required for launch

Do not make Meta UX obviously bundled in the frontend

Do not restrict editing to partial fields

Do not count each platform variant as a billable content piece

Do not default to raw AI image art

Do not tightly couple this microservice to core execution/billing internals

Do not require later code changes to activate X

Do not ship without audit logs and deterministic quota controls

22. FINAL DELIVERY EXPECTATION FROM CLAUDE CODE

Claude Code should produce:

complete schema migrations

complete backend microservice

queue processing

image rendering system

LinkedIn + Meta v1 integrations

X dormant integration behind feature flag

analytics subsystem

multi-tenant dashboard-supporting APIs

tests

documentation / run instructions

This should be treated as a production-oriented, customer-rollout-capable module, not a prototype.
FINAL ADDENDUM
FREE TIER GENERATION RULES (LOCKED)

This section overrides any previous ambiguous wording about free-tier usage.

1. Free Generation Actions

Free users inside the dashboard can perform two manual AI actions:

Post Generation
Image Generation

These are manual tools only. They do not publish automatically.

They allow the user to:

generate post text
generate branded image
copy or download the result
post manually
2. Daily Free Generation Limits

Free users may perform only ONE generation per day.

Allowed actions:

1 post generation
OR
1 image generation

Not both.

Example:

User generates a post today
→ image generation disabled for the rest of that day

OR

User generates an image today
→ post generation disabled for the rest of that day
3. Monthly Free Usage Limit

Free usage is capped by active generation days per month.

Maximum:

15 active generation days per month

Important:

The system counts days used, not number of items generated.

Example
Day 1

User generates:

post

This counts as:

1 active generation day
Day 2

User generates:

image

This counts as:

another active generation day
Day 3

User generates nothing.

no usage recorded
After 15 used days

System blocks generation until the next monthly cycle.

Show upgrade prompt.

4. Database Enforcement

Quota should be enforced through:

growth.plan_usage_daily

Relevant fields:

org_id
usage_date
free_post_generations
free_image_generations

But the day cap must also be enforced.

Recommended logic:

if free_post_generations > 0 OR free_image_generations > 0
then this day counts toward the 15-day limit

Additionally track:

free_generation_day_used boolean

or compute it dynamically.

5. Enforcement Logic

When a user attempts free generation:

Step 1

Check if today already has a generation.

free_post_generations > 0
OR
free_image_generations > 0

If yes:

reject request

Return message:

Daily free generation already used.
Try again tomorrow.
Step 2

Check monthly active day count.

count(days_used_this_month)

If >= 15:

reject request

Return message:

Free generation limit reached for this month.
Upgrade to automate posting.
6. UX Behavior

Dashboard should show a meter:

Free Generations Used This Month
[██████████░░░░░]
10 / 15 days used

When close to limit (12+ days):

Display message:

You are approaching the free generation limit.
Upgrade to automate posting and remove manual limits.
7. Reason for This Design

This model is intentional.

It prevents users from:

using AI every day indefinitely without paying

while still allowing them to experience the product meaningfully.

Users who repeatedly return for manual generation will:

hit the 15-day cap
→ upgrade

This is a proven SaaS conversion model.

FINAL STATUS

The Growth Engine architecture specification is now fully complete and internally consistent.

You can safely give the entire document to Claude Code to implement.

It defines:

product behavior
pricing logic
platform integration model
database schema
queue design
quota system
engagement automation
image rendering strategy
analytics model
multi-tenant architecture
feature flags
future extensibility

No critical ambiguity remains.

One honest observation before you start building

Your system is now effectively becoming:

GetSalesCloser
+
AI Social Growth Engine
+
AI Engagement Bot

That combination is very powerful.

Most SaaS tools do only one of these three.

If implemented correctly, you will have:

lead capture
lead response
appointment booking
social audience growth
content automation
engagement automation
ROI attribution

That is a full revenue pipeline, not just a CRM.
AI PROMPT ARCHITECTURE FOR VIRAL B2B SAAS CONTENT

This should not be one giant prompt.

Claude Code should implement it as a prompt stack with separate stages:

Brand Context Prompt

Topic Planner Prompt

Angle Generator Prompt

Hook Generator Prompt

Platform Writer Prompts

Quality Critic Prompt

Regeneration Prompt

Engagement Reply Prompt

Learning/Optimization Prompt

That layered design is what keeps outputs from becoming stale and generic.

1. CORE PRINCIPLE

The system must never ask the model to simply:

“Write a viral post about X”

That produces garbage.

Instead, the model must be given:

who the brand is

who the audience is

what the post is trying to achieve

what content pillar it belongs to

what tone is allowed

what phrases are forbidden

what platform-specific structure is required

2. MASTER BRAND CONTEXT PROMPT

This is the permanent base prompt assembled from growth.brand_profiles.

Purpose

Inject brand truth into every downstream generation.

Template
You are the content brain for a B2B SaaS brand.

Your job is to create sharp, credible, high-signal social media content for business owners, operators, and decision-makers.

BRAND PROFILE
Brand name: {brand_name}
Product name: {product_name}
Positioning: {positioning}
Brand summary: {brand_summary}

TARGET AUDIENCE
{audience_json_rendered}

OFFER
{offer_json_rendered}

CONTENT PILLARS
{content_pillars_rendered}

TONE
- authoritative
- practical
- commercially sharp
- intelligent
- founder-level
- not hypey
- not spammy
- not cringe

PROOF POINTS
{proof_points_rendered}

CTA RULES
{cta_rules_rendered}

FORBIDDEN CLAIMS
{forbidden_claims_rendered}

KEYWORDS / THEMES
{keywords_rendered}

COMPETITORS / ALTERNATIVES
{competitors_rendered}

WRITING RULES
- Prefer strong observations over generic advice.
- Prefer tension, contrast, and insight over motivational fluff.
- Sound like an operator who understands revenue, not a content marketer chasing likes.
- Keep ideas specific, commercially relevant, and believable.
- Use concrete patterns, not vague generalities.
- Avoid cliché SaaS phrases.
- Do not sound like corporate marketing copy.
- Do not use “in today’s fast-paced world”, “game changer”, “unlock”, “revolutionize”, “next level”, or similar filler.
- Do not write empty inspiration.
- Do not write broad textbook explanations unless explicitly requested.
- Posts should feel native to the platform and credible to experienced buyers.

This prompt should be prepended or injected into downstream tasks.

3. TOPIC PLANNER PROMPT
Goal

Generate high-potential topics, not finished posts.

Input

brand context

recent top-performing topics

recent last 30 days topics

target platform mix

optional campaign priorities

Output

Structured JSON only.

Prompt
Using the brand context provided, generate 12 social content ideas for a B2B SaaS company.

Requirements:
- Focus on business buyers, founders, agency owners, and operators.
- Prioritize ideas that create authority, curiosity, and commercial relevance.
- Use these categories:
  3 educational
  2 contrarian
  2 founder-story
  2 ROI/proof
  1 objection-handling
  1 market commentary
  1 product-positioning

For each idea return:
- pillar
- topic
- angle
- hook_seed
- why_it_matters
- likely_platform_fit
- novelty_score (1-10)
- credibility_score (1-10)
- engagement_potential_score (1-10)

Rules:
- Avoid repeating ideas too close to recent topics.
- Avoid motivational fluff.
- Avoid broad topics unless given a sharp angle.
- Prefer specific business tension, lost revenue, hidden failure points, or non-obvious operational insight.

Return valid JSON only.
4. ANGLE GENERATOR PROMPT

A topic is not enough. It needs an angle.

Purpose

Turn a broad topic into a tension-driven perspective.

Prompt
You are given a B2B SaaS content topic. Generate 5 distinct angles for turning it into a strong social media post.

TOPIC: {topic}
PILLAR: {pillar}
HOOK SEED: {hook_seed}

Generate angles of these types:
1. Contrarian
2. Founder/operator insight
3. Revenue-loss framing
4. Buyer psychology framing
5. Tactical framework framing

Rules:
- Each angle must feel specific and commercially relevant.
- Avoid generic education.
- Prefer tension, mistakes, asymmetry, hidden cost, or operator insight.
- The angle must be understandable within 2-3 sentences.

Return JSON:
[
  {
    "angle_type": "",
    "angle_title": "",
    "core_claim": "",
    "why_people_will_care": ""
  }
]
5. HOOK GENERATOR PROMPT

The hook matters more than almost anything else.

Goal

Generate multiple hook candidates from one chosen angle.

Prompt
Generate 12 hook options for a B2B SaaS social media post.

TOPIC: {topic}
ANGLE: {angle_title}
CORE CLAIM: {core_claim}
AUDIENCE: {audience_summary}

Hook rules:
- The hook must stop scrolling.
- It must sound intelligent, not sensationalist.
- It should create tension, surprise, or immediate relevance.
- It should not sound like a guru.
- Avoid obvious clickbait and exaggeration.
- Prefer concrete business pain, hidden truth, or sharp observation.

Create hook types across:
- direct contrarian
- revenue warning
- founder observation
- operational mistake
- myth-busting
- one-line punch

Do not use more than 18 words per hook.
Do not use emojis.
Do not use hashtags.

Return JSON array only.
6. LINKEDIN WRITER PROMPT

LinkedIn is your highest-value platform for GetSalesCloser.

Goal

Produce credible, founder-grade, high-signal LinkedIn posts.

Prompt
Write a LinkedIn post for a B2B SaaS audience.

INPUTS
Topic: {topic}
Angle: {angle_title}
Core claim: {core_claim}
Chosen hook: {hook}
CTA objective: {cta_objective}
Brand context: use the supplied brand profile

STRUCTURE
1. Hook
2. Tension / setup
3. Insight or story
4. Specific takeaway
5. Soft CTA (optional, not always required)

STYLE RULES
- Write like a founder or operator, not a content marketer.
- Keep it sharp, credible, and commercially relevant.
- Use short paragraphs.
- Be specific.
- Do not use generic filler.
- Do not over-explain.
- Do not sound inspirational.
- Do not sound like an ad unless CTA is explicitly promotional.
- Avoid overusing dashes or gimmicky formatting.
- The post should feel native to LinkedIn and likely to attract comments from business owners.

CONTENT RULES
- 80% value, 20% promotion max.
- If using a CTA, keep it subtle.
- Prioritize insight density over length.
- Mention specific failure modes, business consequences, or operator lessons where relevant.

OUTPUT
Return JSON:
{
  "post_text": "",
  "cta_present": true/false,
  "primary_emotion": "",
  "estimated_strengths": ["", "", ""]
}
7. FACEBOOK WRITER PROMPT

Facebook should be slightly broader and more conversational.

Write a Facebook post for a business audience.

INPUTS
Topic: {topic}
Angle: {angle_title}
Core claim: {core_claim}
Chosen hook: {hook}
CTA objective: {cta_objective}

STYLE
- Conversational but intelligent
- Slightly broader than LinkedIn
- Still commercially relevant
- Strong readability
- Suitable for image + caption pairing

RULES
- Avoid generic fluff.
- Avoid corporate tone.
- Keep it concise.
- Make it easy to understand in one pass.
- Can be slightly warmer than LinkedIn, but not casual nonsense.

OUTPUT JSON:
{
  "caption_text": "",
  "suggested_asset_type": "",
  "cta_present": true/false
}
8. INSTAGRAM CAPTION + CAROUSEL PROMPT

Instagram should pair writing with visual structure.

Caption prompt
Write an Instagram caption for a B2B SaaS audience.

INPUTS
Topic: {topic}
Angle: {angle_title}
Core claim: {core_claim}
Chosen hook: {hook}

RULES
- The caption must complement a visual asset, not repeat it line by line.
- Keep it readable and punchy.
- Lead with a strong opening line.
- Focus on one sharp insight.
- End with a clear takeaway or soft CTA.
- Avoid generic social media clichés.

OUTPUT JSON:
{
  "caption_text": "",
  "asset_type": "quote_card|stat_card|carousel|single_visual",
  "cta_present": true/false
}
Carousel prompt
Create a 5-slide Instagram carousel for a B2B SaaS audience.

INPUTS
Topic: {topic}
Angle: {angle_title}
Core claim: {core_claim}

STRUCTURE
Slide 1: hook
Slide 2: problem
Slide 3: why it happens
Slide 4: what smart operators do instead
Slide 5: takeaway / CTA

RULES
- Each slide should contain concise, readable text.
- No slide should feel crowded.
- The carousel should build narrative momentum.
- Avoid generic business fluff.
- Make each slide scannable.

OUTPUT JSON:
{
  "slides": [
    {"slide_no":1,"headline":"","body":""},
    {"slide_no":2,"headline":"","body":""},
    {"slide_no":3,"headline":"","body":""},
    {"slide_no":4,"headline":"","body":""},
    {"slide_no":5,"headline":"","body":""}
  ]
}
9. X WRITER PROMPT (INACTIVE BUT READY)

Even though X is inactive for now, Claude Code should include this prompt stack.

Short post prompt
Write a short X post for a B2B SaaS founder/operator audience.

INPUTS
Topic: {topic}
Angle: {angle_title}
Core claim: {core_claim}
Hook: {hook}

RULES
- Compact, sharp, insight-led
- Strong opening line
- No fluff
- No hashtags unless explicitly required
- Sound like someone with real operating experience
- Prefer clarity and force over cleverness

OUTPUT JSON:
{
  "post_text": ""
}
Thread prompt
Write a 6-post X thread for a B2B SaaS audience.

STRUCTURE
1. hook
2. reframe the problem
3. explain hidden cost
4. introduce insight
5. tactical takeaway
6. conclusion / CTA

RULES
- Each post should stand alone but connect logically.
- Avoid padding.
- Keep posts concise.
- Do not make it sound like engagement bait.

OUTPUT JSON:
{
  "thread": ["", "", "", "", "", ""]
}
10. IMAGE TEXT PROMPTS

You should also generate text specifically for image templates, not just reuse captions.

Quote card prompt
Create text for a branded quote card for a B2B SaaS audience.

INPUT
Core claim: {core_claim}
Angle: {angle_title}

RULES
- 1 main line only
- Maximum 14 words
- High clarity
- Must look strong on a visual card
- No fluff, no buzzwords

OUTPUT JSON:
{
  "headline_text": "",
  "subtext": ""
}
Stat card prompt
Create text for a stat/insight card.

INPUT
Topic: {topic}
Core claim: {core_claim}
Optional proof point: {proof_point}

RULES
- Emphasize one business insight or quantified statement
- Must be readable on an image
- Maximum 18 words in main text
- Optional 1 short supporting line

OUTPUT JSON:
{
  "headline_text": "",
  "supporting_text": ""
}
11. QUALITY CRITIC PROMPT

This is critical. Every generated draft should be scored by a critic prompt before it is accepted.

Prompt
You are a strict B2B SaaS content critic.

Evaluate the following draft for quality.

DRAFT:
{draft_text}

CONTEXT:
Topic: {topic}
Platform: {platform}
Audience: {audience_summary}
Brand tone: {tone_summary}

Score from 1-10 on:
- clarity
- specificity
- novelty
- platform fit
- credibility
- non-genericness
- commercial relevance

Also answer:
- What is weak?
- What sounds generic?
- What would reduce engagement?
- Does this sound like an operator or like a shallow marketer?
- Should this draft be accepted, revised, or rejected?

Return JSON:
{
  "scores": {
    "clarity": 0,
    "specificity": 0,
    "novelty": 0,
    "platform_fit": 0,
    "credibility": 0,
    "non_genericness": 0,
    "commercial_relevance": 0
  },
  "weaknesses": [""],
  "generic_phrases_found": [""],
  "decision": "accept|revise|reject",
  "revision_brief": ""
}

Claude Code should enforce thresholds, for example:

if non_genericness < 7 → regenerate

if commercial relevance < 7 → regenerate

if credibility < 7 → regenerate

12. REGENERATION PROMPT

When critic rejects, don’t start from scratch blindly. Regenerate using precise feedback.

Revise this draft using the critic feedback below.

ORIGINAL DRAFT:
{draft_text}

CRITIC FEEDBACK:
{revision_brief}

RULES
- Keep the same core topic and angle.
- Fix generic or weak parts.
- Increase specificity and credibility.
- Improve platform fit.
- Do not add fluff.
- Do not make it longer unless necessary.

Return improved JSON:
{
  "revised_text": ""
}
13. ENGAGEMENT REPLY PROMPTS

These should be different from post prompts.

Comment prompt
Write a smart comment on this post from the perspective of a credible B2B SaaS operator.

POST CONTENT:
{source_text}

TARGET CONTEXT:
- Platform: {platform}
- Topic source: {target_type}
- Brand context: {brand_summary}

RULES
- Add value, do not flatter aimlessly.
- Do not sound automated.
- Do not repeat the post.
- Do not be overly long.
- Prefer one concrete insight, extension, or sharp agreement/disagreement.
- Avoid fake enthusiasm.
- Avoid emojis unless explicitly allowed.

Return 3 options in JSON:
{
  "options": [
    {"text":"","style":"agreement_with_insight"},
    {"text":"","style":"extension"},
    {"text":"","style":"light_contrarian"}
  ]
}
Reply prompt
Write a reply to a comment or mention.

INPUT:
Original post context: {post_context}
Incoming comment: {incoming_comment}
Platform: {platform}

RULES
- Be natural and concise.
- Continue the conversation.
- Avoid robotic politeness.
- Do not over-explain.
- If the comment is shallow, keep the reply short.
- If it opens a strong discussion, add useful substance.

Return JSON:
{
  "reply_text": "",
  "confidence_score_hint": 0.0,
  "risk_notes": [""]
}
14. LEARNING / FEEDBACK LOOP PROMPT

This is how the engine improves over time.

Input

last 30 posts

metrics

top posts

worst posts

best hooks

best pillars

best CTA styles

Prompt
Analyze these recent B2B SaaS social media results and identify what is working.

INPUT DATA:
{recent_posts_and_metrics}

Find:
- which hooks worked best
- which pillars performed best
- which post structures worked best
- which CTA styles worked best
- what weak patterns should be avoided
- what new experiments should be tried next

Return JSON:
{
  "winning_patterns": [""],
  "losing_patterns": [""],
  "hook_recommendations": [""],
  "pillar_recommendations": [""],
  "format_recommendations": [""],
  "next_experiments": [""]
}

This should feed the next planner run.

15. SYSTEM-LEVEL GUARDRAILS

Claude Code should bake in these universal rules:

Always avoid

cliché motivational language

generic “thought leadership”

vague advice

overlong intros

fake certainty

high-pressure CTA tone

repeated structure every day

repetitive hooks

generic “AI will change everything” fluff

Prefer

hidden cost

operator insight

business tension

revenue leakage

non-obvious mistakes

practical reframing

proof-backed observations

concise structure

believable specificity

16. RECOMMENDED JSON OUTPUT CONTRACTS

Claude Code should make every generation step return structured JSON, not free text.

That means:

easier storage

easier validation

easier editing

easier quality checking

easier later retraining/analysis

At minimum:

planner returns JSON

writer returns JSON

hook generator returns JSON

image text generator returns JSON

critic returns JSON

engagement prompt returns JSON

analytics learning returns JSON

17. PROMPT EXECUTION PIPELINE

The best execution flow is:

Step 1

Load brand context

Step 2

Planner generates content ideas

Step 3

Angle generator creates angles

Step 4

Hook generator creates hooks

Step 5

Writer creates platform variants

Step 6

Image text generator creates visual copy

Step 7

Critic scores output

Step 8

If weak, regenerate with critic feedback

Step 9

Store both original + accepted version

Step 10

Publish or queue for approval

That is the architecture that keeps quality high.

18. WHAT WILL MAKE THIS WORK IN PRACTICE

Three things:

A. Strong brand context

If brand profile is weak, output will be weak.

B. Critic/regeneration loop

Without this, even good prompts drift into mediocrity.

C. Performance learning

The system must keep learning what hooks and pillars actually work.

19. DIRECT INSTRUCTION FOR CLAUDE CODE

You can give Claude Code this exact directive:

Implement the content generation system as a layered prompt architecture, not a single prompt.

Required prompt modules:
- brand context
- planner
- angle generator
- hook generator
- platform writers
- image text generator
- quality critic
- regeneration
- engagement comment/reply generation
- analytics learning loop

All prompt outputs should be structured JSON.
All generated drafts must pass through a critic stage before acceptance.
Store original AI output and user-edited output separately.
Enforce non-genericness and commercial relevance thresholds before queuing content for publishing.
20. MY ASSESSMENT OF THE FULL PLAN

Yes — the plan I gave you is detailed, robust, and institutional grade.

Why I’m saying that concretely:

product semantics are frozen

pricing logic is explicit

quota logic is explicit

platform scope is explicit

architecture boundaries are explicit

multi-tenancy is explicit

database separation is explicit

X future activation path is explicit

frontend/backend Meta behavior is explicit

free-tier edge cases are defined

quality-control loop is defined

future roadmap is separated from v1

That is enough for Claude Code to build against without wandering architecturally.