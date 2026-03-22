"""
Revenue Attribution sweeper.

Matches engaged influencer nodes against CRM leads to detect conversions
attributable to the org's engagement activity.

Match strategies (v1):
  1. messenger_psid (score 0.9)
     influencer_nodes.author_platform_id = public.leads.messenger_psid
     Exact match — high confidence. Works for Facebook/Messenger contacts.

  2. author_name (score 0.6)
     LOWER(influencer_nodes.author_name) = LOWER(public.leads.name)
     Case-insensitive exact match — moderate confidence.
     May produce false positives for common names; acceptable in v1.

Only nodes where engaged_count > 0 are considered.
Nodes we observed but never engaged with are excluded — we attribute
only to relationships we actively built.

Each match is idempotent (ON CONFLICT DO NOTHING on the unique key),
so the sweep can run repeatedly without producing duplicates.

Called by:
  POST /internal/run-attribution-sweep
"""

from __future__ import annotations

import uuid

import asyncpg

from app.logging_config import get_logger

log = get_logger(__name__)


async def run_attribution_sweep(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
) -> int:
    """
    Run the full attribution sweep for one org.

    Executes both match strategies and returns the total number of
    new attribution rows inserted (existing matches are skipped).
    """
    psid_count = await _sweep_messenger_psid(pool, org_id)
    name_count = await _sweep_author_name(pool, org_id)
    total = psid_count + name_count

    log.info(
        "attribution_sweep_complete",
        org_id=str(org_id),
        psid_matches=psid_count,
        name_matches=name_count,
        total=total,
    )
    return total


# ── Match strategies ──────────────────────────────────────────────────────────

async def _sweep_messenger_psid(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
) -> int:
    """
    Match influencer_nodes → leads on messenger_psid (exact, confidence 0.9).

    Only applicable to Facebook/Messenger contacts where the author_platform_id
    is the same identifier as the lead's messenger_psid.
    """
    async with pool.acquire() as conn:
        result = await conn.execute(
            """
            INSERT INTO growth.revenue_attributions
                (org_id, lead_id, influencer_node_id, action_id,
                 platform, matched_on, match_value, attribution_score)
            SELECT
                $1,
                l.id,
                n.id,
                (
                    SELECT a.id
                    FROM growth.engagement_actions a
                    WHERE a.org_id = $1
                      AND a.opportunity_id IN (
                            SELECT id FROM growth.engagement_opportunities
                            WHERE org_id = $1
                              AND influencer_node_id = n.id
                              AND status = 'executed'
                      )
                    ORDER BY a.executed_at DESC
                    LIMIT 1
                ),
                n.platform,
                'messenger_psid',
                n.author_platform_id,
                0.9
            FROM growth.influencer_nodes n
            JOIN public.leads l
                ON l.org_id = $1
               AND l.messenger_psid IS NOT NULL
               AND l.messenger_psid = n.author_platform_id
            WHERE n.org_id = $1
              AND n.engaged_count > 0
            ON CONFLICT (org_id, lead_id, influencer_node_id) DO NOTHING
            """,
            org_id,
        )

    count = _parse_rowcount(result)
    if count:
        log.info("attribution_psid_matches", org_id=str(org_id), count=count)
    return count


async def _sweep_author_name(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
) -> int:
    """
    Match influencer_nodes → leads on author name (case-insensitive, confidence 0.6).

    Excludes nodes already attributed via messenger_psid to avoid double-counting.
    """
    async with pool.acquire() as conn:
        result = await conn.execute(
            """
            INSERT INTO growth.revenue_attributions
                (org_id, lead_id, influencer_node_id, action_id,
                 platform, matched_on, match_value, attribution_score)
            SELECT
                $1,
                l.id,
                n.id,
                (
                    SELECT a.id
                    FROM growth.engagement_actions a
                    WHERE a.org_id = $1
                      AND a.opportunity_id IN (
                            SELECT id FROM growth.engagement_opportunities
                            WHERE org_id = $1
                              AND influencer_node_id = n.id
                              AND status = 'executed'
                      )
                    ORDER BY a.executed_at DESC
                    LIMIT 1
                ),
                n.platform,
                'author_name',
                n.author_name,
                0.6
            FROM growth.influencer_nodes n
            JOIN public.leads l
                ON l.org_id = $1
               AND l.name IS NOT NULL
               AND LOWER(l.name) = LOWER(n.author_name)
            WHERE n.org_id = $1
              AND n.engaged_count > 0
              AND n.author_name IS NOT NULL
              -- Skip nodes already matched via higher-confidence psid strategy
              AND NOT EXISTS (
                  SELECT 1 FROM growth.revenue_attributions ra
                  WHERE ra.org_id = $1
                    AND ra.influencer_node_id = n.id
                    AND ra.matched_on = 'messenger_psid'
              )
            ON CONFLICT (org_id, lead_id, influencer_node_id) DO NOTHING
            """,
            org_id,
        )

    count = _parse_rowcount(result)
    if count:
        log.info("attribution_name_matches", org_id=str(org_id), count=count)
    return count


def _parse_rowcount(pg_status: str) -> int:
    """Parse asyncpg 'INSERT N' status string → int."""
    try:
        return int(pg_status.split()[-1])
    except (ValueError, IndexError):
        return 0
