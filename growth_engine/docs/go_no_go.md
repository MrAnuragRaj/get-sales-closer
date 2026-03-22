# Growth Engine — Go / No-Go Launch Checklist

Complete every **Must-Pass** item before opening live traffic. Items in **Acceptable Limitations** are known gaps that do not block launch.

---

## Must-Pass (all required before launch)

### Infrastructure

- [ ] **Migrations applied** — `alembic current` shows `head` on production DB
- [ ] **`/health` returns 200** — `{"status": "ok", "db": "connected"}` on production URL
- [ ] **Railway deploy healthy** — no crash-loop, replica count ≥ 1

### Publishing

- [ ] **LinkedIn publish works** — post from queue reaches LinkedIn successfully (spot-check 1 post)
- [ ] **Instagram publish works** — if `PLATFORM_INSTAGRAM_ENABLED=true`, post reaches Instagram

### Engagement

- [ ] **Engagement discovery works** — `/targets/{id}/discover` accepts posts and creates opportunities
- [ ] **Opportunity scoring works** — scoring worker assigns `confidence_score` and routes to `approved` or `pending_review`
- [ ] **Opportunity execution works** — executing an approved opportunity posts a reply/comment on the platform
- [ ] **Execute gated on platform capability** — attempting execute on a disconnected platform returns 4xx, not 500

### Safety

- [ ] **Rate limiting active** — `/internal/run-scoring-worker` returns 429 when burst limit is exceeded
- [ ] **INTERNAL_SWEEP_SECRET set** — missing secret returns 503, not 200
- [ ] **CORS locked in production** — `ENVIRONMENT=production` confirmed; Swagger UI inaccessible at `/docs`

### Automation

- [ ] **Scoring worker cron active** — cron fires `/internal/run-scoring-worker` on schedule; Railway logs show periodic runs
- [ ] **Sweeper active** — `task_sweeper` cron fires; stuck opportunities are re-queued

### Dashboard

- [ ] **Dashboard API base correct** — `growth-config.js` points to production Railway URL, not localhost
- [ ] **Session expiry redirects** — expiring JWT triggers redirect to `login.html` (not a blank error)
- [ ] **Engagement tab loads** — Opportunities, Targets, Actions sub-tabs all render without JS errors

---

## Acceptable Limitations (known at launch — do not block)

| Limitation | Impact | Resolution path |
|---|---|---|
| Instagram engagement unsupported | Cannot auto-comment on Instagram posts | Planned for a future sprint; publish-only works |
| X (Twitter) dormant | `PLATFORM_X_ENABLED=false` | Flip env flag when X API access is confirmed |
| Attribution is heuristic/correlation-based | Revenue attribution matches on psid + name; not deterministic | Acceptable for v1; improve with CRM webhooks later |
| Learning loop off by default | Scoring thresholds are static (plan defaults) | Flip `LEARNING_LOOP_ENABLED=true` after 30d of data |
| Growth graph priority off by default | Queue is pure FIFO | Flip `GROWTH_GRAPH_PRIORITY_ENABLED=true` when relationship data is populated |
| Radar snapshot is manual/cron-generated | No real-time radar; shows last computed snapshot | Snapshot refreshes each time `/internal/run-radar` runs |

---

## How to use this checklist

1. Deploy to production.
2. Run `alembic current` against production DB.
3. Curl each endpoint or use the load test script for pressure validation.
4. Tick every Must-Pass item.
5. Document any Acceptable Limitations that apply to this specific launch.
6. Sign off: **"All Must-Pass items green. Proceeding to live traffic."**

---

## Rollback triggers (stop traffic immediately if any of these occur)

| Signal | Action |
|---|---|
| `/health` returns `db: error` | Check DB pool; if persistent, `alembic downgrade -1` + restore from backup |
| Scoring worker returns 500 consistently | Check Railway logs; likely DB schema mismatch — re-run migrations |
| Execute returns 502 on all platforms | Platform adapter failure — check platform credentials in env |
| DB pool timeout in logs | Scale Railway replica or reduce `SCORING_WORKER_BATCH_SIZE` |
