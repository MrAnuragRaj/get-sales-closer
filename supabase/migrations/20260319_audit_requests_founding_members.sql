-- Migration: audit_requests + founding_members
-- Session 32 — Speed-to-Lead Audit + Founding Member tracking

-- ── AUDIT REQUESTS ────────────────────────────────────────────────────────────
-- Tracks each Speed-to-Lead audit submission from the landing page.
-- One row per prospect submission.
CREATE TABLE IF NOT EXISTS audit_requests (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id             uuid REFERENCES leads(id) ON DELETE SET NULL,
    org_id              uuid REFERENCES organizations(id) ON DELETE SET NULL,
    prospect_name       text NOT NULL,
    prospect_email      text NOT NULL,
    prospect_phone      text,
    website_url         text NOT NULL,
    industry            text,
    form_found          boolean NOT NULL DEFAULT false,
    form_submitted      boolean NOT NULL DEFAULT false,
    reply_received      boolean NOT NULL DEFAULT false,
    reply_received_at   timestamptz,
    report_sent         boolean NOT NULL DEFAULT false,
    report_sent_at      timestamptz,
    marketing_consent   boolean NOT NULL DEFAULT false,
    created_at          timestamptz NOT NULL DEFAULT now()
);

-- Index for the cron query: find un-reported requests older than 6 hours
CREATE INDEX IF NOT EXISTS idx_audit_requests_pending_report
    ON audit_requests (created_at)
    WHERE report_sent = false;

-- RLS: no direct client access — edge function uses service role
ALTER TABLE audit_requests ENABLE ROW LEVEL SECURITY;

-- ── FOUNDING MEMBERS ──────────────────────────────────────────────────────────
-- Persists founding member status after a successful payment.
-- Inserted by fulfill-paid-order when pricing_snapshot.is_founding_member = true.
CREATE TABLE IF NOT EXISTS founding_members (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid REFERENCES organizations(id) ON DELETE CASCADE,
    user_email      text NOT NULL,
    claimed_at      timestamptz NOT NULL DEFAULT now(),
    discount_pct    integer NOT NULL DEFAULT 25,
    locked_forever  boolean NOT NULL DEFAULT true
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_founding_members_org
    ON founding_members (org_id);

-- RLS: org members can read their own row; no client writes
ALTER TABLE founding_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "founding_members_self_read" ON founding_members
    FOR SELECT
    USING (
        org_id IN (
            SELECT org_id FROM org_members WHERE user_id = auth.uid()
        )
    );
