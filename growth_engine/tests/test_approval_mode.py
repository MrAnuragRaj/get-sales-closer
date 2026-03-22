"""
Tests for the approval engine — all three posting modes and edge cases.

Covers:
  - auto mode:            pipeline auto-enqueues critic-passed variants
  - approval mode:        pipeline saves, enqueue only on human approval
  - suggestion_only mode: pipeline always draft; approve-only, no auto-enqueue
  - handle_human_approval behavior per mode
  - handle_edit: approval invalidation, queue cancellation
  - handle_rejection: cancels queue, logs event
  - handle_explicit_queue: works in all modes for approved variants
  - _cancel_pending_queue_entries: only cancels 'pending' (not locked/published)
  - mode_change: changing mode does not affect already-queued items

Run via: pytest tests/test_approval_mode.py
Requires: pytest-asyncio (in requirements.txt)
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, call, patch

import pytest


# ── Helpers ─────────────────────────────────────────────────────────────────────

def _make_pool(mode: str = "auto") -> tuple:
    """
    Build a mock pool. First fetchrow call returns mode settings row,
    subsequent calls return variant rows.
    """
    conn = AsyncMock()
    conn.execute = AsyncMock(return_value="UPDATE 1")

    pool = MagicMock()
    pool.acquire = MagicMock()
    pool.acquire.return_value.__aenter__ = AsyncMock(return_value=conn)
    pool.acquire.return_value.__aexit__ = AsyncMock(return_value=False)
    return pool, conn


def _mode_row(mode: str) -> dict:
    return {"posting_mode": mode}


def _variant_row(
    variant_id=None,
    platform="linkedin",
    status="approved",
    critic_decision="approve",
) -> dict:
    return {
        "id": variant_id or uuid.uuid4(),
        "org_id": uuid.uuid4(),
        "idea_id": uuid.uuid4(),
        "platform": platform,
        "status": status,
        "body_text": "body",
        "original_body_text": "original",
        "angle_type": "contrarian",
        "angle_title": "title",
        "core_claim": "claim",
        "hook_text": "hook",
        "hook_rank": 1,
        "prompt_version": "v1",
        "generation_attempt": 1,
        "critic_decision": critic_decision,
        "critic_scores_json": None,
        "revision_brief": None,
        "is_user_edited": False,
        "finalized_at": None,
        "created_at": datetime.now(timezone.utc),
        "approved_by": None,
        "approved_at": None,
        "queued_at": None,
        "scheduled_publish_at": None,
    }


# ── get_posting_mode ─────────────────────────────────────────────────────────────

class TestGetPostingMode:
    @pytest.mark.asyncio
    async def test_returns_mode_from_db(self):
        from app.services.approval_engine import get_posting_mode
        pool, conn = _make_pool()
        conn.fetchrow.return_value = {"posting_mode": "approval"}

        mode = await get_posting_mode(pool, uuid.uuid4())
        assert mode == "approval"

    @pytest.mark.asyncio
    async def test_defaults_to_suggestion_only_if_not_found(self):
        from app.services.approval_engine import get_posting_mode
        pool, conn = _make_pool()
        conn.fetchrow.return_value = None

        mode = await get_posting_mode(pool, uuid.uuid4())
        assert mode == "suggestion_only"

    @pytest.mark.asyncio
    async def test_all_valid_modes_accepted(self):
        from app.services.approval_engine import get_posting_mode
        for mode_val in ("auto", "approval", "suggestion_only"):
            pool, conn = _make_pool()
            conn.fetchrow.return_value = {"posting_mode": mode_val}
            assert await get_posting_mode(pool, uuid.uuid4()) == mode_val


# ── handle_pipeline_completion ───────────────────────────────────────────────────

class TestHandlePipelineCompletion:
    @pytest.mark.asyncio
    async def test_auto_critic_passed_enqueues(self):
        """auto mode + critic passed → auto-enqueue."""
        from app.services.approval_engine import handle_pipeline_completion

        pool, conn = _make_pool()
        variant_id = uuid.uuid4()
        org_id = uuid.uuid4()

        conn.fetchrow.side_effect = [
            {"id": variant_id, "platform": "linkedin", "status": "approved"},  # _fetch_variant
            {"id": uuid.uuid4()},  # INSERT queue row
        ]
        conn.execute.return_value = "UPDATE 1"

        with patch("app.services.approval_engine._log_event", AsyncMock()):
            await handle_pipeline_completion(
                pool=pool,
                org_id=org_id,
                variant_id=variant_id,
                critic_passed=True,
                platform="linkedin",
                posting_mode="auto",
            )

        # Verify queue INSERT was called
        assert any("publish_queue" in str(c) for c in conn.execute.call_args_list
                   if conn.execute.call_args_list)

    @pytest.mark.asyncio
    async def test_auto_critic_failed_does_not_enqueue(self):
        """auto mode + critic failed → no enqueue (leaves as draft)."""
        from app.services.approval_engine import handle_pipeline_completion

        pool, conn = _make_pool()
        conn.execute = AsyncMock(return_value="UPDATE 0")

        with patch("app.services.approval_engine._enqueue_variant", AsyncMock()) as mock_enqueue, \
             patch("app.services.approval_engine._log_event", AsyncMock()):
            await handle_pipeline_completion(
                pool=pool,
                org_id=uuid.uuid4(),
                variant_id=uuid.uuid4(),
                critic_passed=False,
                platform="linkedin",
                posting_mode="auto",
            )
            mock_enqueue.assert_not_called()

    @pytest.mark.asyncio
    async def test_approval_mode_never_auto_enqueues(self):
        """approval mode → never auto-enqueues, even if critic passed."""
        from app.services.approval_engine import handle_pipeline_completion

        pool, conn = _make_pool()

        with patch("app.services.approval_engine._enqueue_variant", AsyncMock()) as mock_enqueue, \
             patch("app.services.approval_engine._log_event", AsyncMock()):
            await handle_pipeline_completion(
                pool=pool,
                org_id=uuid.uuid4(),
                variant_id=uuid.uuid4(),
                critic_passed=True,
                platform="linkedin",
                posting_mode="approval",
            )
            mock_enqueue.assert_not_called()

    @pytest.mark.asyncio
    async def test_suggestion_only_forces_draft(self):
        """suggestion_only mode → variant always set to draft."""
        from app.services.approval_engine import handle_pipeline_completion

        pool, conn = _make_pool()
        conn.execute = AsyncMock(return_value="UPDATE 1")

        with patch("app.services.approval_engine._enqueue_variant", AsyncMock()) as mock_enqueue, \
             patch("app.services.approval_engine._log_event", AsyncMock()):
            await handle_pipeline_completion(
                pool=pool,
                org_id=uuid.uuid4(),
                variant_id=uuid.uuid4(),
                critic_passed=True,   # even if critic approved
                platform="linkedin",
                posting_mode="suggestion_only",
            )
            mock_enqueue.assert_not_called()
            # _force_to_draft was called → execute called with UPDATE
            conn.execute.assert_called()


# ── handle_human_approval ────────────────────────────────────────────────────────

class TestHandleHumanApproval:
    @pytest.mark.asyncio
    async def test_auto_mode_approve_enqueues(self):
        """auto mode: human approval → approve + enqueue."""
        from app.services.approval_engine import handle_human_approval

        pool, conn = _make_pool()
        variant_id = uuid.uuid4()
        org_id = uuid.uuid4()
        approved_row = _variant_row(variant_id=variant_id, status="approved")
        conn.fetchrow.return_value = approved_row

        enqueue_mock = AsyncMock(return_value=uuid.uuid4())
        mark_queued_mock = AsyncMock()
        log_event_mock = AsyncMock()

        with patch("app.services.approval_engine.get_posting_mode", AsyncMock(return_value="auto")), \
             patch("app.services.approval_engine._enqueue_variant", enqueue_mock), \
             patch("app.services.approval_engine._mark_variant_queued", mark_queued_mock), \
             patch("app.services.approval_engine._log_event", log_event_mock):
            result = await handle_human_approval(
                pool=pool,
                org_id=org_id,
                variant_id=variant_id,
                actor_user_id=uuid.uuid4(),
            )

        enqueue_mock.assert_called_once()
        mark_queued_mock.assert_called_once()
        assert result["status"] == "queued"

    @pytest.mark.asyncio
    async def test_approval_mode_approve_enqueues(self):
        """approval mode: human approval → approve + enqueue."""
        from app.services.approval_engine import handle_human_approval

        pool, conn = _make_pool()
        variant_id = uuid.uuid4()
        approved_row = _variant_row(variant_id=variant_id, status="approved")
        conn.fetchrow.return_value = approved_row

        enqueue_mock = AsyncMock(return_value=uuid.uuid4())

        with patch("app.services.approval_engine.get_posting_mode", AsyncMock(return_value="approval")), \
             patch("app.services.approval_engine._enqueue_variant", enqueue_mock), \
             patch("app.services.approval_engine._mark_variant_queued", AsyncMock()), \
             patch("app.services.approval_engine._log_event", AsyncMock()):
            result = await handle_human_approval(
                pool=pool,
                org_id=uuid.uuid4(),
                variant_id=variant_id,
                actor_user_id=uuid.uuid4(),
            )

        enqueue_mock.assert_called_once()
        assert result["status"] == "queued"

    @pytest.mark.asyncio
    async def test_suggestion_only_approve_does_not_enqueue(self):
        """suggestion_only mode: human approval → approved ONLY, no enqueue."""
        from app.services.approval_engine import handle_human_approval

        pool, conn = _make_pool()
        variant_id = uuid.uuid4()
        approved_row = _variant_row(variant_id=variant_id, status="approved")
        conn.fetchrow.return_value = approved_row

        enqueue_mock = AsyncMock()

        with patch("app.services.approval_engine.get_posting_mode",
                   AsyncMock(return_value="suggestion_only")), \
             patch("app.services.approval_engine._enqueue_variant", enqueue_mock), \
             patch("app.services.approval_engine._log_event", AsyncMock()):
            result = await handle_human_approval(
                pool=pool,
                org_id=uuid.uuid4(),
                variant_id=variant_id,
                actor_user_id=uuid.uuid4(),
            )

        enqueue_mock.assert_not_called()
        # Status stays at the DB value (approved), not 'queued'
        assert result.get("status") != "queued"

    @pytest.mark.asyncio
    async def test_approve_not_found_returns_empty(self):
        """Approving a non-existent variant returns empty dict."""
        from app.services.approval_engine import handle_human_approval

        pool, conn = _make_pool()
        conn.fetchrow.return_value = None   # not found / published

        with patch("app.services.approval_engine.get_posting_mode", AsyncMock(return_value="auto")), \
             patch("app.services.approval_engine._enqueue_variant", AsyncMock()), \
             patch("app.services.approval_engine._log_event", AsyncMock()):
            result = await handle_human_approval(
                pool=pool,
                org_id=uuid.uuid4(),
                variant_id=uuid.uuid4(),
                actor_user_id=uuid.uuid4(),
            )

        assert result == {}

    @pytest.mark.asyncio
    async def test_force_approve_sets_flag(self):
        """force_approve=True logs force_approved event."""
        from app.services.approval_engine import handle_human_approval

        pool, conn = _make_pool()
        approved_row = _variant_row(status="approved")
        conn.fetchrow.return_value = approved_row
        logged_events = []

        async def capture_event(**kwargs):
            logged_events.append(kwargs.get("event_type"))

        with patch("app.services.approval_engine.get_posting_mode", AsyncMock(return_value="approval")), \
             patch("app.services.approval_engine._enqueue_variant", AsyncMock(return_value=uuid.uuid4())), \
             patch("app.services.approval_engine._mark_variant_queued", AsyncMock()), \
             patch("app.services.approval_engine._log_event", AsyncMock(side_effect=capture_event)):
            await handle_human_approval(
                pool=pool,
                org_id=uuid.uuid4(),
                variant_id=uuid.uuid4(),
                actor_user_id=uuid.uuid4(),
                force_approve=True,
            )

        assert "force_approved" in logged_events


# ── handle_edit ──────────────────────────────────────────────────────────────────

class TestHandleEdit:
    @pytest.mark.asyncio
    async def test_edit_reverts_to_draft(self):
        """Edit always reverts variant to draft status."""
        from app.services.approval_engine import handle_edit

        pool, conn = _make_pool()
        edited_row = _variant_row(status="draft")
        conn.fetchrow.return_value = edited_row
        conn.execute.return_value = "UPDATE 0"  # no pending queue entries

        with patch("app.services.approval_engine.get_posting_mode", AsyncMock(return_value="auto")), \
             patch("app.services.approval_engine._log_event", AsyncMock()):
            result = await handle_edit(
                pool=pool,
                org_id=uuid.uuid4(),
                variant_id=uuid.uuid4(),
                new_body_text="Updated content",
                actor_user_id=uuid.uuid4(),
            )

        assert result["status"] == "draft"

    @pytest.mark.asyncio
    async def test_edit_cancels_pending_queue(self):
        """Edit cancels pending queue entries."""
        from app.services.approval_engine import handle_edit

        pool, conn = _make_pool()
        edited_row = _variant_row(status="draft")
        conn.fetchrow.return_value = edited_row

        # First execute call = cancel queue (UPDATE 2), second = update variant
        cancel_mock = AsyncMock(return_value="UPDATE 2")
        conn.execute = cancel_mock

        with patch("app.services.approval_engine.get_posting_mode", AsyncMock(return_value="approval")), \
             patch("app.services.approval_engine._log_event", AsyncMock()):
            result = await handle_edit(
                pool=pool,
                org_id=uuid.uuid4(),
                variant_id=uuid.uuid4(),
                new_body_text="New body",
                actor_user_id=uuid.uuid4(),
            )

        # execute was called (queue cancel + variant update)
        assert cancel_mock.call_count >= 1

    @pytest.mark.asyncio
    async def test_edit_logs_edited_event(self):
        """Edit logs an 'edited' approval event."""
        from app.services.approval_engine import handle_edit

        pool, conn = _make_pool()
        conn.fetchrow.return_value = _variant_row(status="draft")
        conn.execute.return_value = "UPDATE 0"

        logged = []

        async def capture(**kwargs):
            logged.append(kwargs.get("event_type"))

        with patch("app.services.approval_engine.get_posting_mode", AsyncMock(return_value="auto")), \
             patch("app.services.approval_engine._log_event", AsyncMock(side_effect=capture)):
            await handle_edit(
                pool=pool,
                org_id=uuid.uuid4(),
                variant_id=uuid.uuid4(),
                new_body_text="changed",
                actor_user_id=uuid.uuid4(),
            )

        assert "edited" in logged

    @pytest.mark.asyncio
    async def test_edit_published_variant_returns_empty(self):
        """Cannot edit published variant — returns empty dict."""
        from app.services.approval_engine import handle_edit

        pool, conn = _make_pool()
        conn.fetchrow.return_value = None   # UPDATE WHERE ... NOT IN ('published') → no row
        conn.execute.return_value = "UPDATE 0"

        with patch("app.services.approval_engine.get_posting_mode", AsyncMock(return_value="auto")), \
             patch("app.services.approval_engine._log_event", AsyncMock()):
            result = await handle_edit(
                pool=pool,
                org_id=uuid.uuid4(),
                variant_id=uuid.uuid4(),
                new_body_text="new",
                actor_user_id=uuid.uuid4(),
            )

        assert result == {}


# ── handle_explicit_queue ────────────────────────────────────────────────────────

class TestHandleExplicitQueue:
    @pytest.mark.asyncio
    async def test_queue_approved_variant_succeeds(self):
        """Explicit queue of an approved variant succeeds in any mode."""
        from app.services.approval_engine import handle_explicit_queue

        pool, conn = _make_pool()
        variant_id = uuid.uuid4()
        queue_id = uuid.uuid4()

        conn.fetchrow.return_value = {"id": variant_id, "platform": "linkedin", "status": "approved"}

        with patch("app.services.approval_engine.get_posting_mode", AsyncMock(return_value="suggestion_only")), \
             patch("app.services.approval_engine._enqueue_variant", AsyncMock(return_value=queue_id)), \
             patch("app.services.approval_engine._mark_variant_queued", AsyncMock()), \
             patch("app.services.approval_engine._log_event", AsyncMock()):
            result = await handle_explicit_queue(
                pool=pool,
                org_id=uuid.uuid4(),
                variant_id=variant_id,
                actor_user_id=uuid.uuid4(),
            )

        assert result["queue_id"] == queue_id
        assert result["status"] == "queued"

    @pytest.mark.asyncio
    async def test_queue_non_approved_variant_returns_error(self):
        """Cannot queue a draft — returns error dict."""
        from app.services.approval_engine import handle_explicit_queue

        pool, conn = _make_pool()
        conn.fetchrow.return_value = {
            "id": uuid.uuid4(), "platform": "linkedin", "status": "draft"
        }

        with patch("app.services.approval_engine.get_posting_mode", AsyncMock(return_value="auto")), \
             patch("app.services.approval_engine._log_event", AsyncMock()):
            result = await handle_explicit_queue(
                pool=pool,
                org_id=uuid.uuid4(),
                variant_id=uuid.uuid4(),
                actor_user_id=uuid.uuid4(),
            )

        assert "error" in result
        assert "draft" in result["error"]

    @pytest.mark.asyncio
    async def test_queue_works_in_suggestion_only_mode(self):
        """Explicit queue works even in suggestion_only mode."""
        from app.services.approval_engine import handle_explicit_queue

        pool, conn = _make_pool()
        conn.fetchrow.return_value = {
            "id": uuid.uuid4(), "platform": "facebook", "status": "approved"
        }

        queue_id = uuid.uuid4()

        with patch("app.services.approval_engine.get_posting_mode",
                   AsyncMock(return_value="suggestion_only")), \
             patch("app.services.approval_engine._enqueue_variant", AsyncMock(return_value=queue_id)), \
             patch("app.services.approval_engine._mark_variant_queued", AsyncMock()), \
             patch("app.services.approval_engine._log_event", AsyncMock()):
            result = await handle_explicit_queue(
                pool=pool,
                org_id=uuid.uuid4(),
                variant_id=uuid.uuid4(),
                actor_user_id=uuid.uuid4(),
            )

        assert result["status"] == "queued"


# ── handle_rejection ─────────────────────────────────────────────────────────────

class TestHandleRejection:
    @pytest.mark.asyncio
    async def test_rejection_returns_true_on_success(self):
        from app.services.approval_engine import handle_rejection

        pool, conn = _make_pool()
        conn.execute.return_value = "UPDATE 1"

        with patch("app.services.approval_engine.get_posting_mode", AsyncMock(return_value="auto")), \
             patch("app.services.approval_engine._cancel_pending_queue_entries", AsyncMock(return_value=0)), \
             patch("app.services.approval_engine._log_event", AsyncMock()):
            result = await handle_rejection(
                pool=pool,
                org_id=uuid.uuid4(),
                variant_id=uuid.uuid4(),
                actor_user_id=uuid.uuid4(),
            )

        assert result is True

    @pytest.mark.asyncio
    async def test_rejection_returns_false_if_not_found(self):
        from app.services.approval_engine import handle_rejection

        pool, conn = _make_pool()
        conn.execute.return_value = "UPDATE 0"

        with patch("app.services.approval_engine.get_posting_mode", AsyncMock(return_value="auto")), \
             patch("app.services.approval_engine._cancel_pending_queue_entries", AsyncMock(return_value=0)), \
             patch("app.services.approval_engine._log_event", AsyncMock()):
            result = await handle_rejection(
                pool=pool,
                org_id=uuid.uuid4(),
                variant_id=uuid.uuid4(),
                actor_user_id=uuid.uuid4(),
            )

        assert result is False

    @pytest.mark.asyncio
    async def test_rejection_cancels_queue(self):
        from app.services.approval_engine import handle_rejection

        pool, conn = _make_pool()
        conn.execute.return_value = "UPDATE 1"
        cancel_mock = AsyncMock(return_value=1)

        with patch("app.services.approval_engine.get_posting_mode", AsyncMock(return_value="approval")), \
             patch("app.services.approval_engine._cancel_pending_queue_entries", cancel_mock), \
             patch("app.services.approval_engine._log_event", AsyncMock()):
            await handle_rejection(
                pool=pool,
                org_id=uuid.uuid4(),
                variant_id=uuid.uuid4(),
                actor_user_id=uuid.uuid4(),
            )

        cancel_mock.assert_called_once()


# ── Cancel pending queue entries ─────────────────────────────────────────────────

class TestCancelPendingQueueEntries:
    @pytest.mark.asyncio
    async def test_cancels_only_pending(self):
        """Only 'pending' items are cancelled — locked/published untouched."""
        from app.services.approval_engine import _cancel_pending_queue_entries

        pool, conn = _make_pool()
        conn.execute.return_value = "UPDATE 2"

        count = await _cancel_pending_queue_entries(pool, uuid.uuid4())

        assert count == 2
        # Verify SQL only touches 'pending' status
        sql = conn.execute.call_args.args[0]
        assert "status = 'pending'" in sql

    @pytest.mark.asyncio
    async def test_returns_zero_when_nothing_to_cancel(self):
        from app.services.approval_engine import _cancel_pending_queue_entries

        pool, conn = _make_pool()
        conn.execute.return_value = "UPDATE 0"

        count = await _cancel_pending_queue_entries(pool, uuid.uuid4())
        assert count == 0


# ── Mode change does not affect already-queued items ────────────────────────────

class TestModeChangeIsolation:
    @pytest.mark.asyncio
    async def test_already_queued_items_unaffected_by_mode_change(self):
        """
        Changing posting_mode from auto to suggestion_only must not
        cancel or modify already-queued items.
        Mode is read per-action, not stored on the queue entry itself.
        """
        from app.services.approval_engine import handle_pipeline_completion

        # Simulate mode=suggestion_only AFTER an item is already queued
        # The already-queued item is in publish_queue with status='pending'
        # handle_pipeline_completion for a NEW variant should not touch the old queue entry
        pool, conn = _make_pool()
        conn.execute.return_value = "UPDATE 1"   # _force_to_draft for suggestion_only

        new_variant_id = uuid.uuid4()
        cancel_mock = AsyncMock(return_value=0)

        with patch("app.services.approval_engine._cancel_pending_queue_entries", cancel_mock), \
             patch("app.services.approval_engine._enqueue_variant", AsyncMock()), \
             patch("app.services.approval_engine._log_event", AsyncMock()):
            await handle_pipeline_completion(
                pool=pool,
                org_id=uuid.uuid4(),
                variant_id=new_variant_id,
                critic_passed=True,
                platform="linkedin",
                posting_mode="suggestion_only",
            )

        # suggestion_only pipeline completion does NOT cancel queue entries
        cancel_mock.assert_not_called()


# ── Approval history ─────────────────────────────────────────────────────────────

class TestGetApprovalHistory:
    @pytest.mark.asyncio
    async def test_returns_events_newest_first(self):
        from app.services.approval_engine import get_approval_history

        pool, conn = _make_pool()
        now = datetime.now(timezone.utc)
        variant_id = uuid.uuid4()
        org_id = uuid.uuid4()

        conn.fetch.return_value = [
            {
                "id": uuid.uuid4(),
                "variant_id": variant_id,
                "org_id": org_id,
                "event_type": "human_approved",
                "actor_user_id": uuid.uuid4(),
                "mode_at_event": "approval",
                "notes": None,
                "metadata": None,
                "created_at": now,
            }
        ]

        events = await get_approval_history(pool, org_id, variant_id, limit=50)
        assert len(events) == 1
        assert events[0]["event_type"] == "human_approved"

    @pytest.mark.asyncio
    async def test_empty_history_returns_empty_list(self):
        from app.services.approval_engine import get_approval_history

        pool, conn = _make_pool()
        conn.fetch.return_value = []

        events = await get_approval_history(pool, uuid.uuid4(), uuid.uuid4())
        assert events == []


# ── Pipeline integration: suggestion_only always saves as draft ──────────────────

class TestPipelineSuggestionOnly:
    """
    Integration-level test: verify content_pipeline._save_variant is called
    with save_status='draft' when posting_mode='suggestion_only',
    regardless of whether the critic passed.
    """

    @pytest.mark.asyncio
    async def test_suggestion_only_saves_as_draft_even_when_critic_passes(self):
        from app.services.content_pipeline import run_pipeline_for_variant

        org_id = uuid.uuid4()
        idea_id = uuid.uuid4()
        variant_id = uuid.uuid4()

        mock_angle = MagicMock()
        mock_angle.angle_type = "contrarian"
        mock_angle.angle_title = "Why X is wrong"
        mock_angle.core_claim = "claim"

        mock_hook = MagicMock()
        mock_hook.hook_text = "hook"
        mock_hook.rank = 1
        mock_hook.total_score = 4.2
        mock_hook.style = "question"

        mock_critic = MagicMock()
        mock_critic.passed = True  # critic says approve
        mock_critic.scores = {}
        mock_critic.revision_brief = None
        mock_critic.failed_thresholds = []
        mock_critic.weaknesses = []
        mock_critic.generic_phrases_found = []

        # Track what status was used in the INSERT
        saved_statuses = []

        async def mock_save_variant(*args, save_status, **kwargs):
            saved_statuses.append(save_status)
            return variant_id

        pool = MagicMock()
        pool.acquire = MagicMock()
        conn = AsyncMock()
        conn.fetchrow = AsyncMock(return_value=None)
        conn.execute = AsyncMock(return_value="UPDATE 1")
        pool.acquire.return_value.__aenter__ = AsyncMock(return_value=conn)
        pool.acquire.return_value.__aexit__ = AsyncMock(return_value=False)

        from app.models.brand import BrandProfileOut
        brand = MagicMock(spec=BrandProfileOut)

        with patch("app.services.content_pipeline.generate_angle", AsyncMock(return_value=mock_angle)), \
             patch("app.services.content_pipeline.run_hook_tournament", AsyncMock(return_value=mock_hook)), \
             patch("app.services.content_pipeline.write_draft", AsyncMock(return_value="draft text")), \
             patch("app.services.content_pipeline.run_critic", AsyncMock(return_value=mock_critic)), \
             patch("app.services.content_pipeline._save_hook_candidates", AsyncMock()), \
             patch("app.services.content_pipeline._save_variant", mock_save_variant), \
             patch("app.services.content_pipeline.handle_pipeline_completion", AsyncMock()), \
             patch("app.services.content_pipeline.get_posting_mode",
                   AsyncMock(return_value="suggestion_only")):
            result = await run_pipeline_for_variant(
                pool=pool,
                org_id=org_id,
                brand=brand,
                idea_id=idea_id,
                platform="linkedin",
                topic="AI productivity",
                pillar="efficiency",
                hook_seed="hook seed",
                posting_mode="suggestion_only",
            )

        assert saved_statuses[0] == "draft"
        assert result.status == "draft"

    @pytest.mark.asyncio
    async def test_auto_mode_saves_as_approved_when_critic_passes(self):
        from app.services.content_pipeline import run_pipeline_for_variant

        org_id = uuid.uuid4()
        idea_id = uuid.uuid4()
        variant_id = uuid.uuid4()

        mock_angle = MagicMock()
        mock_angle.angle_type = "contrarian"
        mock_angle.angle_title = "title"
        mock_angle.core_claim = "claim"

        mock_hook = MagicMock()
        mock_hook.hook_text = "hook"
        mock_hook.rank = 1
        mock_hook.total_score = 4.5
        mock_hook.style = "stat"

        mock_critic = MagicMock()
        mock_critic.passed = True
        mock_critic.scores = {}
        mock_critic.revision_brief = None
        mock_critic.failed_thresholds = []
        mock_critic.weaknesses = []
        mock_critic.generic_phrases_found = []

        saved_statuses = []

        async def mock_save_variant(*args, save_status, **kwargs):
            saved_statuses.append(save_status)
            return variant_id

        pool = MagicMock()
        pool.acquire = MagicMock()
        conn = AsyncMock()
        conn.fetchrow = AsyncMock(return_value=None)
        conn.execute = AsyncMock(return_value="UPDATE 1")
        pool.acquire.return_value.__aenter__ = AsyncMock(return_value=conn)
        pool.acquire.return_value.__aexit__ = AsyncMock(return_value=False)

        from app.models.brand import BrandProfileOut
        brand = MagicMock(spec=BrandProfileOut)

        with patch("app.services.content_pipeline.generate_angle", AsyncMock(return_value=mock_angle)), \
             patch("app.services.content_pipeline.run_hook_tournament", AsyncMock(return_value=mock_hook)), \
             patch("app.services.content_pipeline.write_draft", AsyncMock(return_value="content")), \
             patch("app.services.content_pipeline.run_critic", AsyncMock(return_value=mock_critic)), \
             patch("app.services.content_pipeline._save_hook_candidates", AsyncMock()), \
             patch("app.services.content_pipeline._save_variant", mock_save_variant), \
             patch("app.services.content_pipeline.handle_pipeline_completion", AsyncMock()), \
             patch("app.services.content_pipeline.get_posting_mode",
                   AsyncMock(return_value="auto")):
            result = await run_pipeline_for_variant(
                pool=pool,
                org_id=org_id,
                brand=brand,
                idea_id=idea_id,
                platform="linkedin",
                topic="AI productivity",
                pillar="efficiency",
                hook_seed="hook seed",
                posting_mode="auto",
            )

        assert saved_statuses[0] == "approved"
        assert result.status == "approved"
