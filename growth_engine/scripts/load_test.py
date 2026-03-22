"""
Growth Engine Load Test — Locust script.

Tests the real operational pressure points identified in the architecture:
  1. Discovery   — POST /growth/engagement/targets/{id}/discover
  2. Execute     — POST /growth/engagement/opportunities/{id}/execute
  3. Scoring     — POST /internal/run-scoring-worker
  4. Publish     — GET  /growth/queue (read pressure)
  5. Analytics   — GET  /growth/analytics/overview (read load)

Output metrics per task:
  p50, p95, p99 latency | req/s | error rate | 429 count

Usage:
  pip install locust
  locust -f scripts/load_test.py --host=http://localhost:8000

  # Headless run (CI/staging):
  locust -f scripts/load_test.py --host=https://your-engine.railway.app \\
         --users 20 --spawn-rate 2 --run-time 60s --headless \\
         --csv results/load_test

Required environment variables:
  LOAD_TEST_JWT              — valid Bearer token for a test org
  LOAD_TEST_ORG_ID           — UUID of the test org
  LOAD_TEST_TARGET_ID        — UUID of an active engagement target in that org
  LOAD_TEST_OPPORTUNITY_ID   — UUID of an approved opportunity (reset between runs)
  LOAD_TEST_INTERNAL_SECRET  — INTERNAL_SWEEP_SECRET value

Tip: create a dedicated test org so load test activity is isolated from
production data. Reset LOAD_TEST_OPPORTUNITY_ID to an 'approved' or
'auto_approved' row before each execute-heavy run.
"""

from __future__ import annotations

import json
import os
import random

from locust import HttpUser, between, task

# ── Config from environment ───────────────────────────────────────────────────
JWT              = os.environ.get("LOAD_TEST_JWT", "")
ORG_ID           = os.environ.get("LOAD_TEST_ORG_ID", "")
TARGET_ID        = os.environ.get("LOAD_TEST_TARGET_ID", "")
OPPORTUNITY_ID   = os.environ.get("LOAD_TEST_OPPORTUNITY_ID", "")
INTERNAL_SECRET  = os.environ.get("LOAD_TEST_INTERNAL_SECRET", "")

# ── Synthetic discovery payloads ──────────────────────────────────────────────
_SAMPLE_POSTS = [
    {
        "post_platform_id": f"test_post_{i:04d}",
        "post_url": f"https://linkedin.com/feed/update/test_{i:04d}",
        "post_body": (
            "Exciting developments in B2B sales automation. "
            "AI-powered outreach is changing how we close deals — "
            "curious what tools people are actually using right now."
        ),
        "author_platform_id": f"author_{i % 20:04d}",
        "author_name": f"Test Author {i % 20}",
        "opportunity_type": "comment",
    }
    for i in range(200)
]


class GrowthEngineUser(HttpUser):
    """
    Simulates a mix of authenticated user traffic + internal cron pressure.

    Wait time: 1–3 seconds between tasks (realistic user pacing).
    Task weights: discovery (3×) > analytics read (3×) > queue read (2×)
                  > execute (1×) > scoring worker (1×)
    """
    wait_time = between(1, 3)

    def on_start(self) -> None:
        self._auth_headers = {
            "Authorization": f"Bearer {JWT}",
            "Content-Type": "application/json",
        }
        self._internal_headers = {
            "X-Internal-Secret": INTERNAL_SECRET,
            "Content-Type": "application/json",
        }
        self._post_pool = _SAMPLE_POSTS.copy()

    # ── Pressure point 1: Discovery ───────────────────────────────────────────
    @task(3)
    def discover_posts(self) -> None:
        """
        POST /growth/engagement/targets/{id}/discover
        Pressure: dedup check + DB insert × batch size + growth graph upsert.
        Expected: < 200ms at low concurrency; should stay < 500ms under load.
        Watch for: 429 (rate limit), 403 (no plan), DB pool exhaustion.
        """
        if not TARGET_ID:
            return

        # Pick a random batch of 3–5 posts from the pool (some will be dups)
        posts = random.sample(self._post_pool, k=random.randint(3, 5))
        with self.client.post(
            f"/growth/engagement/targets/{TARGET_ID}/discover",
            json={"posts": posts},
            headers=self._auth_headers,
            catch_response=True,
            name="POST /engagement/discover",
        ) as resp:
            if resp.status_code == 429:
                resp.success()   # rate limit is expected behavior, not a failure
                self.environment.events.request.fire(
                    request_type="POST",
                    name="POST /engagement/discover [429-rate-limited]",
                    response_time=resp.elapsed.total_seconds() * 1000,
                    response_length=len(resp.content),
                    exception=None,
                    context={},
                )
            elif resp.status_code not in (200, 201):
                resp.failure(f"unexpected status {resp.status_code}: {resp.text[:200]}")

    # ── Pressure point 2: Execute ─────────────────────────────────────────────
    @task(1)
    def execute_opportunity(self) -> None:
        """
        POST /growth/engagement/opportunities/{id}/execute
        Pressure: cap check + idempotency claim + platform adapter call.
        Expected: may be slow (LLM-free, but platform API round-trip).
        Watch for: 409 (already executing), 429 (cap exceeded), 502 (platform error).
        """
        if not OPPORTUNITY_ID:
            return

        with self.client.post(
            f"/growth/engagement/opportunities/{OPPORTUNITY_ID}/execute",
            headers=self._auth_headers,
            catch_response=True,
            name="POST /engagement/execute",
        ) as resp:
            # 409 = duplicate claim (expected under concurrent load) — not a failure
            if resp.status_code in (409, 429):
                resp.success()
            elif resp.status_code not in (200, 201):
                resp.failure(f"unexpected status {resp.status_code}: {resp.text[:200]}")

    # ── Pressure point 3: Scoring worker ─────────────────────────────────────
    @task(1)
    def trigger_scoring_worker(self) -> None:
        """
        POST /internal/run-scoring-worker
        Pressure: FOR UPDATE SKIP LOCKED + LLM call per row in batch.
        Expected: 1–5s depending on batch size and LLM latency.
        Watch for: timeout (LLM), DB pool starvation under high concurrency.
        """
        if not INTERNAL_SECRET:
            return

        with self.client.post(
            "/internal/run-scoring-worker",
            headers=self._internal_headers,
            catch_response=True,
            name="POST /internal/scoring-worker",
            timeout=30,
        ) as resp:
            if resp.status_code == 200:
                data = resp.json()
                if data.get("processed", 0) == 0:
                    resp.success()  # idle worker is fine
            elif resp.status_code == 503:
                resp.failure("internal secret not configured on this deployment")
            elif resp.status_code != 200:
                resp.failure(f"unexpected status {resp.status_code}: {resp.text[:200]}")

    # ── Pressure point 4: Queue reads ─────────────────────────────────────────
    @task(2)
    def read_queue(self) -> None:
        """
        GET /growth/queue
        Pressure: publish queue reads — moderate DB + auth overhead.
        Expected: < 150ms. Degrades if DB pool is saturated by writers.
        """
        with self.client.get(
            "/growth/queue?limit=50",
            headers=self._auth_headers,
            catch_response=True,
            name="GET /queue",
        ) as resp:
            if resp.status_code != 200:
                resp.failure(f"unexpected status {resp.status_code}")

    # ── Pressure point 5: Analytics reads ─────────────────────────────────────
    @task(3)
    def read_analytics_overview(self) -> None:
        """
        GET /growth/analytics/overview
        Pressure: cross-table aggregation — most expensive read in the system.
        Expected: < 300ms with proper indexes; watch for full-table scans.
        """
        with self.client.get(
            "/growth/analytics/overview",
            headers=self._auth_headers,
            catch_response=True,
            name="GET /analytics/overview",
        ) as resp:
            if resp.status_code != 200:
                resp.failure(f"unexpected status {resp.status_code}")

    # ── Bonus: Health check (cheap baseline) ─────────────────────────────────
    @task(1)
    def health_check(self) -> None:
        with self.client.get(
            "/health",
            catch_response=True,
            name="GET /health",
        ) as resp:
            if resp.status_code != 200:
                resp.failure(f"health degraded: {resp.text[:100]}")
            else:
                data = resp.json()
                if data.get("db") != "connected":
                    resp.failure("db not connected")


# ── Interpretation guide ──────────────────────────────────────────────────────
#
# Healthy baselines (20 concurrent users, 60s run):
#
#   GET  /health              p95 < 50ms    error rate 0%
#   GET  /queue               p95 < 150ms   error rate 0%
#   GET  /analytics/overview  p95 < 400ms   error rate 0%
#   POST /engagement/discover p95 < 500ms   429 rate expected; error rate 0%
#   POST /engagement/execute  p95 < 3000ms  409 rate expected; error rate 0%
#   POST /internal/scoring    p95 < 8000ms  idle workers return fast
#
# Red flags:
#   - Any non-429/409 errors on discover/execute
#   - /health showing db=error during load
#   - p95 > 1s on /queue or /analytics under 20 users
#   - DB pool exhaustion logs ("connection pool timeout")
#
