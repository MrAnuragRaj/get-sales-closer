"""
015 — Growth Feature Flags

Creates growth.feature_flags for DB-backed feature flag control.
Allows toggling GROWTH_GRAPH_PRIORITY and LEARNING_LOOP at runtime
without a Railway redeploy, via POST /internal/feature-flags/{key}.

Schema:
  key TEXT              — flag identifier (e.g. 'growth_graph_priority')
  environment TEXT      — 'development' | 'staging' | 'production'
  enabled BOOLEAN       — current state (default false)
  updated_at TIMESTAMPTZ
  updated_by_user_id UUID NULL  — audit: who last toggled

Primary key is (key, environment) so staging/production are isolated
even when sharing a database.

Seed: both allowed keys seeded for all three environments, all OFF.
"""

from alembic import op
import sqlalchemy as sa


# Alembic revision identifiers
revision = "015"
down_revision = "014"
branch_labels = None
depends_on = None

ALLOWED_KEYS = ("growth_graph_priority", "learning_loop")
ENVIRONMENTS = ("development", "staging", "production")


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS growth.feature_flags (
            key                  TEXT        NOT NULL,
            environment          TEXT        NOT NULL,
            enabled              BOOLEAN     NOT NULL DEFAULT false,
            updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_by_user_id   UUID        NULL,
            PRIMARY KEY (key, environment)
        )
    """)

    # Seed rows — all OFF by default
    for key in ALLOWED_KEYS:
        for env in ENVIRONMENTS:
            op.execute(f"""
                INSERT INTO growth.feature_flags (key, environment, enabled)
                VALUES ('{key}', '{env}', false)
                ON CONFLICT (key, environment) DO NOTHING
            """)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS growth.feature_flags")
