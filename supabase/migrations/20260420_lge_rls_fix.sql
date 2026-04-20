-- Fix: LGE table RLS policies used nested EXISTS on org_members, which
-- has its own RLS. The nested RLS caused auth.uid() to fail silently in
-- SECURITY INVOKER context, returning empty results for authenticated users.
-- Solution: SECURITY DEFINER helper function that bypasses org_members RLS.

CREATE OR REPLACE FUNCTION lge_is_org_member(p_org_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM org_members
    WHERE org_id = p_org_id AND user_id = auth.uid()
  );
$$;

-- lge_raw_leads
DROP POLICY IF EXISTS "org members can view their raw leads" ON lge_raw_leads;
CREATE POLICY "org members can view their raw leads" ON lge_raw_leads
  FOR SELECT USING (lge_is_org_member(org_id));

-- lge_scores
DROP POLICY IF EXISTS "org members can view scores via lead" ON lge_scores;
CREATE POLICY "org members can view scores via lead" ON lge_scores
  FOR SELECT USING (lge_is_org_member((SELECT org_id FROM lge_raw_leads WHERE id = raw_lead_id)));

-- lge_context
DROP POLICY IF EXISTS "org members can view context via lead" ON lge_context;
CREATE POLICY "org members can view context via lead" ON lge_context
  FOR SELECT USING (lge_is_org_member((SELECT org_id FROM lge_raw_leads WHERE id = raw_lead_id)));

-- lge_outcomes
DROP POLICY IF EXISTS "org members can view outcomes via lead" ON lge_outcomes;
CREATE POLICY "org members can view outcomes via lead" ON lge_outcomes
  FOR SELECT USING (lge_is_org_member((SELECT org_id FROM lge_raw_leads WHERE id = raw_lead_id)));
