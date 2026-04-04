"""
Ideas API — content idea management and pipeline triggers.

Routes:
  GET    /growth/ideas              — list ideas for the org
  POST   /growth/ideas/generate     — generate N new ideas (planner)
  GET    /growth/ideas/{id}         — fetch a single idea
  POST   /growth/ideas/{id}/generate — run pipeline (all platforms) for an idea
  DELETE /growth/ideas/{id}          — reject/archive idea

Authority Ladder routes:
  GET    /growth/ladders             — list ladders
  POST   /growth/ladders             — create ladder
  GET    /growth/ladders/{id}        — fetch ladder
  POST   /growth/ladders/{id}/next   — generate next level idea
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, status

from app.auth_bridge import AuthContext, require_auth
from app.db import get_pool
from app.models.draft import PipelineResultOut
from app.models.idea import (
    AuthorityLadderCreate,
    AuthorityLadderOut,
    ContentIdeaListResponse,
    ContentIdeaOut,
    GenerateIdeasRequest,
    GenerateLadderLevelRequest,
    GenerateVariantsRequest,
    ManualIdeaCreate,
)
from app.services import authority_ladder as ladder_svc
from app.services import brand_brain
from app.services import planner as planner_svc
from app.services.content_pipeline import run_pipeline_for_idea

import asyncpg

router = APIRouter(prefix="/ideas", tags=["ideas"])
ladder_router = APIRouter(prefix="/ladders", tags=["ladders"])


# ── Idea routes ────────────────────────────────────────────────────────────────

@router.post("", response_model=ContentIdeaOut, status_code=status.HTTP_201_CREATED)
async def create_idea(
    body: ManualIdeaCreate,
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    """
    Manually create a content idea (source='manual').
    The idea is saved with status='generated' so the writer job picks it up
    at the next scheduled run (or can be triggered immediately via /{id}/generate).
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO growth.content_ideas
                (org_id, source, pillar, topic, angle, hook_seed, score, status, planned_for)
            VALUES ($1, 'manual', $2, $3, $4, $5, 5.0, 'generated', $6)
            RETURNING id, org_id, source, pillar, topic, angle, hook_seed, score,
                      status, planned_for, authority_ladder_id, ladder_level,
                      hook_candidates_json, created_at
            """,
            auth.org_id,
            body.pillar,
            body.topic,
            body.angle or "",
            body.hook_seed or "",
            body.planned_for,
        )
    return ContentIdeaOut.model_validate(dict(row))


@router.get("", response_model=ContentIdeaListResponse)
async def list_ideas(
    status: str | None = None,
    limit: int = 50,
    offset: int = 0,
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    where = "WHERE org_id = $1"
    params: list = [auth.org_id]

    if status:
        where += f" AND status = ${len(params)+1}"
        params.append(status)

    async with pool.acquire() as conn:
        rows = await conn.fetch(
            f"""
            SELECT id, org_id, source, pillar, topic, angle, hook_seed, score,
                   status, planned_for, authority_ladder_id, ladder_level,
                   hook_candidates_json, created_at
            FROM growth.content_ideas
            {where}
            ORDER BY created_at DESC
            LIMIT ${len(params)+1} OFFSET ${len(params)+2}
            """,
            *params,
            limit,
            offset,
        )
        total_row = await conn.fetchrow(
            f"SELECT COUNT(*) FROM growth.content_ideas {where}",
            *params,
        )

    ideas = [ContentIdeaOut.model_validate(dict(r)) for r in rows]
    return ContentIdeaListResponse(ideas=ideas, total=total_row["count"])


@router.post("/generate", response_model=ContentIdeaListResponse, status_code=status.HTTP_201_CREATED)
async def generate_ideas(
    body: GenerateIdeasRequest,
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    brand = await brand_brain.get_brand_profile(pool, auth.org_id)
    if not brand:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Brand profile required before generating ideas. POST /growth/brand first.",
        )

    idea_ids = await planner_svc.run_regular_planner(
        pool=pool,
        org_id=auth.org_id,
        brand=brand,
        n=body.n,
        planned_for=body.planned_for,
    )

    if not idea_ids:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Planner returned no ideas — AI generation failed.",
        )

    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, org_id, source, pillar, topic, angle, hook_seed, score,
                   status, planned_for, authority_ladder_id, ladder_level,
                   hook_candidates_json, created_at
            FROM growth.content_ideas
            WHERE id = ANY($1::uuid[])
            ORDER BY created_at DESC
            """,
            idea_ids,
        )

    ideas = [ContentIdeaOut.model_validate(dict(r)) for r in rows]
    return ContentIdeaListResponse(ideas=ideas, total=len(ideas))


@router.get("/{idea_id}", response_model=ContentIdeaOut)
async def get_idea(
    idea_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT id, org_id, source, pillar, topic, angle, hook_seed, score,
                   status, planned_for, authority_ladder_id, ladder_level,
                   hook_candidates_json, created_at
            FROM growth.content_ideas
            WHERE id = $1 AND org_id = $2
            """,
            idea_id,
            auth.org_id,
        )
    if not row:
        raise HTTPException(status_code=404, detail="Idea not found")
    return ContentIdeaOut.model_validate(dict(row))


@router.post("/{idea_id}/generate", response_model=list[PipelineResultOut], status_code=status.HTTP_201_CREATED)
async def generate_variants(
    idea_id: uuid.UUID,
    body: GenerateVariantsRequest,
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    """
    Run the full mandatory pipeline (angle → hook → write → critic → rewrite → save)
    for all enabled platforms for this idea.
    """
    brand = await brand_brain.get_brand_profile(pool, auth.org_id)
    if not brand:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Brand profile required. POST /growth/brand first.",
        )

    results = await run_pipeline_for_idea(
        pool=pool,
        org_id=auth.org_id,
        brand=brand,
        idea_id=idea_id,
        prompt_version=body.prompt_version,
    )

    if not results:
        raise HTTPException(status_code=404, detail="Idea not found or pipeline produced no results")

    return [
        PipelineResultOut(
            idea_id=r.idea_id,
            platform=r.platform,
            variant_id=r.variant_id,
            status=r.status,
            critic_decision=r.critic_decision,
            generation_attempts=r.generation_attempts,
            angle_type=r.angle_type,
            angle_title=r.angle_title,
            hook_text=r.hook_text,
            hook_score=r.hook_score,
            error=r.error,
            succeeded=r.succeeded,
        )
        for r in results
    ]


@router.delete("/{idea_id}", status_code=status.HTTP_204_NO_CONTENT)
async def reject_idea(
    idea_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    async with pool.acquire() as conn:
        result = await conn.execute(
            """
            UPDATE growth.content_ideas
            SET status = 'rejected'
            WHERE id = $1 AND org_id = $2 AND status NOT IN ('published')
            """,
            idea_id,
            auth.org_id,
        )
    if result == "UPDATE 0":
        raise HTTPException(status_code=404, detail="Idea not found or cannot be rejected")


# ── Authority Ladder routes ────────────────────────────────────────────────────

@ladder_router.get("", response_model=list[AuthorityLadderOut])
async def list_ladders(
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    rows = await ladder_svc.list_ladders(pool, auth.org_id)
    return [AuthorityLadderOut.model_validate(r) for r in rows]


@ladder_router.post("", response_model=AuthorityLadderOut, status_code=status.HTTP_201_CREATED)
async def create_ladder(
    body: AuthorityLadderCreate,
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    ladder_id = await ladder_svc.create_ladder(pool, auth.org_id, body.theme)
    row = await ladder_svc.get_ladder(pool, auth.org_id, ladder_id)
    if not row:
        raise HTTPException(status_code=500, detail="Ladder creation failed")
    return AuthorityLadderOut.model_validate(row)


@ladder_router.get("/{ladder_id}", response_model=AuthorityLadderOut)
async def get_ladder(
    ladder_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    row = await ladder_svc.get_ladder(pool, auth.org_id, ladder_id)
    if not row:
        raise HTTPException(status_code=404, detail="Ladder not found")
    return AuthorityLadderOut.model_validate(row)


@ladder_router.post("/{ladder_id}/next", response_model=ContentIdeaOut, status_code=status.HTTP_201_CREATED)
async def generate_next_ladder_level(
    ladder_id: uuid.UUID,
    body: GenerateLadderLevelRequest,
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    """Generate a content idea for the next pending level of this ladder."""
    brand = await brand_brain.get_brand_profile(pool, auth.org_id)
    if not brand:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Brand profile required. POST /growth/brand first.",
        )

    idea_id = await ladder_svc.generate_next_level(
        pool=pool,
        org_id=auth.org_id,
        brand=brand,
        ladder_id=ladder_id,
        planned_for=body.planned_for,
    )

    if not idea_id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Ladder is completed or has no pending levels.",
        )

    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT id, org_id, source, pillar, topic, angle, hook_seed, score,
                   status, planned_for, authority_ladder_id, ladder_level,
                   hook_candidates_json, created_at
            FROM growth.content_ideas
            WHERE id = $1
            """,
            idea_id,
        )

    return ContentIdeaOut.model_validate(dict(row))
