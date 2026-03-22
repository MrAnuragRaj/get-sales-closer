"""
Growth Radar API.

Routes:
  GET /growth/radar   — return latest snapshot for the org

Returns 200 with null signal fields if no snapshot has been computed yet.
Run POST /internal/run-radar to generate or refresh the snapshot.
"""

from __future__ import annotations

import asyncpg
from fastapi import APIRouter, Depends

from app.auth_bridge import AuthContext, require_auth
from app.db import get_pool
from app.services.growth_radar import get_snapshot

router = APIRouter(prefix="/radar", tags=["radar"])


@router.get("")
async def get_radar(
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    """
    Return the latest Growth Radar snapshot for this org.

    200 with full snapshot if one has been computed.
    200 with null signal fields if no snapshot exists yet — tells the dashboard
    to display "Run your first radar to see growth intelligence."
    """
    snapshot = await get_snapshot(pool, auth.org_id)

    if snapshot:
        return {"computed": True, **snapshot}

    return {
        "computed":           False,
        "period_days":        30,
        "top_authors":        None,
        "top_angles":         None,
        "engagement_health":  None,
        "attribution_summary": None,
        "computed_at":        None,
    }
