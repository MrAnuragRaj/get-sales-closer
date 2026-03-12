-- Migration: admin_get_growth_metrics() + admin_get_beta_prospects()
-- Purpose:
--   Aggregates all Growth Engine KPIs into a single RPC call for the
--   Founder Dashboard in admin.html. All growth schema queries are
--   wrapped in exception blocks so the function works even before the
--   growth schema tables are populated.
--
-- Called from admin.html via: supabase.rpc('admin_get_growth_metrics')
-- Requires: profiles.is_admin = true on the calling user.

CREATE OR REPLACE FUNCTION public.admin_get_growth_metrics()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    -- Acquisition
    v_new_users_today     bigint  := 0;
    v_new_users_7d        bigint  := 0;
    v_ge_active_orgs      bigint  := 0;
    v_total_active_orgs   bigint  := 0;
    v_attach_rate         numeric := 0;
    v_mrr_estimate        numeric := 0;

    -- Activation (growth schema)
    v_activated_orgs      bigint  := 0;
    v_activation_rate     numeric := 0;
    v_avg_ttfv_hours      numeric := NULL;

    -- Engagement pipeline (growth schema)
    v_total_opps          bigint  := 0;
    v_auto_approved       bigint  := 0;
    v_pending_review      bigint  := 0;
    v_executing           bigint  := 0;
    v_failed              bigint  := 0;
    v_trust_rate          numeric := 0;
    v_opps_today          bigint  := 0;

    -- Attribution (growth schema)
    v_total_leads         bigint  := 0;
    v_attributed_leads    bigint  := 0;
    v_attribution_rate    numeric := 0;
    v_deals_influenced    bigint  := 0;

    -- Retention
    v_cohort_30d          bigint  := 0;
    v_retained_30d        bigint  := 0;
    v_retention_30d       numeric := NULL;
    v_cohort_90d          bigint  := 0;
    v_retained_90d        bigint  := 0;
    v_retention_90d       numeric := NULL;

    -- Growth schema available flag
    v_growth_schema_ready boolean := false;
BEGIN
    -- Auth guard
    IF NOT EXISTS (
        SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = true
    ) THEN
        RAISE EXCEPTION 'admin_get_growth_metrics: caller is not a platform admin';
    END IF;

    -- ── Acquisition ─────────────────────────────────────────────────────────────
    SELECT COUNT(*) INTO v_new_users_today
    FROM profiles WHERE created_at >= CURRENT_DATE;

    SELECT COUNT(*) INTO v_new_users_7d
    FROM profiles WHERE created_at >= (NOW() - INTERVAL '7 days');

    SELECT COUNT(*) INTO v_ge_active_orgs
    FROM org_services WHERE service_key = 'growth_engine' AND status = 'active';

    SELECT COUNT(DISTINCT org_id) INTO v_total_active_orgs
    FROM org_services WHERE status = 'active';

    v_attach_rate := CASE WHEN v_total_active_orgs > 0
        THEN ROUND((v_ge_active_orgs::numeric / v_total_active_orgs) * 100, 1)
        ELSE 0 END;

    -- MRR estimate: GE orgs × $660 (add-on contribution only)
    v_mrr_estimate := v_ge_active_orgs * 660;

    SELECT COUNT(*) INTO v_total_leads FROM leads;

    -- ── Retention cohorts ────────────────────────────────────────────────────────
    -- 30-day cohort: orgs granted access > 30 days ago
    SELECT COUNT(*) INTO v_cohort_30d FROM org_services
    WHERE service_key = 'growth_engine' AND created_at <= (NOW() - INTERVAL '30 days');

    SELECT COUNT(*) INTO v_retained_30d FROM org_services
    WHERE service_key = 'growth_engine' AND status = 'active'
    AND created_at <= (NOW() - INTERVAL '30 days');

    v_retention_30d := CASE WHEN v_cohort_30d > 0
        THEN ROUND((v_retained_30d::numeric / v_cohort_30d) * 100, 1)
        ELSE NULL END;

    -- 90-day cohort
    SELECT COUNT(*) INTO v_cohort_90d FROM org_services
    WHERE service_key = 'growth_engine' AND created_at <= (NOW() - INTERVAL '90 days');

    SELECT COUNT(*) INTO v_retained_90d FROM org_services
    WHERE service_key = 'growth_engine' AND status = 'active'
    AND created_at <= (NOW() - INTERVAL '90 days');

    v_retention_90d := CASE WHEN v_cohort_90d > 0
        THEN ROUND((v_retained_90d::numeric / v_cohort_90d) * 100, 1)
        ELSE NULL END;

    -- ── Growth schema metrics ────────────────────────────────────────────────────
    BEGIN
        -- Opportunity pipeline counts
        SELECT
            COUNT(*),
            COUNT(*) FILTER (WHERE status = 'auto_approved'),
            COUNT(*) FILTER (WHERE status = 'pending_review'),
            COUNT(*) FILTER (WHERE status = 'executing'),
            COUNT(*) FILTER (WHERE status IN ('failed','expired')),
            COUNT(*) FILTER (WHERE updated_at >= CURRENT_DATE)
        INTO v_total_opps, v_auto_approved, v_pending_review, v_executing, v_failed, v_opps_today
        FROM growth.engagement_opportunities;

        -- Automation trust rate: auto_approved / (auto_approved + pending_review)
        -- i.e. of the opportunities AI scored, what % were approved automatically
        v_trust_rate := CASE WHEN (v_auto_approved + v_pending_review) > 0
            THEN ROUND((v_auto_approved::numeric / (v_auto_approved + v_pending_review)) * 100, 1)
            ELSE 0 END;

        -- Activated orgs: GE orgs that have at least one opportunity discovered
        SELECT COUNT(DISTINCT e.org_id) INTO v_activated_orgs
        FROM growth.engagement_opportunities e
        INNER JOIN org_services s
            ON s.org_id = e.org_id AND s.service_key = 'growth_engine' AND s.status = 'active';

        v_activation_rate := CASE WHEN v_ge_active_orgs > 0
            THEN ROUND((v_activated_orgs::numeric / v_ge_active_orgs) * 100, 1)
            ELSE 0 END;

        -- Average Time to First Value:
        -- hours from org_services.created_at → first engagement_opportunity.discovered_at
        SELECT AVG(
            EXTRACT(EPOCH FROM (first_opp_at - grant_at)) / 3600.0
        ) INTO v_avg_ttfv_hours
        FROM (
            SELECT
                s.org_id,
                s.created_at AS grant_at,
                MIN(e.discovered_at) AS first_opp_at
            FROM org_services s
            INNER JOIN growth.engagement_opportunities e ON e.org_id = s.org_id
            WHERE s.service_key = 'growth_engine' AND s.status = 'active'
            GROUP BY s.org_id, s.created_at
        ) ttfv
        WHERE first_opp_at IS NOT NULL AND first_opp_at > grant_at;

        v_growth_schema_ready := true;
    EXCEPTION WHEN OTHERS THEN
        -- Growth schema tables not yet populated or don't exist
        v_growth_schema_ready := false;
    END;

    -- ── Attribution ──────────────────────────────────────────────────────────────
    BEGIN
        SELECT COUNT(DISTINCT lead_id) INTO v_attributed_leads
        FROM growth.revenue_attributions;

        SELECT COUNT(*) INTO v_deals_influenced
        FROM growth.revenue_attributions;
    EXCEPTION WHEN OTHERS THEN
        v_attributed_leads := 0;
        v_deals_influenced := 0;
    END;

    v_attribution_rate := CASE WHEN v_total_leads > 0
        THEN ROUND((v_attributed_leads::numeric / v_total_leads) * 100, 1)
        ELSE 0 END;

    -- ── Compose result ────────────────────────────────────────────────────────────
    RETURN jsonb_build_object(
        'computed_at',           NOW(),
        'growth_schema_ready',   v_growth_schema_ready,

        'acquisition', jsonb_build_object(
            'new_users_today',   v_new_users_today,
            'new_users_7d',      v_new_users_7d,
            'ge_active_orgs',    v_ge_active_orgs,
            'total_active_orgs', v_total_active_orgs,
            'attach_rate_pct',   v_attach_rate,
            'mrr_estimate',      v_mrr_estimate
        ),

        'activation', jsonb_build_object(
            'activated_orgs',        v_activated_orgs,
            'activation_rate_pct',   v_activation_rate,
            'avg_ttfv_hours',        v_avg_ttfv_hours,
            'target_activation_pct', 40,
            'target_ttfv_hours',     0.25
        ),

        'engagement', jsonb_build_object(
            'total',             v_total_opps,
            'auto_approved',     v_auto_approved,
            'pending_review',    v_pending_review,
            'executing',         v_executing,
            'failed',            v_failed,
            'today',             v_opps_today,
            'trust_rate_pct',    v_trust_rate,
            'target_trust_pct',  50
        ),

        'attribution', jsonb_build_object(
            'total_leads',          v_total_leads,
            'attributed_leads',     v_attributed_leads,
            'attribution_rate_pct', v_attribution_rate,
            'deals_influenced',     v_deals_influenced
        ),

        'retention', jsonb_build_object(
            'cohort_30d',           v_cohort_30d,
            'retained_30d',         v_retained_30d,
            'retention_30d_pct',    v_retention_30d,
            'cohort_90d',           v_cohort_90d,
            'retained_90d',         v_retained_90d,
            'retention_90d_pct',    v_retention_90d,
            'target_30d_pct',       85,
            'target_90d_pct',       70
        )
    );
END;
$$;


-- ── Beta Prospect Pipeline ────────────────────────────────────────────────────
-- Returns orgs that do NOT have growth_engine active, sorted by their activity
-- level (lead count) — so the admin can see the best beta targets at a glance.

CREATE OR REPLACE FUNCTION public.admin_get_beta_prospects()
RETURNS TABLE (
    org_id        uuid,
    org_name      text,
    owner_name    text,
    owner_email   text,
    org_type      text,
    lead_count    bigint,
    has_sentinel  boolean,
    created_at    timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = true
    ) THEN
        RAISE EXCEPTION 'admin_get_beta_prospects: caller is not a platform admin';
    END IF;

    RETURN QUERY
    SELECT
        o.id                                              AS org_id,
        o.name                                            AS org_name,
        p.full_name                                       AS owner_name,
        p.email                                           AS owner_email,
        COALESCE(o.org_type, 'solo')                      AS org_type,
        COUNT(DISTINCT l.id)                              AS lead_count,
        EXISTS(
            SELECT 1 FROM org_services s2
            WHERE s2.org_id = o.id AND s2.service_key = 'sentinel' AND s2.status = 'active'
        )                                                 AS has_sentinel,
        o.created_at
    FROM organizations o
    -- Primary owner/admin member
    INNER JOIN org_members m ON m.org_id = o.id
        AND (m.role IS NULL OR m.role IN ('enterprise_admin', 'agency_admin'))
    INNER JOIN profiles p ON p.id = m.user_id
    LEFT JOIN leads l ON l.org_id = o.id
    -- Exclude orgs that already have growth_engine active
    WHERE NOT EXISTS (
        SELECT 1 FROM org_services s
        WHERE s.org_id = o.id AND s.service_key = 'growth_engine' AND s.status = 'active'
    )
    -- Only include orgs with an active subscription (paying customers)
    AND EXISTS (
        SELECT 1 FROM org_services s
        WHERE s.org_id = o.id AND s.status = 'active'
    )
    GROUP BY o.id, o.name, p.full_name, p.email, o.org_type, o.created_at
    ORDER BY lead_count DESC, o.created_at DESC
    LIMIT 50;
END;
$$;
