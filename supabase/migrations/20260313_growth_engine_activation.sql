-- Migration: growth_engine activation helpers
-- Purpose:
--   admin_grant_growth_engine(p_org_id)  — grant growth_engine service to an org
--   admin_revoke_growth_engine(p_org_id) — revoke it
--
-- Both are SECURITY DEFINER (run as owner, bypass RLS).
-- Both verify the caller is a platform admin (profiles.is_admin = true).
--
-- Called from admin.html via supabase.rpc().
-- Manual beta grant via SQL panel: SELECT admin_grant_growth_engine('<org_uuid>');

-- ── Grant ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_grant_growth_engine(p_org_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = true
    ) THEN
        RAISE EXCEPTION 'admin_grant_growth_engine: caller is not a platform admin';
    END IF;

    INSERT INTO org_services (org_id, service_key, status)
    VALUES (p_org_id, 'growth_engine', 'active')
    ON CONFLICT (org_id, service_key) DO UPDATE
        SET status = 'active';
END;
$$;

-- ── Revoke ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_revoke_growth_engine(p_org_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = true
    ) THEN
        RAISE EXCEPTION 'admin_revoke_growth_engine: caller is not a platform admin';
    END IF;

    UPDATE org_services
    SET status = 'inactive'
    WHERE org_id = p_org_id AND service_key = 'growth_engine';
END;
$$;

-- Note: get_active_entitlements() reads all org_services WHERE status='active',
-- so growth_engine appears automatically once inserted.
