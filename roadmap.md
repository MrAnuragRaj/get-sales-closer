\# MISSION: GetSalesCloser - Pre-Launch Ledger 



\## Context \& Objective

We are shifting from "foundation building" to "growth and retention engineering." We must implement a strict set of features to handle inbound data ingestion, psychological trust for enterprise users, and actionable ROI reporting.



Please read and ingest this roadmap. \*\*Do not begin coding yet.\*\* Acknowledge this plan, and I will instruct you when to begin Sprint 1.



---



\## PART 1: The Pre-Launch Ledger (Feature Scope)



\### 1. The Ingestion Engine \& Data Sourcing

We are the "Conversion Engine," so we must build bridges to where the client's leads currently sit.

\* \*\*Webhook Pipeline:\*\* Build an `api\_keys` table for Org security and a master `hook\_inbound` Edge Function. We need normalization schemas to catch leads from GoHighLevel, Zapier/Make, HubSpot, Apollo, and Facebook Lead Ads, and instantly push them to our `leads` and `execution\_tasks` tables.

\* \*\*The "Site Liaison" (Web Agent):\*\* A lightweight Javascript widget (`embed.js`) that clients install on their site to act as a real-time lead trap, interacting with our existing GPT-4o routing logic and Cal.com booking system.



\### 2. Persona System 2.0 (The Guardrails)

Our AI persona database must support high-liability verticals (Legal, Medical, Real Estate, Home Services). Ensure the schema supports:

1\. \*\*AI Agent Name:\*\* (e.g., 'Alex')

2\. \*\*Tone Preset:\*\* (Formal, Warm, Casual, Urgent, Educational, Neutral)

3\. \*\*Industry Language Pack:\*\* (Hardcoded vocab per vertical)

4\. \*\*Custom Terminology Overrides:\*\* (Key-value swaps, e.g., 'appointment' -> 'discovery call')

5\. \*\*Strict Compliance Guardrails:\*\* (Hardcoded restrictions, e.g., "Never provide legal advice")

6\. \*\*Bot Disclosure Policy:\*\* (Rules on how to answer "Are you a robot?")

7\. \*\*Primary Conversion Objective:\*\* (The finish line: e.g., "Drop Cal.com link")



\### 3. The Trust \& Retention UX (The Driver's Seat)

\* \*\*Live Wire \& Intercept (Trust):\*\* A real-time websocket feed on the Agent Dashboard showing active AI conversations. Must include a "Takeover" button that pauses the AI (`campaigns\_paused` flag) for that specific lead so the human can intervene seamlessly.

\* \*\*Red Carpet Handoff (Empowerment):\*\* A cron job that triggers 5 minutes before a booked Cal.com meeting, sending the assigned human closer a 3-bullet SMS summary of the lead (extracted from the AI's Dual-Layer Memory).

\* \*\*3-Minute "Mirror Test" (Time-to-Value):\*\* A post-signup onboarding flow where the admin enters their own phone number and our system instantly texts/calls them to prove the AI's capability.

\* \*\*Shadow ROI Receipt (Retention):\*\* An automated email sent every Monday morning to the `org\_admin` detailing unit economics (e.g., "We disqualified 84 tire-kickers, saving 14 hours. Equivalent human cost: $1,400. Your AI cost: $112").



---



\## PART 2: The Sprint Execution Timeline



To hit the launch deadline, we will execute in strict, isolated sprints. 

\*Do not jump ahead. Wait for explicit authorization to begin each sprint.\*



\* \*\*SPRINT 1: Ingestion \& Site Liaison.\*\* (Focus: `api\_keys` schema, hook edge functions, data normalization, and the `embed.js` web widget).

\* \*\*SPRINT 2: Live Wire \& Persona Guardrails.\*\* (Focus: Websocket real-time UI, the "Takeover" DB logic, and upgrading the Persona table schema).

\* \*\*SPRINT 3: The "Aha!" Onboarding.\*\* (Focus: Frontend "Mirror Test" flow triggering the immediate AI dispatch).

\* \*\*SPRINT 4: Automations \& Handoff.\*\* (Focus: Cron jobs for the Cal.com Red Carpet Handoff and the Shadow ROI reporting).

\* \*\*SPRINT 5: Polish \& Launch.\*\* (Focus: QA, billing hooks, final deployment).



\*\*Action Required from Claude:\*\* Please confirm you have ingested this architectural roadmap and understand the priorities. Ask any clarifying questions about the Supabase schema, and state "Ready for Sprint 1 instructions" when done.

