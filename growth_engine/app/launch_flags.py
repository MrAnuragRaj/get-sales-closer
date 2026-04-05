"""
launch_flags.py — Growth Engine feature gates for initial launch.

All flags default to False (safe/off). Enable each one by setting the
corresponding environment variable to "true" in Railway.

This is the single source of truth for what is active. Import from here
anywhere a feature needs to be conditionally enabled.

Current flag status (update this comment when you flip a flag):
  AUTO_POSTING_ENABLED          = False  (default — approval mode required)
  ENGAGEMENT_EXECUTION_ENABLED  = False  (not yet fully tested)
  IMAGE_CAROUSEL_ENABLED        = False  (Pillow rendering untested on Railway)
  IMAGE_STAT_CARD_ENABLED       = False  (same)
  X_PUBLISHING_ENABLED          = False  (requires Twitter Elevated API tier)
"""

import os


def _flag(env_var: str, default: bool = False) -> bool:
    """Read a boolean feature flag from environment. Defaults to `default`."""
    return os.getenv(env_var, "true" if default else "false").lower() == "true"


# ── Publishing ────────────────────────────────────────────────────────────────

# Allow the system to publish content without human review when posting_mode=auto.
# Requires each org to explicitly opt into auto mode in org_growth_settings.
# Risk: content goes live without human oversight.
AUTO_POSTING_ENABLED: bool = _flag("GE_AUTO_POSTING_ENABLED", default=False)

# Enable X (Twitter) publisher. Requires Twitter Elevated API access tier.
# Most orgs don't have this approved — enabling prematurely causes 403 errors.
X_PUBLISHING_ENABLED: bool = _flag("GE_X_PUBLISHING_ENABLED", default=False)

# ── Image templates ───────────────────────────────────────────────────────────

# Carousel and stat_card use multi-frame Pillow rendering that has not been
# stress-tested on Railway's build environment. Only quote_card is safe.
IMAGE_CAROUSEL_ENABLED: bool = _flag("GE_IMAGE_CAROUSEL_ENABLED", default=False)
IMAGE_STAT_CARD_ENABLED: bool = _flag("GE_IMAGE_STAT_CARD_ENABLED", default=False)

# ── Engagement ────────────────────────────────────────────────────────────────

# Execute active engagement actions (comment/react on others' posts).
# Risk: rate-limit violations, unintended public actions on behalf of org.
# Keep disabled until engagement pipeline has passed full end-to-end tests.
ENGAGEMENT_EXECUTION_ENABLED: bool = _flag("GE_ENGAGEMENT_EXECUTION_ENABLED", default=False)
