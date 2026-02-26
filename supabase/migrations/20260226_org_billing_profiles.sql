-- ============================================================
-- Migration: org_billing_profiles
-- Purpose: Billing lock status per org, read by executor_voice
--          and voice_turn edge functions (fail-closed guard).
--          A missing row = "none" (not locked).
--          A query ERROR = fail-closed (blocks all voice spend).
--          This table MUST exist for voice execution to work.
-- Run in: Supabase Dashboard → SQL Editor
-- ============================================================

CREATE TABLE IF NOT EXISTS org_billing_profiles (
    id                  uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
    org_id              uuid        NOT NULL UNIQUE,
    billing_lock_status text        NOT NULL DEFAULT 'none',
    locked_at           timestamptz,
    locked_reason       text,
    created_at          timestamptz DEFAULT now(),
    updated_at          timestamptz DEFAULT now()
);

-- RLS
ALTER TABLE org_billing_profiles ENABLE ROW LEVEL SECURITY;

-- Service role (edge functions) can read/write
CREATE POLICY "service_role_all_org_billing_profiles"
    ON org_billing_profiles
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Org members can read their own billing profile (dashboard display)
CREATE POLICY "org_members_select_org_billing_profiles"
    ON org_billing_profiles
    FOR SELECT
    TO authenticated
    USING (
        org_id IN (
            SELECT org_id FROM org_members WHERE user_id = auth.uid()
        )
    );

-- Index for fast lookup by org_id
CREATE INDEX IF NOT EXISTS idx_org_billing_profiles_org_id
    ON org_billing_profiles (org_id);

-- ============================================================
-- NOTE: billing_lock_status values:
--   'none'          = not locked (normal operation)
--   'soft_lock'     = warnings only, execution still allowed
--   'hard_lock'     = execution blocked (overspend/fraud)
--   'manual_lock'   = admin-blocked org
-- ============================================================
