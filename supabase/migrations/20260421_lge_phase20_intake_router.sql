-- Phase 20: Intake Router + Multi-tenant Fair-Share Worker + Circuit Breakers
-- 1. lge_intake_policies — per-org failover policy for intake_router
-- 2. lge_intake_events   — audit log for every intake_router decision
-- 3. lge_provider_health — circuit breaker state per org+provider
-- 4. lge_record_provider_failure / lge_record_provider_success RPCs
-- 5. Updated lge_claim_batch — fair-share (max 3/org/cycle) + fill remaining

-- ── 1. Intake Policies ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS lge_intake_policies (
  org_id          UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  failover_policy TEXT NOT NULL DEFAULT 'fail_open'
                  CHECK (failover_policy IN ('fail_open', 'fail_closed', 'shadow_only')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE lge_intake_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all" ON lge_intake_policies
  FOR ALL USING (auth.role() = 'service_role');

-- ── 2. Intake Events ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS lge_intake_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key  TEXT UNIQUE,
  org_id           UUID NOT NULL,
  intake_source    TEXT,
  campaign_id      UUID,
  router_decision  TEXT NOT NULL,
  -- 'lge_queued' | 'direct_push' | 'held' | 'shadow' | 'fallback_open' | 'fallback_closed' | 'error'
  fallback_reason  TEXT,
  lge_lead_id      UUID,
  gsc_lead_id      UUID,
  raw_payload      JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE lge_intake_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all" ON lge_intake_events
  FOR ALL USING (auth.role() = 'service_role');
CREATE INDEX IF NOT EXISTS lge_intake_events_org_created
  ON lge_intake_events(org_id, created_at DESC);

-- ── 3. Provider Health (circuit breakers) ────────────────────────────────────

CREATE TABLE IF NOT EXISTS lge_provider_health (
  org_id               UUID    NOT NULL,
  provider             TEXT    NOT NULL,
  consecutive_failures INT     NOT NULL DEFAULT 0,
  breaker_state        TEXT    NOT NULL DEFAULT 'closed'
                       CHECK (breaker_state IN ('closed', 'open', 'half_open')),
  opened_at            TIMESTAMPTZ,
  cooldown_until       TIMESTAMPTZ,
  open_count_24h       INT     NOT NULL DEFAULT 0,
  open_count_reset_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (org_id, provider)
);
ALTER TABLE lge_provider_health ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all" ON lge_provider_health
  FOR ALL USING (auth.role() = 'service_role');

-- ── 4a. RPC: record a provider failure, open breaker after 3 consecutive ─────

CREATE OR REPLACE FUNCTION lge_record_provider_failure(
  p_org_id   UUID,
  p_provider TEXT
) RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_row             lge_provider_health%ROWTYPE;
  v_cooldown_minutes INT;
  v_open_count      INT;
BEGIN
  -- Upsert: increment consecutive failures
  INSERT INTO lge_provider_health(org_id, provider, consecutive_failures, breaker_state, updated_at)
  VALUES (p_org_id, p_provider, 1, 'closed', NOW())
  ON CONFLICT (org_id, provider) DO UPDATE
    SET consecutive_failures = lge_provider_health.consecutive_failures + 1,
        updated_at = NOW()
  RETURNING * INTO v_row;

  -- Reset 24h open counter if window expired
  IF v_row.open_count_reset_at < NOW() - INTERVAL '24 hours' THEN
    UPDATE lge_provider_health
    SET open_count_24h = 0, open_count_reset_at = NOW()
    WHERE org_id = p_org_id AND provider = p_provider;
    v_open_count := 0;
  ELSE
    v_open_count := v_row.open_count_24h;
  END IF;

  -- Open breaker after 3 consecutive failures (if currently closed)
  IF v_row.consecutive_failures >= 3 AND v_row.breaker_state IN ('closed', 'half_open') THEN
    -- Repeated opens within 24h get longer cooldown
    v_cooldown_minutes := CASE WHEN v_open_count > 0 THEN 60 ELSE 15 END;
    UPDATE lge_provider_health
    SET breaker_state        = 'open',
        opened_at            = NOW(),
        cooldown_until       = NOW() + (v_cooldown_minutes || ' minutes')::INTERVAL,
        consecutive_failures = 0,
        open_count_24h       = COALESCE(open_count_24h, 0) + 1,
        updated_at           = NOW()
    WHERE org_id = p_org_id AND provider = p_provider;
    RETURN 'breaker_opened';
  END IF;

  RETURN 'failure_recorded';
END;
$$;

-- ── 4b. RPC: record a provider success, close breaker ────────────────────────

CREATE OR REPLACE FUNCTION lge_record_provider_success(
  p_org_id   UUID,
  p_provider TEXT
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE lge_provider_health
  SET consecutive_failures = 0,
      breaker_state        = 'closed',
      cooldown_until       = NULL,
      updated_at           = NOW()
  WHERE org_id = p_org_id AND provider = p_provider;
END;
$$;

-- ── 4c. RPC: check breaker state (auto-transitions open→half_open on cooldown) ─

CREATE OR REPLACE FUNCTION lge_check_circuit_breaker(
  p_org_id   UUID,
  p_provider TEXT
) RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_row lge_provider_health%ROWTYPE;
BEGIN
  SELECT * INTO v_row
  FROM lge_provider_health
  WHERE org_id = p_org_id AND provider = p_provider;

  IF NOT FOUND THEN RETURN 'closed'; END IF;

  -- Auto-transition open → half_open when cooldown expires
  IF v_row.breaker_state = 'open'
     AND v_row.cooldown_until IS NOT NULL
     AND v_row.cooldown_until < NOW() THEN
    UPDATE lge_provider_health
    SET breaker_state = 'half_open', updated_at = NOW()
    WHERE org_id = p_org_id AND provider = p_provider;
    RETURN 'half_open';
  END IF;

  RETURN v_row.breaker_state;
END;
$$;

-- ── 5. Updated lge_claim_batch: per-org cap (3) + fill remaining ──────────────
-- Priority order: fresh intake > review-triggered reenrich > replay/simulation
-- Within each org: oldest created_at first (FIFO)
-- After per-org pass: fill remaining slots by oldest eligible lead globally

CREATE OR REPLACE FUNCTION public.lge_claim_batch(
  p_worker_id    TEXT,
  p_batch_size   INT DEFAULT 10,
  p_lock_minutes INT DEFAULT 5,
  p_per_org_cap  INT DEFAULT 3
)
RETURNS TABLE (
  lead_id       UUID,
  campaign_id   UUID,
  org_id        UUID,
  lead_name     TEXT,
  lead_email    TEXT,
  lead_phone    TEXT,
  lead_company  TEXT,
  lead_source   TEXT,
  raw_data      JSONB,
  attempt       INT,
  max_attempts  INT,
  campaign_mode TEXT,
  icp_config    JSONB
) LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_ids     UUID[] := ARRAY[]::UUID[];
  v_org     UUID;
  v_fill    UUID[];
  v_cap     INT;
  v_rem     INT;
BEGIN
  -- ── Phase 1: fair-share — up to p_per_org_cap leads per org ─────────────────
  FOR v_org IN (
    SELECT DISTINCT rl.org_id
    FROM lge_raw_leads rl
    JOIN lge_campaigns c ON c.id = rl.campaign_id
    WHERE rl.status = 'pending'
      AND rl.attempt < rl.max_attempts
      AND (rl.locked_until IS NULL OR rl.locked_until < NOW())
      AND c.mode  IN ('shadow', 'active')
      AND c.status NOT IN ('archived', 'paused')
  ) LOOP
    EXIT WHEN COALESCE(array_length(v_ids, 1), 0) >= p_batch_size;

    v_rem := p_batch_size - COALESCE(array_length(v_ids, 1), 0);
    v_cap := LEAST(p_per_org_cap, v_rem);

    SELECT v_ids || ARRAY(
      SELECT rl.id
      FROM lge_raw_leads rl
      JOIN lge_campaigns c ON c.id = rl.campaign_id
      WHERE rl.org_id  = v_org
        AND rl.status  = 'pending'
        AND rl.attempt < rl.max_attempts
        AND (rl.locked_until IS NULL OR rl.locked_until < NOW())
        AND c.mode   IN ('shadow', 'active')
        AND c.status NOT IN ('archived', 'paused')
      ORDER BY rl.created_at ASC
      LIMIT v_cap
      FOR UPDATE OF rl SKIP LOCKED
    ) INTO v_ids;
  END LOOP;

  -- ── Phase 2: fill remaining slots — oldest eligible leads across all orgs ────
  v_rem := p_batch_size - COALESCE(array_length(v_ids, 1), 0);
  IF v_rem > 0 THEN
    SELECT ARRAY(
      SELECT rl.id
      FROM lge_raw_leads rl
      JOIN lge_campaigns c ON c.id = rl.campaign_id
      WHERE rl.status  = 'pending'
        AND rl.attempt < rl.max_attempts
        AND (rl.locked_until IS NULL OR rl.locked_until < NOW())
        AND c.mode   IN ('shadow', 'active')
        AND c.status NOT IN ('archived', 'paused')
        AND NOT (rl.id = ANY(v_ids))
      ORDER BY rl.created_at ASC
      LIMIT v_rem
      FOR UPDATE OF rl SKIP LOCKED
    ) INTO v_fill;

    v_ids := v_ids || COALESCE(v_fill, ARRAY[]::UUID[]);
  END IF;

  -- Nothing to process
  IF COALESCE(array_length(v_ids, 1), 0) = 0 THEN RETURN; END IF;

  -- ── Lease all selected leads ──────────────────────────────────────────────────
  UPDATE lge_raw_leads
  SET locked_by    = p_worker_id,
      locked_until = NOW() + (p_lock_minutes || ' minutes')::INTERVAL,
      status       = 'enriching',
      attempt      = attempt + 1
  WHERE id = ANY(v_ids);

  -- ── Return with campaign data ─────────────────────────────────────────────────
  RETURN QUERY
    SELECT
      rl.id          AS lead_id,
      rl.campaign_id,
      rl.org_id,
      rl.name        AS lead_name,
      rl.email       AS lead_email,
      rl.phone       AS lead_phone,
      rl.company     AS lead_company,
      COALESCE(rl.source, 'unknown') AS lead_source,
      rl.raw_data,
      rl.attempt,
      rl.max_attempts,
      c.mode         AS campaign_mode,
      c.icp_config
    FROM lge_raw_leads rl
    JOIN lge_campaigns c ON c.id = rl.campaign_id
    WHERE rl.id = ANY(v_ids);
END;
$$;
