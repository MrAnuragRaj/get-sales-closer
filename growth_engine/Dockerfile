# ──────────────────────────────────────────────────────────────────────────────
# Growth Engine — Dockerfile
# Railway-ready, portable to any OCI-compliant platform.
# ──────────────────────────────────────────────────────────────────────────────

FROM python:3.12-slim AS base

# Prevents Python from writing .pyc files and buffers stdout/stderr
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# System deps required for Pillow (Phase 3 image rendering) and asyncpg
RUN apt-get update && apt-get install -y --no-install-recommends \
        libpq-dev \
        libjpeg-dev \
        zlib1g-dev \
        libfreetype6-dev \
        liblcms2-dev \
        libopenjp2-7-dev \
        libtiff-dev \
        libwebp-dev \
        build-essential \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── Dependency layer (cached separately from source) ──────────────────────────
FROM base AS deps
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ── Final image ───────────────────────────────────────────────────────────────
FROM deps AS runtime

# Copy application source
COPY . .

# Non-root user for security
RUN addgroup --system growth && adduser --system --ingroup growth growth \
    && chown -R growth:growth /app
USER growth

# Expose API port — Railway injects $PORT; default 8080 for local/Docker Compose
EXPOSE 8080

# Shell form so $PORT env var is expanded at runtime.
# Railway sets PORT automatically to match the service domain port you configured.
# Locally defaults to 8080 if PORT is not set.
CMD uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8080}
