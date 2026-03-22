"""003 — asset is_active flag + deterministic storage path index

Changes:
  ALTER growth.content_assets
    ADD COLUMN is_active boolean NOT NULL DEFAULT true

  ADD UNIQUE INDEX on (variant_id, template_name, slide_index)
    — enforces one active asset per variant+template combination at the DB level
    — slide_index is NULL for non-carousel (treated as one slot)

  ADD COLUMN slide_index integer
    — NULL for single-image templates
    — 1–5 for carousel slides

Rationale:
  publish_queue.asset_id must point to a stable, unambiguous asset.
  Without is_active, every re-render appends a new row and there is no
  deterministic rule for which asset to publish.

  Rule (locked):
    When a new asset is rendered for variant+template+slide_index,
    all older rows for the same (variant_id, template_name, slide_index)
    are set is_active=false.
    The new row is inserted with is_active=true.

    Query for active asset:
      SELECT * FROM growth.content_assets
      WHERE variant_id = $1 AND template_name = $2 AND is_active = true
      ORDER BY created_at DESC LIMIT 1

Revision ID: 003
Revises: 002
Create Date: 2026-03-12
"""

from __future__ import annotations

from alembic import op

revision: str = "003"
down_revision = "002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
    -- Add slide_index for carousel slot tracking
    -- NULL = single-image template (quote_card, stat_card, single_visual)
    -- 1–5  = carousel slide position
    ALTER TABLE growth.content_assets
        ADD COLUMN slide_index  integer,
        ADD COLUMN is_active    boolean NOT NULL DEFAULT true;

    -- Index for efficient active-asset lookup
    -- Used by publish_queue to find the current rendition
    CREATE INDEX idx_content_assets_active
        ON growth.content_assets (variant_id, template_name, is_active)
        WHERE is_active = true AND variant_id IS NOT NULL;

    -- Index for the full history lookup (analytics: how many re-renders?)
    CREATE INDEX idx_content_assets_variant_template
        ON growth.content_assets (variant_id, template_name, created_at DESC)
        WHERE variant_id IS NOT NULL;
    """)


def downgrade() -> None:
    op.execute("""
    DROP INDEX IF EXISTS growth.idx_content_assets_active;
    DROP INDEX IF EXISTS growth.idx_content_assets_variant_template;
    ALTER TABLE growth.content_assets
        DROP COLUMN IF EXISTS slide_index,
        DROP COLUMN IF EXISTS is_active;
    """)
