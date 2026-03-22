# DB Backup Runbook — Growth Engine

## Overview

| | |
|---|---|
| **Database** | Supabase-hosted PostgreSQL (project: `klbwigcvrdfeeeeotehu`) |
| **RPO target** | 24 hours (daily backups acceptable; hourly for `growth.*` schema in critical phases) |
| **RTO target** | < 2 hours to restore from backup to live traffic |
| **Backup method** | Supabase PITR + manual `pg_dump` before migrations |

---

## 1. Automated Backups (Supabase)

Supabase provides Point-in-Time Recovery (PITR) on Pro plan and above.

**Verify PITR is enabled:**
1. Go to https://app.supabase.com/project/klbwigcvrdfeeeeotehu/settings/addons
2. Confirm "Point in Time Recovery" is active
3. Confirm retention window (minimum: 7 days)

**To restore from PITR:**
1. Go to Settings → Database → Backups
2. Select timestamp to restore to
3. Supabase creates a new project from the snapshot — swap `DATABASE_URL` in Railway env after verification

---

## 2. Pre-Migration Manual Backup

Run this before every migration:

```bash
# Set from Railway env or .env
export DATABASE_URL="postgresql://..."

# Dump only the growth schema (fast, targeted)
pg_dump "$DATABASE_URL" \
  --schema=growth \
  --format=custom \
  --no-owner \
  --no-privileges \
  --file="backups/growth_$(date +%Y%m%d_%H%M%S).dump"

# Dump full DB (slower, complete safety net)
pg_dump "$DATABASE_URL" \
  --format=custom \
  --no-owner \
  --no-privileges \
  --file="backups/full_$(date +%Y%m%d_%H%M%S).dump"
```

Store dumps in `backups/` (gitignored). Keep at least the last 3.

---

## 3. Restore Procedure

### Restore growth schema only (preferred — leaves public.* intact):

```bash
pg_restore \
  --dbname="$DATABASE_URL" \
  --schema=growth \
  --no-owner \
  --no-privileges \
  --clean \
  --if-exists \
  backups/growth_YYYYMMDD_HHMMSS.dump
```

### Restore full database (destructive — use only for complete failure):

```bash
# WARNING: this drops and recreates all tables
pg_restore \
  --dbname="$DATABASE_URL" \
  --no-owner \
  --no-privileges \
  --clean \
  --if-exists \
  backups/full_YYYYMMDD_HHMMSS.dump
```

After restore: re-run `alembic upgrade head` to confirm migration state is consistent.

---

## 4. Migration Rollback

Each migration has a `downgrade()` function. To roll back one step:

```bash
cd growth_engine
alembic downgrade -1
```

To roll back to a specific revision:
```bash
alembic downgrade 009   # rolls back to state after 009
```

**Note:** downgrades that `DROP TABLE` are destructive. Always take a backup first.

---

## 5. Critical Tables (prioritise in recovery order)

| Priority | Table | Why |
|---|---|---|
| 1 | `public.organizations` | All FK root; without this, nothing works |
| 2 | `growth.engagement_opportunities` | Active pipeline state |
| 3 | `growth.influencer_nodes` | Growth graph — expensive to rebuild |
| 4 | `growth.decision_attributions` | Attribution audit trail |
| 5 | `growth.revenue_attributions` | Lead conversion links |
| 6 | `growth.learning_state` + `growth.learning_events` | Can be rebuilt by re-running sweeps |
| 7 | `growth.radar_snapshots` | Derived — rebuild by running `/internal/run-radar` |

---

## 6. Backup Verification Checklist

Run after every restore before returning to live traffic:

```bash
# Confirm row counts are plausible
psql "$DATABASE_URL" -c "
  SELECT
    (SELECT COUNT(*) FROM growth.engagement_opportunities) AS opps,
    (SELECT COUNT(*) FROM growth.influencer_nodes)         AS nodes,
    (SELECT COUNT(*) FROM growth.decision_attributions)    AS decisions,
    (SELECT COUNT(*) FROM growth.revenue_attributions)     AS attributions;
"

# Confirm migrations are consistent
cd growth_engine && alembic current

# Confirm health endpoint is live
curl https://your-engine.railway.app/health
```

Expected: `{"status": "ok", "db": "connected", ...}`

---

## 7. Escalation

| Scenario | Action |
|---|---|
| PITR restore needed | Supabase support + swap DATABASE_URL in Railway |
| Schema corrupt (bad migration) | `alembic downgrade -1` + restore from pre-migration dump |
| Full data loss | Restore from latest `full_*.dump` + run `alembic upgrade head` |
| Scoring queue stuck | Run `POST /internal/sweep` — sweeper handles stuck rows |
