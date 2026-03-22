"""
Alembic migration environment.

DB URL is read from the DATABASE_URL environment variable (same as the app).
We run migrations synchronously using psycopg2 / SQLAlchemy sync driver
because Alembic does not support asyncpg natively.

To run migrations:
    cd growth_engine
    alembic upgrade head

To create a new revision:
    alembic revision --autogenerate -m "describe_change"
"""

from __future__ import annotations

import os
from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

# ── Alembic config ─────────────────────────────────────────────────────────────
config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# ── DB URL ─────────────────────────────────────────────────────────────────────
# Read from env — never hardcoded.
# Alembic needs a sync URL (psycopg2). Convert asyncpg URL if needed.
_raw_url = os.environ.get("DATABASE_URL", "")
if not _raw_url:
    raise RuntimeError(
        "DATABASE_URL environment variable is required to run migrations. "
        "Set it in your shell or .env file before running 'alembic upgrade head'."
    )

# Ensure we use the synchronous psycopg2 driver for Alembic
_sync_url = (
    _raw_url
    .replace("postgresql+asyncpg://", "postgresql://")
    .replace("postgresql://", "postgresql+psycopg2://")
    if "+psycopg2" not in _raw_url
    else _raw_url
)

config.set_main_option("sqlalchemy.url", _sync_url)

target_metadata = None  # We use raw SQL in migrations, not ORM metadata


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode (no DB connection — outputs SQL only)."""
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode (live DB connection)."""
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
