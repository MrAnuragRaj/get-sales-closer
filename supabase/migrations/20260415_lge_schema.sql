-- Migration: Lead Generation Engine (LGE) — Full Schema
-- Session: LGE Session 1
-- Purpose:
--   9 tables, strict state machine, idempotency, versioning, audit trail,
--   admin grant/revoke RPCs for lead_gen entitlement.
--
-- Tables:
--   lge_campaigns          — campaign config + ICP + per-org mode (off/shadow/active)
--   lge_raw_leads          — raw lead records with state machine + idempotency
--   lge_enrichment         — Apollo/Hunter enrichment results per lead
--   lge_scores             — fit + confidence scores with versioning
--   lge_context            — GPT-generated context with prompt versioning
--   lge_provider_config    — encrypted BYO API keys per org per provider
--   lge_provider_calls     — per-lead provider call audit log
--   lge_outcomes           — outcome feedback loop (no_reply/replied/booked/closed)
--   lge_decision_logs      — full forensic decision record per lead
--
-- RPCs:
--   admin_grant_lead_gen(p_org_id)  — upsert org_services lead_gen → active
--   admin_revoke_lead_gen(p_org_id) — set org_services lead_gen → inactive

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. lge_campaigns
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lge_campaigns (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'paused', 'archived')),
    mode            TEXT NOT NULL DEFAULT 'off'
                        CHECK (mode IN ('off', 'shadow', 'active')),
    icp_config      JSONB NOT NULL DEFAULT '{}',
    -- icp_config shape:
    -- {
    --   industry: string[],
    --   company_size: string[],        -- "1-10", "11-50", "51-200", "201-500", "500+"
    --   geography: string[],
    --   designations: string[],
    --   fit_weight: number,            -- default 0.6
    --   confidence_weight: number      -- default 0.4
    -- }
    max_leads_per_day  INT NOT NULL DEFAULT 100,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by      UUID REFERENCES auth.users(id)
);

CREATE INDEX IF NOT EXISTS idx_lge_campaigns_org_id ON public.lge_campaigns(org_id);
ALTER TABLE public.lge_campaigns ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org members can manage their campaigns"
    ON public.lge_campaigns
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.org_members
            WHERE org_id = lge_campaigns.org_id
              AND user_id = auth.uid()
        )
    );

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. lge_raw_leads  (state machine enforced via CHECK constraint)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lge_raw_leads (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id         UUID NOT NULL REFERENCES public.lge_campaigns(id) ON DELETE CASCADE,
    org_id              UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    -- contact info
    name                TEXT,
    email               TEXT,
    phone               TEXT,
    company             TEXT,
    source              TEXT NOT NULL DEFAULT 'csv',   -- 'csv' | 'apollo_export' | 'manual'
    raw_data            JSONB NOT NULL DEFAULT '{}',
    -- state machine
    status              TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','enriching','scored','review_queue','pushed','discarded','failed')),
    -- retry
    attempt             INT NOT NULL DEFAULT 0,
    max_attempts        INT NOT NULL DEFAULT 3,
    locked_by           TEXT,
    locked_until        TIMESTAMPTZ,
    -- idempotency: org_id + campaign_id + normalized contact + company
    idempotency_key     TEXT NOT NULL,
    -- GSC handoff idempotency — prevents double-push
    gsc_handoff_key     TEXT,
    gsc_lead_id         UUID,   -- set after successful push to hook_inbound
    last_error          TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dedupe: same lead never ingested twice in same campaign
CREATE UNIQUE INDEX IF NOT EXISTS uq_lge_raw_leads_idempotency
    ON public.lge_raw_leads(idempotency_key);

-- Prevent double-push to GSC
CREATE UNIQUE INDEX IF NOT EXISTS uq_lge_raw_leads_gsc_handoff
    ON public.lge_raw_leads(gsc_handoff_key)
    WHERE gsc_handoff_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_lge_raw_leads_campaign  ON public.lge_raw_leads(campaign_id);
CREATE INDEX IF NOT EXISTS idx_lge_raw_leads_org       ON public.lge_raw_leads(org_id);
CREATE INDEX IF NOT EXISTS idx_lge_raw_leads_status    ON public.lge_raw_leads(status);
-- Worker poll index: pending leads ready to process
CREATE INDEX IF NOT EXISTS idx_lge_raw_leads_worker
    ON public.lge_raw_leads(org_id, status, attempt, locked_until)
    WHERE status IN ('pending', 'enriching');

ALTER TABLE public.lge_raw_leads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org members can view their raw leads"
    ON public.lge_raw_leads
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.org_members
            WHERE org_id = lge_raw_leads.org_id
              AND user_id = auth.uid()
        )
    );

-- Worker and ingest use service role (bypasses RLS)

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. lge_enrichment
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lge_enrichment (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    raw_lead_id         UUID NOT NULL REFERENCES public.lge_raw_leads(id) ON DELETE CASCADE,
    industry            TEXT,
    company_size        TEXT,
    designation         TEXT,
    email_verified      BOOLEAN,
    phone_verified      BOOLEAN,
    confidence_score    NUMERIC(5,2),   -- 0–100
    sources_json        JSONB NOT NULL DEFAULT '{}',
    enriched_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_lge_enrichment_lead ON public.lge_enrichment(raw_lead_id);
CREATE INDEX IF NOT EXISTS idx_lge_enrichment_lead ON public.lge_enrichment(raw_lead_id);
ALTER TABLE public.lge_enrichment ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org members can view enrichment via lead"
    ON public.lge_enrichment
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.lge_raw_leads rl
            JOIN public.org_members om ON om.org_id = rl.org_id
            WHERE rl.id = lge_enrichment.raw_lead_id
              AND om.user_id = auth.uid()
        )
    );

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. lge_scores
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lge_scores (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    raw_lead_id             UUID NOT NULL REFERENCES public.lge_raw_leads(id) ON DELETE CASCADE,
    fit_score               NUMERIC(5,2) NOT NULL,          -- 0–100
    confidence_score        NUMERIC(5,2) NOT NULL,          -- 0–100
    total_score             NUMERIC(5,2) NOT NULL,          -- weighted composite
    scoring_version         TEXT NOT NULL DEFAULT 'v1',
    routing_policy_version  TEXT NOT NULL DEFAULT 'v1',
    scored_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_lge_scores_lead ON public.lge_scores(raw_lead_id);
CREATE INDEX IF NOT EXISTS idx_lge_scores_lead  ON public.lge_scores(raw_lead_id);
CREATE INDEX IF NOT EXISTS idx_lge_scores_total ON public.lge_scores(total_score);
ALTER TABLE public.lge_scores ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org members can view scores via lead"
    ON public.lge_scores
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.lge_raw_leads rl
            JOIN public.org_members om ON om.org_id = rl.org_id
            WHERE rl.id = lge_scores.raw_lead_id
              AND om.user_id = auth.uid()
        )
    );

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. lge_context
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lge_context (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    raw_lead_id                 UUID NOT NULL REFERENCES public.lge_raw_leads(id) ON DELETE CASCADE,
    reason_to_reach_out         TEXT,
    pain_point_hypothesis       TEXT,
    recommended_pitch_angle     TEXT,
    prompt_version              TEXT NOT NULL DEFAULT 'v1',
    generated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_lge_context_lead ON public.lge_context(raw_lead_id);
CREATE INDEX IF NOT EXISTS idx_lge_context_lead ON public.lge_context(raw_lead_id);
ALTER TABLE public.lge_context ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org members can view context via lead"
    ON public.lge_context
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.lge_raw_leads rl
            JOIN public.org_members om ON om.org_id = rl.org_id
            WHERE rl.id = lge_context.raw_lead_id
              AND om.user_id = auth.uid()
        )
    );

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. lge_provider_config  (encrypted BYO API keys)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lge_provider_config (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    provider            TEXT NOT NULL CHECK (provider IN ('apollo', 'hunter')),
    api_key_encrypted   TEXT NOT NULL,  -- AES-GCM encrypted, never returned to frontend
    is_active           BOOLEAN NOT NULL DEFAULT true,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by          UUID REFERENCES auth.users(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_lge_provider_config ON public.lge_provider_config(org_id, provider);
CREATE INDEX IF NOT EXISTS idx_lge_provider_config_org ON public.lge_provider_config(org_id);
ALTER TABLE public.lge_provider_config ENABLE ROW LEVEL SECURITY;

-- Members can see that a key exists (but key value never returned — handled in edge fn)
CREATE POLICY "org members can view provider config"
    ON public.lge_provider_config
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.org_members
            WHERE org_id = lge_provider_config.org_id
              AND user_id = auth.uid()
        )
    );

-- Only org members can upsert/delete their own provider config (via edge fn)
CREATE POLICY "org members can manage provider config"
    ON public.lge_provider_config
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.org_members
            WHERE org_id = lge_provider_config.org_id
              AND user_id = auth.uid()
        )
    );

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. lge_provider_calls  (per-lead provider call audit)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lge_provider_calls (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    raw_lead_id     UUID NOT NULL REFERENCES public.lge_raw_leads(id) ON DELETE CASCADE,
    provider        TEXT NOT NULL CHECK (provider IN ('apollo', 'hunter')),
    status          TEXT NOT NULL CHECK (status IN ('success', 'failed', 'timeout', 'skipped')),
    error_detail    TEXT,
    called_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lge_provider_calls_lead     ON public.lge_provider_calls(raw_lead_id);
CREATE INDEX IF NOT EXISTS idx_lge_provider_calls_provider ON public.lge_provider_calls(provider, status);
ALTER TABLE public.lge_provider_calls ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org members can view provider calls via lead"
    ON public.lge_provider_calls
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.lge_raw_leads rl
            JOIN public.org_members om ON om.org_id = rl.org_id
            WHERE rl.id = lge_provider_calls.raw_lead_id
              AND om.user_id = auth.uid()
        )
    );

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. lge_outcomes  (outcome feedback loop — future-proof schema)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lge_outcomes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    raw_lead_id     UUID NOT NULL REFERENCES public.lge_raw_leads(id) ON DELETE CASCADE,
    gsc_lead_id     UUID,
    outcome_stage   TEXT NOT NULL
                        CHECK (outcome_stage IN ('no_reply','replied','booked','closed','qualified','won','lost')),
    outcome_source  TEXT NOT NULL DEFAULT 'sync',   -- 'sync' | 'manual'
    observed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    confidence      NUMERIC(3,2) DEFAULT 1.0        -- 0.0–1.0
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_lge_outcomes_lead ON public.lge_outcomes(raw_lead_id);
CREATE INDEX IF NOT EXISTS idx_lge_outcomes_lead  ON public.lge_outcomes(raw_lead_id);
CREATE INDEX IF NOT EXISTS idx_lge_outcomes_stage ON public.lge_outcomes(outcome_stage);
ALTER TABLE public.lge_outcomes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org members can view outcomes via lead"
    ON public.lge_outcomes
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.lge_raw_leads rl
            JOIN public.org_members om ON om.org_id = rl.org_id
            WHERE rl.id = lge_outcomes.raw_lead_id
              AND om.user_id = auth.uid()
        )
    );

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. lge_decision_logs  (forensic decision record per lead)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lge_decision_logs (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    raw_lead_id             UUID NOT NULL REFERENCES public.lge_raw_leads(id) ON DELETE CASCADE,
    scoring_version         TEXT NOT NULL DEFAULT 'v1',
    routing_policy_version  TEXT NOT NULL DEFAULT 'v1',
    prompt_version          TEXT NOT NULL DEFAULT 'v1',
    score_inputs_json       JSONB NOT NULL DEFAULT '{}',
    score_outputs_json      JSONB NOT NULL DEFAULT '{}',
    routing_decision        TEXT NOT NULL
                                CHECK (routing_decision IN ('auto_push','review_queue','discard','shadow_only','failed')),
    routing_reason          TEXT,
    model_output_json       JSONB NOT NULL DEFAULT '{}',
    actor_user_id           UUID,   -- set when a human manually overrides routing
    override_note           TEXT,   -- reason provided by human operator on manual override
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lge_decision_logs_lead     ON public.lge_decision_logs(raw_lead_id);
CREATE INDEX IF NOT EXISTS idx_lge_decision_logs_decision ON public.lge_decision_logs(routing_decision);
ALTER TABLE public.lge_decision_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org members can view decision logs via lead"
    ON public.lge_decision_logs
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.lge_raw_leads rl
            JOIN public.org_members om ON om.org_id = rl.org_id
            WHERE rl.id = lge_decision_logs.raw_lead_id
              AND om.user_id = auth.uid()
        )
    );

-- ─────────────────────────────────────────────────────────────────────────────
-- updated_at auto-trigger
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.lge_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

CREATE TRIGGER trg_lge_campaigns_updated_at
    BEFORE UPDATE ON public.lge_campaigns
    FOR EACH ROW EXECUTE FUNCTION public.lge_set_updated_at();

CREATE TRIGGER trg_lge_raw_leads_updated_at
    BEFORE UPDATE ON public.lge_raw_leads
    FOR EACH ROW EXECUTE FUNCTION public.lge_set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- Admin RPCs: grant / revoke lead_gen entitlement
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.admin_grant_lead_gen(p_org_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = true
    ) THEN
        RAISE EXCEPTION 'admin_grant_lead_gen: caller is not a platform admin';
    END IF;

    INSERT INTO org_services (org_id, service_key, status)
    VALUES (p_org_id, 'lead_gen', 'active')
    ON CONFLICT (org_id, service_key) DO UPDATE
        SET status = 'active';
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_revoke_lead_gen(p_org_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = true
    ) THEN
        RAISE EXCEPTION 'admin_revoke_lead_gen: caller is not a platform admin';
    END IF;

    UPDATE org_services
    SET status = 'inactive'
    WHERE org_id = p_org_id AND service_key = 'lead_gen';
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- RPC: get_lge_campaign_stats(p_org_id)
-- Returns per-campaign lead counts by status for the observability panel
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_lge_campaign_stats(p_org_id UUID)
RETURNS TABLE (
    campaign_id     UUID,
    campaign_name   TEXT,
    mode            TEXT,
    status          TEXT,
    total           BIGINT,
    pending_count   BIGINT,
    enriching_count BIGINT,
    scored_count    BIGINT,
    review_count    BIGINT,
    pushed_count    BIGINT,
    discarded_count BIGINT,
    failed_count    BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- caller must be org member
    IF NOT EXISTS (
        SELECT 1 FROM org_members WHERE org_id = p_org_id AND user_id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'get_lge_campaign_stats: not an org member';
    END IF;

    RETURN QUERY
    SELECT
        c.id                                                            AS campaign_id,
        c.name                                                          AS campaign_name,
        c.mode,
        c.status,
        COUNT(rl.id)                                                    AS total,
        COUNT(rl.id) FILTER (WHERE rl.status = 'pending')              AS pending_count,
        COUNT(rl.id) FILTER (WHERE rl.status = 'enriching')            AS enriching_count,
        COUNT(rl.id) FILTER (WHERE rl.status = 'scored')               AS scored_count,
        COUNT(rl.id) FILTER (WHERE rl.status = 'review_queue')         AS review_count,
        COUNT(rl.id) FILTER (WHERE rl.status = 'pushed')               AS pushed_count,
        COUNT(rl.id) FILTER (WHERE rl.status = 'discarded')            AS discarded_count,
        COUNT(rl.id) FILTER (WHERE rl.status = 'failed')               AS failed_count
    FROM lge_campaigns c
    LEFT JOIN lge_raw_leads rl ON rl.campaign_id = c.id
    WHERE c.org_id = p_org_id
    GROUP BY c.id, c.name, c.mode, c.status
    ORDER BY c.created_at DESC;
END;
$$;
