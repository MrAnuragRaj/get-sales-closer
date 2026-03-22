# GetSalesCloser — Complete Feature Reference

> Generated: 2026-03-13 | Covers all modules through Session 28 + Revenue Doctor Session 9

---

## Table of Contents

1. [Platform Overview](#1-platform-overview)
2. [Landing Page & Marketing (index.html)](#2-landing-page--marketing)
3. [Authentication & Onboarding (login.html / auth.js)](#3-authentication--onboarding)
4. [Solo User Dashboard (dashboard.html)](#4-solo-user-dashboard)
5. [Agency Admin Portal (agency_admin.html)](#5-agency-admin-portal)
6. [Enterprise Admin Portal (enterprise_admin.html)](#6-enterprise-admin-portal)
7. [Agent Dashboard (agent_dashboard.html)](#7-agent-dashboard)
8. [Platform Admin Panel (admin.html)](#8-platform-admin-panel)
9. [Growth Engine (growth_dashboard.html)](#9-growth-engine)
10. [Revenue Doctor (revenue_doctor.html)](#10-revenue-doctor)
11. [Instant Sentinel (sentinel.html)](#11-instant-sentinel)
12. [Pricing & Billing (pricing.html / billing.html)](#12-pricing--billing)
13. [Subscription Cancellation (cancel.html)](#13-subscription-cancellation)
14. [AI Chat Widget (embed.js / chat.html)](#14-ai-chat-widget)
15. [Channel Infrastructure & Executors](#15-channel-infrastructure--executors)
16. [CRM Webhook Ingestion (hook_inbound)](#16-crm-webhook-ingestion)
17. [Voice Liaison](#17-voice-liaison)
18. [Knowledge Brain](#18-knowledge-brain)
19. [Appointment Architect](#19-appointment-architect)
20. [Credit Wallet & Token System](#20-credit-wallet--token-system)
21. [Automation Pipeline (Campaigns & Tasks)](#21-automation-pipeline)
22. [Platform Hardening & Safety Features](#22-platform-hardening--safety-features)
23. [Admin RPCs & Database Reference](#23-admin-rpcs--database-reference)
24. [Email & Notification System](#24-email--notification-system)
25. [Architecture Patterns & Key Conventions](#25-architecture-patterns--key-conventions)

---

## 1. Platform Overview

**GetSalesCloser** is a B2B sales automation platform designed for high-ticket closers in law, medical, real estate, solar, and similar industries. The core promise: respond to inbound leads within seconds (not hours) using AI-driven multi-channel outreach, preventing the "lead leakage" caused by slow human response times.

### Core Value Proposition
- **Speed-to-lead:** AI responds to new leads immediately, 24/7
- **Multi-channel coverage:** SMS, WhatsApp, Facebook Messenger, RCS, Email, Voice
- **Human escalation:** Agents can take over any conversation and resume AI at will
- **Revenue diagnostics:** AI-generated reports identify funnel leaks and coaching priorities
- **CRM integration:** Accepts leads from GHL, HubSpot, Apollo, Zapier, Make, Facebook Lead Ads, and generic webhooks

### User Roles
| Role | Dashboard | Description |
|---|---|---|
| Solo User | `dashboard.html` | Individual closer managing their own leads |
| Agency Admin | `agency_admin.html` | Manages a team of closers under one org |
| Enterprise Admin | `enterprise_admin.html` | Oversees agents, leaderboards, team intelligence |
| Enterprise Agent | `agent_dashboard.html` | Field agent assigned leads from enterprise org |
| Platform Admin | `admin.html` | Anurag / YogMaya — full platform controls |

### Tech Stack
| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML5 + Tailwind CSS (CDN) + ES6+ JS |
| Backend | Supabase (PostgreSQL + Auth + Storage + Edge Functions) |
| AI — Chat/Intent | OpenAI GPT-4o-mini |
| AI — Knowledge/Revenue Doctor | OpenAI GPT-4o |
| Voice | VAPI |
| SMS / WhatsApp | Twilio |
| Email | Resend |
| Payments | Razorpay |
| Hosting | Vercel |

---

## 2. Landing Page & Marketing

**File:** `index.html`

### Navigation Header
- GetSalesCloser animated SVG logo
- "How it Works" button → opens ROI Calculator popup
- "Pricing" → jumps to pricing section
- "Login" → redirects to `login.html`

---

### Hero Section
- Headline: *"Stop Leaking Leads. Start Locking Appointments."*
- CTA 1: **"Get My Free Speed-to-Lead Audit"** → opens audit form popup
- CTA 2: **"Watch Demo"** → opens demo selector modal
- Deployment overlay animation (shown after "Deploy My Closer" is clicked)

---

### Dynamic Pricing Engine ("Configure Your Engine")

The pricing engine is the centrepiece of the landing page. Users toggle modules and see a live price update in real time.

#### Modules Available

| Module | Base Price | Notes |
|---|---|---|
| The Instant Sentinel | $49–$349/mo | SMS always included; price scales with other modules |
| The Voice Liaison | $149–$349/mo | Can be standalone or combined with Sentinel |
| The Knowledge Brain | $99–$249 add-on | Must be paired with Sentinel OR Voice Liaison |
| Appointment Architect | $99–$249 add-on | Must be paired with Sentinel OR Voice Liaison |
| Professional Intake | $149 | Premium compliance — standalone |
| Safe Voice Handling | $199 | Premium compliance — standalone |
| Priority Intake Routing | $99 | Premium compliance — standalone |
| **Growth Engine (Beta)** | **$660/mo add-on** | Independent add-on, independent of other modules |

#### Channel Expansion (under Instant Sentinel)
| Channel | Add-on Cost |
|---|---|
| SMS | Base (always included) |
| WhatsApp | +$10/mo |
| Facebook Messenger | +$10/mo |
| RCS Android | +$10/mo |

#### Pricing Validation Rules
1. Knowledge Brain + Appointment Architect require at least one of: Sentinel OR Voice Liaison
2. If neither base module is selected, the "Deploy My Closer" button is disabled
3. Channel expansion only applies to Sentinel (not Voice Liaison)
4. Growth Engine is fully independent — can be added with any or no other module
5. Price counter animates smoothly on every toggle change
6. The central node graphic scales visually with the total price

#### Deploy Button
- Disabled on invalid config
- On click: plays deployment overlay animation for ~2 seconds, then redirects to `pricing.html` with the selected config pre-loaded

---

### ROI Calculator Popup ("How It Works")

An interactive calculator that visualises lead leakage and ROI.

**Input Sliders:**
- Average deal value: $100–$10,000
- Monthly leads: 10–500
- Response time: 1–120 minutes (with HBR warning at >5 min — Harvard Business Review data showing 71% lead decay)

**Output Metrics:**
- Lead leakage rate: 5% (fast response) or 71% (>5 min)
- Net profit recovery (monthly)
- ROI multiplier (platform cost vs. recovered revenue)
- Annual recovery projection

**Visuals:**
- Animated funnel with "leak particles" flowing out when response time is high
- Doughnut chart showing ROI split

**CTA:** "Secure My Revenue Now" → links to `pricing.html`

---

### Demo Selector Modal
- Dropdown: Law Firm / Medical / Spa / Solar / Real Estate / Others
- "Watch Video" → embeds YouTube demo

---

### Speed-to-Lead Audit Popup
- Full Name input
- Phone input (intl-tel-input with country flag selector)
- Website URL input — triggers **DNA Detection**: scans hostname patterns and displays industry auto-detected ("HEALTHCARE / MEDICAL", "LEGAL", "HIGH-TICKET SERVICE")
- TCPA/GDPR consent checkbox
- "Start Relentless Audit" CTA

---

### Embedded Chat Widget
The landing page itself embeds the GetSalesCloser AI widget (`embed.js`) as a live demo of the product.

---

## 3. Authentication & Onboarding

**Files:** `login.html`, `auth.js`

### Login Methods

#### OAuth (5 Providers)
- Google
- Microsoft (Outlook / Azure)
- LinkedIn (via `linkedin_oidc`)
- Facebook
- X (Twitter)

#### Phone OTP
1. Enter phone number (E.164 format)
2. Click "Send Login Code" → Supabase sends OTP
3. Enter 6-digit code → authenticated

#### Email/Password Signup
- Full Name, Company Name, Email, Password
- On signup: Supabase creates auth user + `profiles` record
- Triggers welcome email via `send-welcome-email` edge function

---

### Post-Login Routing Logic
After successful authentication, the system routes users based on their highest-priority role:

```
is_admin = true              → admin.html
role = enterprise_admin      → enterprise_admin.html
role = agency_admin          → agency_admin.html
role = enterprise_agent      → agent_dashboard.html
no active org services       → pricing.html (new user)
default (solo user)          → dashboard.html
```

---

### Invitation Claiming
- On login, system queries `org_invitations` for the user's email
- Any pending invitations are automatically accepted (upserted into `org_members`)
- Processed invitations are deleted

---

### Auth Guard (`auth.js`)

All protected pages use the `requireAuth()` function which:
1. Checks Supabase session (redirects to login if absent)
2. Fetches the user's `profiles` record
3. Optionally enforces onboarding completion (shows setup modal if incomplete)
4. Listens for `SIGNED_OUT` events across all tabs (multi-tab logout)
5. Calls `onAuthenticated(profile, user, supabaseClient)` on success

**Usage pattern:**
```html
<div id="auth-loader"><!-- spinner --></div>
<div id="page-content" style="display:none;"><!-- page --></div>
<script>
requireAuth({ onAuthenticated: (profile, user, sb) => { /* init */ } });
</script>
```

**Role pages** (agency_admin, enterprise_admin, agent_dashboard) use `requireOnboarding: false` to bypass onboarding enforcement.

---

## 4. Solo User Dashboard

**File:** `dashboard.html`

The command center for individual (non-agency, non-enterprise) users.

### Leads Management
- View all leads for the org
- Status badges: Active / Closed Won / Closed Lost / At Risk
- Last interaction timestamp per lead
- Click a lead to open conversation history and CRM details
- Assign status, add notes

### AI Persona Configuration
- Set persona **name** (e.g., "Alex from TechLaw")
- Set **tone** (Professional, Friendly, Assertive, Empathetic, Consultative)
- Custom **system instructions** (persona background, talking points, things to avoid)
- **Industry preset** — pre-fills tone/instructions for law, medical, solar, real estate
- Changes saved to `org_settings` table

### Deploy Widget
- Generates embeddable `<script>` tag for the AI chat widget
- Shows widget `org_id`
- Copy-to-clipboard button
- Preview button (opens `chat.html` in new tab)

### API Keys Management
- List all org API keys (name, creation date, last used)
- Create new API key (with label/name)
- Revoke/delete existing keys
- Each key is used to authenticate CRM webhook ingestion via `hook_inbound`

### Mirror Test
- Type a test message as if you were a lead
- AI responds in real time using the current persona config
- Used to validate persona before going live

### Live Wire
- Real-time feed of all inbound/outbound messages across all active leads
- Auto-refreshes via Supabase Realtime subscription
- Shows: timestamp, lead name, channel (SMS/WA/Email), message snippet, direction (in/out)

### Credit Wallet
- Current token balance per channel (SMS, WhatsApp, Voice minutes, Email, RCS)
- Visual gauge showing balance health (green/yellow/red)
- "Top Up" button → links to credit purchase flow

### Delivery Status
- Table of recent `delivery_attempts`
- Shows: lead, channel, provider (Twilio/VAPI/Resend), status (sent/delivered/failed), timestamp
- Failed entries shown in red with error detail

### Channel Infrastructure
- Configure per-channel senders:
  - **SMS:** Twilio from-number, fallback policy
  - **WhatsApp:** Twilio WhatsApp-enabled number, fallback policy
  - **Facebook Messenger:** OAuth flow to connect FB Page, stores `provider_token`
  - **RCS:** Google RBM service account config
  - **Email:** Sender name/address config
- Fallback Policy per channel: `allow_shared` / `fail_task` / `admin_override`

### Growth Intelligence (Beta)
- Preview card for Growth Engine add-on
- Shows last Revenue Doctor report summary (score, top issue, date)
- "Generate New Report" button → links to `revenue_doctor.html`
- Report credit badge (remaining credits)

---

## 5. Agency Admin Portal

**File:** `agency_admin.html`

### Seat Management
- View all org members (name, email, role, join date)
- Add seats / remove members
- View onboarding completion status per member

### Invite System
- Enter email + optional name → sends invitation email via `send-agent-invite` edge function
- Invitation stored in `org_invitations`; auto-claimed on recipient's first login
- Pending invitations listed with copy-invite-link option
- Resend invite

### AI Persona Settings
- Same as solo dashboard persona config
- Agency-wide persona applied to all leads/channels

### Credit Wallet
- Shared credit pool visible to agency admin
- Same gauges as solo dashboard (SMS, WA, Voice, Email)
- Top-up flow

### Channel Infrastructure
- Configure all channels for the agency org
- Facebook Page OAuth ("Connect Facebook Page" card with blue OAuth button)
- Per-channel fallback policies

### Billing & Entitlements
- View active services (`org_services` table)
- "Upgrade Plan" → `billing.html`

---

## 6. Enterprise Admin Portal

**File:** `enterprise_admin.html`

### Agent Leaderboard
Data sourced from `get_agent_leaderboard` RPC. Columns:
- Agent name + email
- Leads assigned
- Conversations started
- Conversion rate (closed_won / total)
- Avg response time
- Rank badge (1st / 2nd / 3rd get gold/silver/bronze)

### Agent Management
- View all agents (`org_members WHERE role='enterprise_agent'`)
- Invite new agents (same flow as agency)
- Remove agents
- View per-agent performance metrics

### Overseer Console
- Real-time monitoring of agent activity
- Which leads each agent is currently handling
- AI paused status per lead (Takeover active)
- Pending manual action requests across all agents

### Credit Wallet
- Enterprise-wide shared wallet
- Shows balance per token key (sms_msg, wa_msg, voice_min, email_msg, etc.)

### Channel Infrastructure
- Multi-team sender config (same as agency)

### Growth Intelligence (Beta)
- Revenue Doctor card: last report summary for the enterprise org
- "Generate New Report" → `revenue_doctor.html`
- Enterprise reports include **Team Intelligence** sections (agent flags, coaching priorities)

---

## 7. Agent Dashboard

**File:** `agent_dashboard.html`

### Lead List
- Tabs: Active | Closed Won | Closed Lost | At Risk
- Filtered to leads `WHERE assigned_to = current_agent_id`
- Each row: lead name, status badge, last interaction time, company

### Conversation Panel
- Full conversation history for selected lead
- AI messages vs. lead replies visually differentiated
- Timestamps per message
- Lead status indicator (ai_paused = Takeover mode active)

### Takeover Flow
1. Agent clicks **"Takeover"** button
   - Sets `leads.ai_paused = true`
   - AI stops sending on next inbound
2. Agent types manual reply into text input
   - Creates `execution_tasks` entry with `metadata.force_content = <text>`
   - `executor_sms` detects `force_content` → skips AI generation, sends text directly via Twilio
3. Agent clicks **"Resume AI"**
   - Sets `leads.ai_paused = false`
   - AI resumes automated responses on next inbound message

### Manual Reply Input
- Free-text area (visible during Takeover mode)
- Send button → creates task with `force_content`
- Character count display

### Pending Actions
- List of `manual_action_requests` requiring agent attention
- Action types: call back, send document, schedule meeting
- Mark complete / add notes

### Live Wire
- Real-time feed of messages for assigned leads only (not org-wide)

---

## 8. Platform Admin Panel

**File:** `admin.html`

Accessible only to users where `profiles.is_admin = true`. All admin API calls pass a fresh JWT in both `global.headers` and `functions.invoke()` headers (expires every 1h).

---

### Founder Dashboard (auto-loads on page open)

#### Row 1 — Live Pulse Tiles (6 KPIs)
| KPI | Description |
|---|---|
| New Users Today | Signup count (today UTC) |
| GE Active Orgs | Orgs with `growth_engine` service active |
| GE MRR Est. | Estimated MRR from Growth Engine add-ons |
| Attach Rate | % of paying orgs with Growth Engine |
| Engagements Today | Total AI interactions (inbound + outbound) |
| Deals Influenced | Conversion count from automated outreach |

#### Row 2 — Health Metrics with Progress Bars (4 metrics)
| Metric | Target | Description |
|---|---|---|
| Activation Rate | >40% | % of orgs that created ≥1 lead |
| Avg Time to First Value (TTFV) | <15 min | Time from signup to first AI message sent |
| Automation Trust Rate | >50% | % of leads where `ai_paused = false` |
| Lead Attribution Rate | — | % of revenue traced to platform activity |

Each metric shows: current value, progress bar, target indicator.

#### Row 3 — Retention & Engagement
- **30-day retention cohort:** % of orgs active 30 days after signup
- **90-day retention cohort:** % of orgs active 90 days after signup
- **Engagement funnel:** Leads created → Messages sent → Conversations started

#### Row 4 — Beta Prospect Pipeline Table
- Top-50 paying orgs WITHOUT Growth Engine entitlement
- Columns: Org name, Lead count, Plan, Signed up date
- Sorted by lead count (highest first)
- Inline **"Grant Beta"** button per row → calls `admin_grant_growth_engine(org_id)` RPC
- Notice: "growth schema not ready" displayed until Growth Engine FastAPI writes to `growth.*` tables

---

### Growth Engine Beta Access Panel
Two sub-panels:

**Grant Access:**
- Text filter to search orgs
- Multi-select checkbox list of all paying orgs WITHOUT GE
- "Grant Access" button → batch calls `admin_grant_growth_engine` for each selected org
- Upserts `org_services` with `service_key='growth_engine'`, `status='active'`

**Revoke Access:**
- Text filter to search orgs
- Multi-select checkbox list of orgs WITH GE active
- "Revoke Access" button → batch calls `admin_revoke_growth_engine` for each selected org
- Sets `org_services.status = 'inactive'`

---

### Bank Transfer Approvals
- List of pending bank transfer billing intents
- Admin can approve → calls `approve_bank_transfer` RPC
- Or mark as awaiting → calls `mark_intent_awaiting_bank` RPC
- Shows: org name, amount, reference number, submitted date

### Entitlements Management
- Per-org service activation/deactivation
- Services: `sentinel`, `voice`, `brain`, `architect`, `growth_engine`
- Activate/deactivate without requiring payment flow

### Prompt Editor
- View and edit custom system prompts per org
- `active_org_prompts` VIEW reads from `org_prompts`
- Channel-specific prompts (sms, voice, widget)

### Deal Management
- Create agency/enterprise partnership deals
- RPC: `create_agency_enterprise_deal(params)`
- Approve/reject deals → `approve_agency_enterprise_deal(deal_id)`

### Channel Sender Management
- View all `org_channels` records across all orgs
- Edit from_e164, fallback_policy, status
- Messenger: reads `metadata.page_id` for display
- Provision new numbers for orgs

### Provisioning Queue
- List of `org_channel_provision_requests`
- Fulfil requests manually (assign Twilio number to org)
- Status: pending / in_progress / completed / failed

### Kill Switch Panel
- **Platform Kill Switch:** Global circuit breaker — disables ALL message execution
  - Toggle: enabled/disabled
  - Reads `platform_control_flags` table
  - When enabled: all executors (SMS, WA, Voice, Email, RCS, Messenger) abort immediately
- **Per-Org Kill Switch:** Disable execution for a specific org
  - Search org by name/email
  - Toggle org kill switch

### Rate Limits Dashboard
- View `rate_limit_buckets` per org
- Shows current rate (executions/min) vs. limit
- Manually adjust per-org rate limits
- Orgs exceeding limit return 429 from executors

### Dead-Letter Queue
- All `execution_dead_letters` — tasks that failed all retry attempts
- Shows: org, lead, channel, error, attempt count, last error timestamp
- "Retry" button — re-queues task
- "Dismiss" — marks acknowledged

### Webhook Store
- Log of all inbound webhook events from `provider_webhook_events`
- Filter by provider (Twilio, VAPI, Razorpay, Facebook, Google RBM)
- Shows: event type, payload summary, processed status, timestamp

### Channel Health Monitor
- Dashboard reading `channel_health_current`
- Per-channel delivery rate (last 24h)
- Error rate, avg latency, last event time
- Red/yellow/green health indicators
- Computed by `compute_channel_health_v1()` pg_cron every 5 minutes

---

## 9. Growth Engine

**Files:** `growth_dashboard.html`, `growth-config.js`, `supabase/functions/growth-flag-proxy/index.ts`

**Service Key:** `growth_engine` | **Price:** $660/mo add-on | **Status:** Beta

### Entitlement Gate — Locked Preview
Non-entitled orgs see a full-screen overlay (does NOT redirect — locked-preview pattern):
- Emerald seedling icon in gradient container
- "Growth Engine" title with **Beta** badge
- Feature list:
  - AI content generation
  - Smart engagement automation
  - Relationship intelligence (Growth Graph)
  - Revenue attribution
- CTA: "Unlock Growth Engine" → `billing.html?lock=growth_engine`

### When Entitled — Full Dashboard

#### Tab Navigation
- **Overview** | **Content Calendar** | **Engagement** | **Analytics** | **Settings**

#### Overview Tab
- Platform connection status (LinkedIn, X, Instagram, Facebook)
- Connect/disconnect per platform
- Recent activity feed (posts, engagements, replies)

#### Content Calendar
- Scheduled posts queue
- Draft content library
- Publishing schedule with platform tags
- AI content generation controls

#### Engagement Tab
- Automated outreach metrics (sent, opened, replied)
- Response rate trends
- Active conversation tracking
- Platform breakdown

#### Analytics Tab
- Reach and impression metrics
- Content performance by platform (engagement rate, click-through)
- Revenue attribution (experimental — links platform engagement to closed deals)
- Comparison period selector

#### Settings Tab
- API credentials per platform
- Tone/voice preferences for AI content
- Content guidelines and brand rules
- Posting frequency controls

### Feature Flag Proxy (`growth-flag-proxy`)
- Admin-only edge function
- Proxies feature flag reads/writes to Growth Engine FastAPI (Railway)
- Hides `GROWTH_ENGINE_INTERNAL_SECRET` from client JS
- GET: returns all feature flags
- POST `{ key, enabled }`: toggles a specific flag

### Growth Config (`growth-config.js`)
```javascript
window.GROWTH_API_BASE = 'http://localhost:8000';
// Production: https://<growth-engine>.railway.app
```
Single source of truth for Growth Engine API URL.

### What's Not Built Yet
- Growth Engine FastAPI (Railway) — the actual automation service
- `growth.engagement_opportunities` and `growth.revenue_attributions` tables
- Until FastAPI is live, all growth schema metrics show 0 / "—" gracefully

---

## 10. Revenue Doctor

**Files:** `revenue_doctor.html`, `supabase/functions/revenue-doctor-generate/index.ts`, `supabase/functions/revenue-doctor-reports/index.ts`

**Shared modules:** `revenue_adapters.ts`, `health_scorer.ts`, `doctor_payload_builder.ts`, `pii_scrubber.ts`, `team_attention.ts`

### Overview
AI-powered revenue diagnostics. GPT-4o analyzes your pipeline, conversations, funnel, and automation health, then generates a structured report with prioritized recommendations.

---

### Report Generation Flow

#### Step 1 — Auth & Entitlement Check
- User must be org member
- Must have `voice` service active (Sentinel-only orgs: 403)
- Token wallet balance `doctor_report > 0` (else 402 Payment Required)

#### Step 2 — Rate Limiting
- Max 3 report generations per minute per org
- Enforced via `COUNT(revenue_doctor_reports WHERE generated_at > NOW() - 60s)`

#### Step 3 — Credit Consumption
- Consumes 1 token: `consume_tokens_v1(scope='org', key='doctor_report', amount=1)`
- Idempotent via UUID idempotency key

#### Step 4 — Data Aggregation (5 Parallel Adapters)
| Adapter | Data Fetched |
|---|---|
| `fetchLeadFacts` | Lead counts by status, response times, assignment rates |
| `fetchConversationFacts` | Message counts, AI vs. human ratios, sentiment samples |
| `fetchChannelFacts` | Delivery rates, failure counts, channel health per type |
| `fetchFunnelFacts` | Stage-by-stage conversion, drop-off points |
| `fetchCampaignFacts` | Campaign performance, open rates, reply rates |

All adapters are org-scoped with safety caps (5k/10k rows).

#### Step 5 — Health Scoring
Computed by `health_scorer.ts`:
- `scoreLeadResponse` — speed-to-first-contact analysis
- `scoreConversationQuality` — AI engagement quality
- `scoreChannelHealth` — delivery success rates
- `scoreConversionHealth` — closed-won rate trends
- `computeOverallScore` — weighted composite (0–100)
- `generateWarnings` — anomaly detection (e.g., "72% of leads have no response within 1 hour")

#### Step 6 — Payload Building
`doctor_payload_builder.ts`:
- Intelligent conversation sampling (3-tier: questions → drop-off → other)
- GPT-4o-mini conversation classification (7 objection types, 7 intent types)
- Funnel insights computation
- PII scrubbing of all evidence samples (phone/email/name patterns removed)

#### Step 7 — LLM Generation
- Model: **GPT-4o**
- Timeout: 40 seconds (AbortController)
- Persona: Senior revenue operations consultant
- Output: 9 required sections (see Report Sections below)
- Validation: `validateReportContent()` checks all 8 required sections; retries once if invalid; refunds credit + returns 422 if both attempts fail

#### Step 8 — Enterprise Team Intelligence (if org_type='enterprise')
Generated by `team_attention.ts`:
- Fetches all `enterprise_agent` members + their profiles
- Per-agent rollup from `leads.assigned_to` + `interactions.user_id`
- **6 Flag Types per agent:**
  | Flag | Trigger |
  |---|---|
  | `slow_response` | >4 hours after inbound message |
  | `no_response` | Lead message with zero agent reply |
  | `high_intent_loss` | High-intent lead marked closed_lost |
  | `pricing_leak` | Pricing discussed but no follow-up |
  | `booking_weakness` | Appointment not booked despite interest |
  | `one_sided` | ≥3 agent messages, ≤1 lead reply |
- **Priority Score** = 25×slow + 20×no_response + 20×high_intent + 15×pricing + 10×booking + 10×one_sided + min(10, leads/2)
- **Buckets:** `immediate_attention` (≥60) / `coaching` (35–59) / `top_performer` (<35 with deals) / `insufficient_data` (<10 leads or <5 convs)

---

### Report Sections

| # | Section | Contents |
|---|---|---|
| 1 | Executive Summary | 1–2 paragraph overview of revenue health |
| 2 | Key Problems | Title, severity (high/medium/low), evidence bullets, impact statement |
| 3 | Root Causes | Cause, category, detailed explanation |
| 4 | Conversation Findings | Finding, supporting evidence, recommendation |
| 5 | Funnel Analysis | Stage insights, biggest leak point, summary |
| 6 | Recommendations | Action, priority, rationale, channel |
| 7 | Top 3 Actions | Action, expected result, effort level (low/medium/high) |
| 8 | Expected Impact | Conversion lift %, revenue impact $, summary |
| 9 | Confidence Notes | Data quality assessment |
| 10 | Team Overview | *(Enterprise only)* Total agents, requiring attention count, top performer |
| 11 | Users Requiring Attention | *(Enterprise only)* Per-agent flags + coaching notes |
| 12 | Coaching Priorities | *(Enterprise only)* Priority focus + specific actions |

---

### Report UI

#### Left Sidebar
- Scrollable list of all saved reports
- Each row: date, analysis window (Daily/Weekly/Monthly), severity badge, age indicator
- Stale warning (yellow triangle) when report >14 days old
- Click to load into right panel

#### Right Panel
- Empty state until report selected
- Full rendered report with:
  - Score rings (circular progress indicators)
  - Category progress bars with fill animations
  - Severity-coded problem cards (red/orange/yellow)
  - Priority-tagged action cards

#### Staged Loading UX
During generation, 4 stage indicators advance:
1. Analyzing lead response patterns
2. Reviewing conversations
3. Inspecting funnel leaks
4. Building revenue diagnosis

Progress bar: 5% → 20% → 45% → 65% → 85% on 9-second intervals.

#### Share Link
- `?report=<reportId>` appended to URL on selection
- "Copy Share Link" button with 2-second clipboard feedback
- Recipient auto-loads the specified report on page open

#### Export Options
- **Export PDF:** `window.print()` with `no-print` CSS hiding nav elements; print stylesheet converts dark theme to white
- **Export Markdown:** Builds `.md` file from report JSON, triggers download

---

### Report Credits (Token System)

| Plan | Monthly Credits | Reset |
|---|---|---|
| Voice Plan | 10 reports/mo | 1st of each month (pg_cron #17) |
| Enterprise | 999 reports/mo ("Unlimited") | 1st of each month |

**Display logic:** Balance ≥ 900 → shows "Unlimited" in UI.

**Purchasing additional credits:**
- Bundle options: 5/$79 · 10/$149 (Popular) · 20/$249 (Best Value)
- Checkout via `create-credit-topup-order` edge function
- On fulfillment: BOTH `credit_wallet_add_v1` (display layer) AND `grant_tokens_core_v1` (runtime layer) are called
- The runtime layer (`token_wallets`) is what `consume_tokens_v1` reads

---

## 11. Instant Sentinel

**File:** `sentinel.html`

**Service Key:** `sentinel`

### Lead List (Left Panel)
- All leads for the org
- Status badges: Active / Closed Won / Closed Lost / At Risk
- Last interaction timestamp
- Lead name + company

### Conversation History (Right Panel)
On selecting a lead:
- Full scrollable conversation feed
- Visual differentiation: AI/assistant messages vs. lead replies
- Glass card styling with timestamps

### Conversion Probability Score
Displayed in the footer of the right panel:
- Large percentage (0–100%)
- Calculated from: `leads.status` + `risk_score` + recency of activity
- Logic:
  - `closed_won` → 100%
  - `closed_lost` → 0%
  - `active` → starts at 45%, adjusted by risk score delta
  - "Calculated based on recent sentiment analysis"

### CRM Profile Modal
- Click "View Full CRM Profile" on any lead
- Full details: name, email, phone, company, deal value, status history
- Custom fields display

### SMS Balance Widget
- Shows remaining SMS token balance
- "+" Buy button → links to credit top-up

---

## 12. Pricing & Billing

### Pricing Page (`pricing.html`)
For new users after signup — select plan before first payment.

- Same interactive pricing engine as landing page (all modules + toggles)
- **Billing cycle toggle:** Monthly | Yearly (−12% badge)
- Annual billing subtext: "Billed annually — you save $XX/mo vs monthly"
- Auth: inline auth-loader pattern (does not use `auth.js`)
- On "Deploy My Closer": creates `billing_intents` record → redirects to `payment.html`

### Billing Page (`billing.html`)
For existing subscribers — add modules or switch billing cycle.

**Key Behaviours:**
- Each module card shows **ACTIVE** badge (green) if already owned
- Owned services show at 0.5 opacity with green border (cannot be un-toggled from billing page)
- Adding Sentinel implicitly (if not owned, $49 base added to total — shown in hint text)
- Growth Engine card has emerald styling + Beta badge
- URL parameter `?lock=growth_engine` auto-scrolls to and highlights Growth Engine card
- "Upgrade Plan" button → creates new checkout intent → `payment.html`
- "Manage Subscription" → `cancel.html`

### Payment (`payment.html`)
- Razorpay checkout modal
- Supports credit card / UPI / net banking / wallet
- Also shows: "Pay by Bank Transfer" option → `mark_intent_awaiting_bank` RPC

### Success (`success.html`)
- Polls `billing_intents` table for status change
- On confirmed payment: shows success screen + redirect to dashboard

---

## 13. Subscription Cancellation

**File:** `cancel.html`

### Step 1 — Feedback
**Why are you leaving?** (radio buttons):
- Too expensive
- Not using it enough
- Missing a feature I need
- Switching to a competitor
- Technical issues
- Other

Optional detail textarea for elaboration.

**Cancellation Type:**
- End of billing period (access preserved until period ends, no refund)
- Immediate cancellation (access ends now, prorated refund generated)

### Step 2 — Refund Preview
- Calls `initiate-cancellation` edge function
- Displays prorated refund amount
- Refund quote expires after 1 hour
- "Confirm Cancellation" → `confirm-cancellation` edge function
  - Updates `organizations.cancellation_status` to `cancelled_immediate` or `cancelled_end_of_term`
  - Sets `service_ends_at` for end-of-term cancellations

### Step 3 — Data Deletion Options
**"Delete My Data" option** (separate from cancellation):
- Triggers `export-and-delete-org-data` edge function
- **Exports** CSV files of: leads, interactions, appointments → sent via email (Resend)
- **Deletes** all org data from database
- Irreversible — confirmed with checkbox

**Refund Execution:**
- `execute-refund` edge function
- Idempotent via `refund_executions` table
- Uses `payment_attempts.provider_ref` (Razorpay payment ID) for partial refund

---

## 14. AI Chat Widget

**Files:** `embed.js`, `chat.html`

### Embed Script (`embed.js`)
- Single `<script>` tag with `data-org-id` attribute
- Creates floating chat bubble (bottom-right corner)
- Opens chat window on click
- Fully self-contained — no external CSS dependency
- Sends messages to `widget_inbound` edge function

### Hosted Smart Link Chat (`chat.html`)
- Standalone chat page (linkable URL)
- Same AI backend as embed widget
- Used when embedding isn't possible (e.g., email CTA)

### Widget AI Backend (`widget_inbound`)

**GET `?action=meta&org_id=`:** Returns `{ agent_name, org_name }` for widget branding.

**POST:** Processes visitor message:

1. **Persona injection:** Builds persona from `org_settings` (name, tone, industry, objectives)
2. **Custom prompt:** Fetches from `active_org_prompts` (channel='sms')
3. **Contact extraction state machine:**
   - Collects: Name, Phone (primary), Email (if no Appointment Architect)
   - Phone extraction: detects E.164 + local formats; infers country ("from India" → +91)
   - Name extraction: trigger phrases ("I'm John", "my name is Sarah") + bare-response detection
   - Confirmation step before accepting phone (country confirmed)
4. **History management:** Capped at 20 turns; content truncated to 1,000 chars per turn
5. **LLM call:** GPT-4o-mini (cost-optimised for chat)
6. **Response:** Returns AI message + extraction state `{ name?, phone?, email?, ready_for_booking? }`

---

## 15. Channel Infrastructure & Executors

Each communication channel has a dedicated Supabase Edge Function executor.

### Executor Guard Order (frozen — must not change)
```
Platform kill switch
  → Org kill switch
  → Org cancellation check
  → Rate limit check
  → Channel capability check
  → Binding/fallback resolution
  → Token/billing pre-debit
  → delivery_attempt INSERT (idempotency 23505 guard)
  → Send (Twilio/VAPI/Resend/etc.)
  → delivery_attempt UPDATE
  → execution_task status → "completed"
```

### SMS (`executor_sms`)
- Provider: **Twilio**
- Sender resolution (3-step):
  1. Active default org channel (`org_channels WHERE is_default=true AND status='active' AND channel='sms'`)
  2. Most recent org channel (any status) — for fallback policy
  3. Fallback policy: `allow_shared` (use platform Twilio number) / `fail_task` / `admin_override`
- Human takeover: detects `metadata.force_content` → skips AI, sends directly
- Pre-debit: 5 tokens before send; settled via RPC after

### WhatsApp (`executor_whatsapp`)
- Provider: **Twilio WhatsApp**
- Same guard order as SMS
- 24h message window enforcement (Meta policy)
- Falls back to SMS if WhatsApp capability not active

### Voice (`executor_voice`)
- Provider: **VAPI**
- Billing lock guard (checks voice service active)
- Pre-debit: 5 tokens
- Settlement: `settle_voice_call_tokens_v2` after call ends
- Per-org `phone_number_id` configuration

### Email (`executor_email`)
- Provider: **Resend**
- 1 token per email
- Sender: `support@getsalescloser.com`

### RCS (`executor_rcs`)
- Provider: **Google RBM**
- WebCrypto Service Account → OAuth2 JWT (server-side, no secret leakage)
- Falls back to SMS if RCS not supported on device

### Facebook Messenger (`executor_messenger`)
- Provider: **Facebook Graph API v21.0**
- Requires PSID (`leads.messenger_psid`)
- 24h message window with SMS fallback
- Per-org `provider_token` stored in `org_channels`

### Inbound Webhook (`webhook_inbound`)
- Receives: Twilio SMS, WhatsApp, VAPI voice events, Google RBM, Facebook Messenger
- `--no-verify-jwt` (public endpoint, uses Twilio signature validation)
- 128KB payload guard
- Routes to `decision_engine` → `execution_planner` → executor

---

## 16. CRM Webhook Ingestion

**Edge Function:** `hook_inbound`

### Authentication
- API key in `Authorization: Bearer <key>` header OR `?api_key=` query param
- Validated against `api_keys` table (`api_key` column — NOT `key`)
- Resolves `org_id` from key
- Updates `api_keys.last_used_at` (fire-and-forget)

### Supported CRM Sources
| Source | `?source=` Value | Field Mapping |
|---|---|---|
| GoHighLevel | `ghl` | `first_name`, `last_name`, `phone`, `email` |
| Zapier | `zapier` | `name`/`full_name`/`first_name`+`last_name`, `phone`, `email`, `notes` |
| Make (Integromat) | `make` | Same as Zapier |
| Apollo.io | `apollo` | `first_name`, `last_name`, `phone_number`, `email`, `headline` |
| HubSpot | `hubspot` | Properties map with value wrappers; `firstname`/`lastname` |
| Facebook Lead Ads | `facebook` | Nested `entry[0].changes[0].value.leads[0].field_data` array |
| Generic | `generic` | Best-effort field sniffing |

### Phone Normalization
- Extracts digits, validates 8–15 digits
- Adds `+1` (US) default if no country code detected
- Returns original string if normalization fails

### Duplicate Guard
- Checks for existing lead with same phone for org (within 7 days)
- Returns 409 Conflict on duplicate

### Lead Creation
- Inserts into `leads` table: `name, phone, email, notes, org_id, status='new'`
- Triggers `decision_engine` to queue first AI outreach message

---

## 17. Voice Liaison

**Service Key:** `voice`

**File:** `Voice Liaison.html`

### Call Logs
- Table of all voice calls (`voice_calls` table)
- Columns: lead name, duration, direction (inbound/outbound), sentiment, timestamp
- Sentiment badge: Positive / Neutral / Negative (from VAPI sentiment analysis)

### Replay Button
- Click to replay call recording (VAPI recording URL)
- Embedded audio player

### Voice Usage
- Total voice minutes used this billing period
- Remaining balance from `token_wallets[voice_min]`

### Voice AI Configuration
- VAPI voice model selection
- Call script / greeting message
- Handoff triggers (keywords that transfer to human agent)

---

## 18. Knowledge Brain

**Service Key:** `brain`

**File:** `Knowledge Brain.html`

### PDF Upload
- Upload legal contracts, medical protocols, product guides, pricing sheets
- Stored in Supabase Storage `documents` bucket
- Processed and indexed in `knowledge_base` table

### Text Rules
- Plain-text knowledge entries (manually typed)
- Examples: "We do not handle criminal cases", "Minimum retainer: $5,000"

### Read/Delete View
- List all knowledge entries (PDF + text)
- Preview content
- Delete entries

### AI Routing
- When enabled: AI consults Knowledge Brain before generating responses
- **GPT-4o-mini** for general industries
- **GPT-4o** for law and medical (higher accuracy required)
- Injected into system prompt context window

---

## 19. Appointment Architect

**Service Key:** `architect`

**File:** `App Architect.html`

### Appointment Viewer
- Table of all scheduled appointments from `appointments` table
- Columns: lead name, appointment time, type, status (confirmed/pending/cancelled)
- Click to view details

### Calendar Integration
- `cal_link` field in `org_settings` — Calendly / Cal.com URL
- Widget AI sends this link when lead is ready to book
- Confirmation message triggers `appointments` record creation

### Appointment Notifications
- Pre-meeting SMS/Email brief sent via `cron_handoff_brief` edge function (pg_cron every 5 minutes)
- Sent to closer's `profiles.phone` (mobile)
- Brief includes: lead name, deal value, context summary, conversation highlights

---

## 20. Credit Wallet & Token System

### Two-Layer Token Architecture

| Layer | Table | Purpose |
|---|---|---|
| Display layer | `credit_wallets` / `credit_ledger` | Shows balance in UI |
| Runtime layer | `token_wallets` | What executors read before sending |

**Critical:** Both layers must be updated together. `consume_tokens_v1` reads `token_wallets`. If only `credit_wallets` is updated (e.g., on credit purchase), quota appears added but execution fails at quota check.

### Token Keys
| Key | Used For | Pre-debit Amount |
|---|---|---|
| `sms_msg` | SMS messages | 1 token |
| `wa_msg` | WhatsApp messages | 1 token |
| `email_msg` | Email messages | 1 token |
| `rcs_msg` | RCS messages | 1 token |
| `messenger_msg` | Facebook Messenger | 1 token |
| `voice_min` | Voice call minutes | 5 tokens (settled post-call) |
| `doctor_report` | Revenue Doctor reports | 1 token per report |

### RPCs
- `consume_tokens_v1(p_scope, p_user_id, p_amount)` → returns `{status:'ok'}` or error
- `grant_tokens_core_v1(p_scope, p_user_id, p_amount, p_metadata)` → adds tokens
- `credit_wallet_add_v1` → updates display layer
- `settle_voice_call_tokens_v2` → final voice minute settlement after call

### Top-Up Purchase Flow
1. User clicks "Top Up" in Credit Wallet
2. Selects amount → `create-credit-topup-order` edge function
3. Razorpay checkout
4. On payment: `fulfill-paid-order` calls BOTH `credit_wallet_add_v1` AND `grant_tokens_core_v1`

### Low Balance Alerts
- Edge function: `run-low-balance-alerts` (pg_cron every 15 minutes)
- 24-hour debounce per org per token key
- Sends email + SMS to org admin when balance drops below threshold
- `credit_alert_state` table tracks last-alerted time

### Monthly Reset (Revenue Doctor)
- pg_cron #17: `5 0 1 * *` (1st of month, 12:05am UTC)
- `refresh_doctor_report_credits()` resets `doctor_report` balance
- Enterprise → 999, Voice plan → 10
- Idempotent via `idempotency_key`

---

## 21. Automation Pipeline

### Core Components
| Component | Role |
|---|---|
| `decision_engine` | Decides whether/what to send next |
| `execution_planner` | Creates `execution_tasks` with schedule |
| `execution-dispatcher` | Picks up pending tasks and routes to correct executor |
| `task_sweeper` | Cleans up stale/abandoned tasks |
| `campaign_ticker` | Drives campaign sequence advancement |

### Campaigns
- Stored in `campaigns` + `campaign_leads` tables
- Multi-step automated sequences
- Each step creates an `execution_task` scheduled at the right time
- Supports: SMS, WhatsApp, Email, Voice

### Execution Tasks (`execution_tasks`)
Key columns:
| Column | Notes |
|---|---|
| `plan_id` | NOT NULL — must always have a plan |
| `channel` | sms / wa / voice / email / rcs / messenger |
| `status` | pending → running → completed / failed / dead |
| `scheduled_for` | When to send |
| `attempt` / `max_attempts` | Retry counters |
| `locked_by` / `locked_until` | Worker lease (90s) |
| `metadata` | JSONB — includes `force_content` for takeover |
| `ai_generation_locked` | Prevents duplicate AI generation on retry |

### Weekly ROI Email
- `cron_weekly_roi` (pg_cron every Monday 8am UTC)
- Sends personalized ROI summary to each active org
- Shows: leads contacted, conversations started, appointments booked, estimated value

---

## 22. Platform Hardening & Safety Features

### Kill Switch
- **Platform-level:** `platform_control_flags` table — kills ALL execution globally
- **Org-level:** Per-org flag — kills execution for one org
- All executors check kill switch at position #1 in guard order

### Rate Limiting
- `enforce_rate_limit_v1` RPC — per-org execution rate cap
- Tracked in `rate_limit_buckets`
- Returns 429 when exceeded
- Configurable per org from admin panel

### Dead-Letter Queue
- Tasks failing all retry attempts → `execution_dead_letters`
- Preserved with full context for investigation
- Admin can retry or dismiss

### Webhook Store
- All inbound webhook events stored in `provider_webhook_events`
- Idempotency: duplicate webhooks detected and rejected
- Audit trail for all external events

### Channel Health Monitoring
- `compute_channel_health_v1()` runs every 5 minutes (pg_cron #14)
- Results in `channel_health_current` table
- Tracks: delivery rate, error rate, avg latency per channel per org
- Admin health dashboard shows red/yellow/green indicators

### Delivery Attempts Table
- Every send attempt logged: task_id, provider, provider_id (SID), status, attempt_num, error
- Idempotency guard: `UNIQUE(task_id, attempt_num)` with 23505 error handler

### Security Events
- `security_events` table logs: suspicious API key usage, rate limit violations, kill switch activations
- Feed visible in admin panel

### Conversation State Cleanup
- pg_cron #8 (daily 3am UTC): deletes `conversation_state` records older than 90 days

### PII Protection
- `pii_scrubber.ts`: strips phone/email/name patterns from all AI evidence samples
- Revenue Doctor reports never contain raw PII

---

## 23. Admin RPCs & Database Reference

### Key RPCs
| RPC | Purpose |
|---|---|
| `consume_tokens_v1` | Debit tokens (params: `p_scope`, `p_user_id`, `p_amount`) |
| `grant_tokens_core_v1` | Credit tokens (params: `p_scope`, `p_user_id`, `p_amount`, `p_metadata`) |
| `credit_wallet_add_v1` | Update display-layer wallet |
| `settle_voice_call_tokens_v2` | Final voice minute settlement |
| `is_org_cancelled_v1` | Check org cancellation status |
| `is_kill_switch_enabled_v1` | Check platform/org kill switch |
| `enforce_rate_limit_v1` | Check + increment rate limit bucket |
| `execution_policy_v1` | Combined policy evaluation |
| `resolve_inbound_org_channel_v1` | Find correct org for inbound webhook |
| `approve_bank_transfer` | Admin approves bank transfer payment |
| `mark_intent_awaiting_bank` | Mark billing intent as awaiting bank transfer |
| `create_agency_enterprise_deal` | Create partnership deal |
| `approve_agency_enterprise_deal` | Approve partnership deal |
| `get_agent_leaderboard` | Enterprise leaderboard data |
| `admin_grant_growth_engine` | Enable Growth Engine for org |
| `admin_revoke_growth_engine` | Disable Growth Engine for org |
| `admin_get_growth_metrics` | Founder Dashboard metrics (5 groups) |
| `admin_get_beta_prospects` | Top-50 paying orgs without GE |

### pg_cron Jobs
| ID | Schedule | Job |
|---|---|---|
| 8 | Daily 3am UTC | `cleanup-conversation-state` (90d TTL) |
| 9 | `*/5 * * * *` | `cron_handoff_brief` (pre-meeting alerts) |
| 10 | `0 8 * * 1` | `cron_weekly_roi` (Monday 8am) |
| 11 | `* * * * *` | `process_pending_activations()` |
| 12 | `*/15 * * * *` | `run-low-balance-alerts` |
| 13 | `0 4 * * *` | `run_wallet_ledger_reconciliation()` |
| 14 | `*/5 * * * *` | `compute_channel_health_v1()` |
| 16 | Daily 2am UTC | `process_scheduled_data_deletions()` |
| 17 | `5 0 1 * *` | `refresh_doctor_report_credits()` |

### Key Table Notes
| Table | Critical Notes |
|---|---|
| `api_keys` | Column is `api_key` (not `key`), `name` (not `label`) |
| `decision_plans` | INSERT must include `plan: {}` (jsonb NOT NULL); no `status`/`metadata` columns |
| `leads` | INSERT must include `profile_id: currentUser.id` (NOT NULL) |
| `billing_intents` | UPDATE blocked by RLS — always use `mark_intent_awaiting_bank` RPC |
| `execution_tasks` | `plan_id` NOT NULL; `ai_generation_locked` prevents duplicate AI on retry |

---

## 24. Email & Notification System

### Sender Addresses
| Address | Used By |
|---|---|
| `hello@getsalescloser.com` | `send-welcome-email` (new user onboarding) |
| `support@getsalescloser.com` | `send-agent-invite`, `executor_email`, `cron_handoff_brief`, `cron_weekly_roi`, cancellation emails |
| `billing@getsalescloser.com` | `invoice-reminder-worker`, partial payment alerts |

### Transactional Emails
| Trigger | Template | Sender |
|---|---|---|
| New signup | Welcome + onboarding guide | hello@ |
| Agent invited | Invitation with claim link | support@ |
| Pre-meeting | Deal brief (lead name, context, highlights) | support@ |
| Weekly | ROI summary report | support@ |
| Low balance | Credit balance warning | support@ |
| Cancellation | Confirmation + refund details | support@ |
| Data export | CSV download link | support@ |
| Payment invoice | Monthly invoice | billing@ |
| Partial payment | Payment alert | billing@ |

---

## 25. Architecture Patterns & Key Conventions

### Auth Guard Pattern
```javascript
requireAuth({
  requireOnboarding: false,  // for role pages
  onAuthenticated: (profile, user, sb) => {
    // page logic here
  }
});
```
Every protected page requires: `<script src="auth.js">`, `<div id="auth-loader">` (visible), `<div id="page-content">` (hidden).

### Entitlement Check Pattern
```javascript
const { data: svc } = await sb.from('org_services')
  .select('status')
  .eq('org_id', membership.org_id)
  .eq('service_key', 'sentinel')
  .maybeSingle();
if (svc?.status !== 'active') window.location.href = 'billing.html?lock=sentinel';
```

### Growth Engine Locked-Preview Pattern (NOT a redirect)
```javascript
if (svc?.status !== 'active') {
  document.getElementById('auth-loader').classList.add('hidden');
  document.getElementById('locked-preview').classList.remove('hidden');
  return; // stays on page, no redirect
}
```

### Admin JWT Pattern
```javascript
// MUST read fresh JWT on every admin call (expires after 1h)
const token = localStorage.getItem('supabase.auth.token');
const { data } = await sb.functions.invoke('my-function', {
  headers: { Authorization: `Bearer ${token}` },
  body: { ... }
});
```

### Supabase JS v2 Error Handling
```javascript
// CORRECT: .catch() not available on PostgrestBuilder
const { data, error } = await sb.from('table').select('*')
  .then(undefined, (err) => ({ data: null, error: err }));

// WRONG: .catch() will throw "not a function"
// sb.from('table').select('*').catch(err => ...)
```

### Human Takeover Pattern
1. `leads.ai_paused = true` → AI stops generating
2. `execution_tasks INSERT` with `metadata.force_content = '<text>'` → executor sends directly
3. `leads.ai_paused = false` → AI resumes

### Pricing Hierarchy (index.html + pricing.html)
```
Voice + all 4 modules + channels = $349 (maximum combined base)
Sentinel + 2 modules = $249
Sentinel only = $49-$99 (depends on channels)
Brain/Architect require Sentinel OR Voice (else deploy disabled)
Growth Engine = $660 (always independent)
```

### Service Keys Reference
| Key | Module | Pages |
|---|---|---|
| `sentinel` | Instant Sentinel | sentinel.html |
| `voice` | Voice Liaison + Revenue Doctor | Voice Liaison.html, revenue_doctor.html |
| `brain` | Knowledge Brain | Knowledge Brain.html |
| `architect` | Appointment Architect | App Architect.html |
| `growth_engine` | Growth Engine | growth_dashboard.html |

---

*Document end — GetSalesCloser Feature Reference v1.0 (Session 28)*
