"""
Decision Attribution Logger.

Records every autonomous decision the system makes to growth.decision_attributions.
Used for explainability ("Why did we engage here?"), debugging, and future optimization.

Three decision types:
  log_engagement_scored()   — after LLM scoring in scoring_worker
  log_engagement_executed() — after platform dispatch in executor
  log_content_generated()   — after variant save in content_pipeline

All functions are non-blocking:
  - caller's primary flow always continues regardless of attribution write status
  - exceptions are caught and structured-logged as 'decision_attribution_write_failed'
  - nothing is silently swallowed

feature_vector holds machine-readable context at decision time.
decision_reason holds a short human-readable explanation for UI display.
"""

from __future__ import annotations

import json
import uuid
from typing import Optional

import asyncpg

from app.logging_config import get_logger

log = get_logger(__name__)


async def log_engagement_scored(
    pool: asyncpg.Pool,
    opp_id: uuid.UUID,
    org_id: uuid.UUID,
    platform: str,
    opportunity_type: str,
    confidence_score: float,
    risk_score: float,
    relevance_score: float,
    new_status: str,
    model_version: Optional[str],
    score_attempt: int,
    plan: str,
    auto_conf_threshold: float = 0.75,
    auto_risk_threshold: float = 0.30,
    learning_enabled: bool = False,
) -> None:
    """
    Record an engagement opportunity scoring decision.

    Called after a successful LLM scoring in scoring_worker._score_one().
    Logs which scores were produced and whether auto-approval threshold was met.
    """
    if new_status == "auto_approved":
        policy = "auto_approved"
        decision_reason = (
            f"confidence {confidence_score:.2f} and risk {risk_score:.2f} "
            f"met auto-safe threshold (conf≥{auto_conf_threshold}, risk≤{auto_risk_threshold})"
        )
    else:
        policy = "pending_review"
        if confidence_score < auto_conf_threshold:
            decision_reason = (
                f"confidence {confidence_score:.2f} below threshold {auto_conf_threshold} "
                f"— sent to pending_review"
            )
        else:
            decision_reason = (
                f"risk {risk_score:.2f} above threshold {auto_risk_threshold} "
                f"— sent to pending_review"
            )

    feature_vector = {
        "confidence_score":        confidence_score,
        "risk_score":              risk_score,
        "relevance_score":         relevance_score,
        "platform":                platform,
        "opportunity_type":        opportunity_type,
        "score_attempt":           score_attempt,
        "plan":                    plan,
        "effective_conf_threshold": auto_conf_threshold,
        "effective_risk_threshold": auto_risk_threshold,
        "learning_enabled":         learning_enabled,
        "auto_threshold": {
            "confidence_min":  auto_conf_threshold,
            "risk_max":        auto_risk_threshold,
        },
    }

    await _write(
        pool=pool,
        org_id=org_id,
        decision_type="engagement_scored",
        subject_id=opp_id,
        subject_type="opportunity",
        policy=policy,
        outcome=new_status,
        feature_vector=feature_vector,
        decision_reason=decision_reason,
        model_version=model_version,
    )


async def log_engagement_executed(
    pool: asyncpg.Pool,
    opp_id: uuid.UUID,
    org_id: uuid.UUID,
    platform: str,
    approval_status: str,
    confidence_score: Optional[float],
    risk_score: Optional[float],
    cap_used: Optional[int],
    cap_limit: Optional[int],
    success: bool,
    http_status: Optional[int],
    error_category: Optional[str],
    platform_action_id: Optional[str],
) -> None:
    """
    Record an engagement execution decision.

    Called after _dispatch_action() returns in executor.execute_opportunity().
    Logs the approval path, cap usage, and platform outcome.
    """
    outcome = "success" if success else "failed"

    if success:
        decision_reason = (
            f"executed via {approval_status} on {platform} "
            f"(cap {cap_used}/{cap_limit})"
        )
    else:
        if error_category:
            decision_reason = (
                f"execution failed on {platform}: {error_category} "
                f"(http {http_status})"
            )
        else:
            decision_reason = f"execution failed on {platform} (http {http_status})"

    feature_vector = {
        "confidence_score":   confidence_score,
        "risk_score":         risk_score,
        "approval_status":    approval_status,
        "platform":           platform,
        "cap_used":           cap_used,
        "cap_limit":          cap_limit,
        "success":            success,
        "http_status":        http_status,
        "error_category":     error_category,
        "platform_action_id": platform_action_id,
    }

    await _write(
        pool=pool,
        org_id=org_id,
        decision_type="engagement_executed",
        subject_id=opp_id,
        subject_type="opportunity",
        policy=approval_status,
        outcome=outcome,
        feature_vector=feature_vector,
        decision_reason=decision_reason,
        model_version=None,
    )


async def log_content_generated(
    pool: asyncpg.Pool,
    variant_id: uuid.UUID,
    org_id: uuid.UUID,
    platform: str,
    angle_type: str,
    hook_score: float,
    critic_decision: str,
    generation_attempts: int,
    posting_mode: str,
    model_version: Optional[str] = None,
) -> None:
    """
    Record a content generation decision.

    Called after _save_variant() in content_pipeline.run_pipeline_for_variant().
    Logs which pipeline decisions led to the final save status.
    """
    if critic_decision == "approve":
        if posting_mode == "suggestion_only":
            policy  = "suggestion_only"
            outcome = "draft"
            decision_reason = (
                f"critic approved on attempt {generation_attempts} "
                f"but posting_mode=suggestion_only — saved as draft"
            )
        else:
            policy  = "auto_post"
            outcome = "approved"
            decision_reason = (
                f"critic approved on attempt {generation_attempts} "
                f"with posting_mode={posting_mode}"
            )
    else:
        policy  = "critic_revise"
        outcome = "draft"
        decision_reason = (
            f"critic did not approve after {generation_attempts} attempt(s) "
            f"— saved as draft for review"
        )

    feature_vector = {
        "platform":            platform,
        "angle_type":          angle_type,
        "hook_score":          hook_score,
        "critic_decision":     critic_decision,
        "generation_attempts": generation_attempts,
        "posting_mode":        posting_mode,
    }

    await _write(
        pool=pool,
        org_id=org_id,
        decision_type="content_generated",
        subject_id=variant_id,
        subject_type="variant",
        policy=policy,
        outcome=outcome,
        feature_vector=feature_vector,
        decision_reason=decision_reason,
        model_version=model_version,
    )


# ── Internal write helper ─────────────────────────────────────────────────────

async def _write(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    decision_type: str,
    subject_id: uuid.UUID,
    subject_type: str,
    policy: Optional[str],
    outcome: Optional[str],
    feature_vector: dict,
    decision_reason: Optional[str],
    model_version: Optional[str],
) -> None:
    """
    Insert one attribution row.

    Never raises — all exceptions are caught and logged as
    'decision_attribution_write_failed' with org_id, decision_type,
    subject_id, and error message so failures are visible in logs
    without impacting the primary flow.
    """
    try:
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO growth.decision_attributions (
                    org_id, decision_type, subject_id, subject_type,
                    feature_vector, policy, outcome, decision_reason, model_version
                ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
                """,
                org_id,
                decision_type,
                subject_id,
                subject_type,
                json.dumps(feature_vector),
                policy,
                outcome,
                decision_reason,
                model_version,
            )
    except Exception as exc:
        log.error(
            "decision_attribution_write_failed",
            org_id=str(org_id),
            decision_type=decision_type,
            subject_id=str(subject_id),
            error=str(exc),
        )
