-- Migration: decision_plans idempotency constraint
-- Applied directly to production 2026-04-02 (Session 35).
-- This file records it in the repo so the constraint is tracked as code.
--
-- Purpose: prevent duplicate decision plans for the same lead + trigger.
-- The constraint is the authoritative race guard in decision_engine:
-- two concurrent webhooks both try INSERT; one succeeds, one gets 23505.
-- The 23505 handler in decision_engine fetches and returns the existing row.

ALTER TABLE decision_plans
  ADD CONSTRAINT IF NOT EXISTS decision_plans_lead_id_trigger_unique
  UNIQUE (lead_id, trigger);
