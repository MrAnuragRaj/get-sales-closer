"""
Platform metrics normalizer.

Each platform returns metrics in a different format. This module maps
platform-native payloads to the standard ContentMetrics schema.

Supported platform formats:

  LinkedIn (/v2/organizationalEntityShareStatistics):
    {
      "totalShareStatistics": {
        "impressionCount": int,
        "uniqueImpressionsCount": int,
        "clickCount": int,
        "likeCount": int,
        "commentCount": int,
        "shareCount": int,
        "engagement": float
      }
    }

  X (/2/tweets/{id}?tweet.fields=public_metrics):
    {
      "data": {
        "public_metrics": {
          "impression_count": int,
          "like_count": int,
          "reply_count": int,
          "retweet_count": int,
          "quote_count": int,
          "bookmark_count": int,
          "url_link_clicks": int
        }
      }
    }

  Facebook (/post-id/insights):
    {
      "data": [
        {"name": "post_impressions", "values": [{"value": int}]},
        {"name": "post_clicks", "values": [{"value": int}]},
        {"name": "post_reactions_by_type_total", "values": [{"value": {...}}]},
        {"name": "post_comments", "values": [{"value": int}]},
        {"name": "post_shares", "values": [{"value": int}]}
      ]
    }

  Instagram (/media/{id}?fields=insights):
    {
      "insights": {
        "data": [
          {"name": "impressions", "values": [{"value": int}]},
          {"name": "reach", "values": [{"value": int}]},
          {"name": "likes", "values": [{"value": int}]},
          {"name": "comments", "values": [{"value": int}]},
          {"name": "shares", "values": [{"value": int}]},
          {"name": "saved", "values": [{"value": int}]},
          {"name": "video_views", "values": [{"value": int}]}
        ]
      }
    }

Manual import (when platform API is unavailable):
  {
    "impressions": int,
    "reach": int,
    "clicks": int,
    "reactions": int,
    "comments": int,
    "shares": int,
    "video_views": int
  }
"""

from __future__ import annotations

from typing import Any

from app.logging_config import get_logger

log = get_logger(__name__)


class NormalizedMetrics:
    """Standardized metric container for all platforms."""
    __slots__ = (
        "impressions", "reach", "clicks", "reactions",
        "comments_received", "shares", "video_views", "engagement_rate",
    )

    def __init__(
        self,
        impressions: int = 0,
        reach: int = 0,
        clicks: int = 0,
        reactions: int = 0,
        comments_received: int = 0,
        shares: int = 0,
        video_views: int = 0,
    ) -> None:
        self.impressions = max(0, impressions)
        self.reach = max(0, reach)
        self.clicks = max(0, clicks)
        self.reactions = max(0, reactions)
        self.comments_received = max(0, comments_received)
        self.shares = max(0, shares)
        self.video_views = max(0, video_views)
        # engagement_rate = (reactions + comments + shares) / impressions
        denom = self.impressions or 1
        self.engagement_rate = round(
            (self.reactions + self.comments_received + self.shares) / denom, 6
        )

    def to_dict(self) -> dict:
        return {
            "impressions":       self.impressions,
            "reach":             self.reach,
            "clicks":            self.clicks,
            "reactions":         self.reactions,
            "comments_received": self.comments_received,
            "shares":            self.shares,
            "video_views":       self.video_views,
            "engagement_rate":   self.engagement_rate,
        }


def normalize(platform: str, raw: dict[str, Any]) -> NormalizedMetrics:
    """
    Normalize raw platform metrics to the standard schema.
    Falls back to zero metrics on any parse error.
    """
    try:
        fn = _NORMALIZERS.get(platform, _normalize_manual)
        return fn(raw)
    except Exception as exc:
        log.warning("metrics_normalization_failed", platform=platform, error=str(exc))
        return NormalizedMetrics()


def _normalize_linkedin(raw: dict) -> NormalizedMetrics:
    stats = raw.get("totalShareStatistics", raw)
    return NormalizedMetrics(
        impressions=_int(stats.get("impressionCount")),
        reach=_int(stats.get("uniqueImpressionsCount")),
        clicks=_int(stats.get("clickCount")),
        reactions=_int(stats.get("likeCount")),
        comments_received=_int(stats.get("commentCount")),
        shares=_int(stats.get("shareCount")),
    )


def _normalize_x(raw: dict) -> NormalizedMetrics:
    pm = raw.get("data", raw).get("public_metrics", raw)
    return NormalizedMetrics(
        impressions=_int(pm.get("impression_count")),
        reactions=_int(pm.get("like_count")),
        comments_received=_int(pm.get("reply_count")),
        shares=_int(pm.get("retweet_count")) + _int(pm.get("quote_count")),
        clicks=_int(pm.get("url_link_clicks")),
    )


def _normalize_facebook(raw: dict) -> NormalizedMetrics:
    data = raw.get("data", [])
    m: dict[str, int] = {}
    for item in data:
        name   = item.get("name", "")
        values = item.get("values", [{}])
        val    = values[0].get("value", 0) if values else 0
        if name == "post_impressions":
            m["impressions"] = _int(val)
        elif name == "post_impressions_unique":
            m["reach"] = _int(val)
        elif name == "post_clicks":
            m["clicks"] = _int(val)
        elif name == "post_reactions_by_type_total":
            # val is a dict {LIKE: N, LOVE: N, ...}
            m["reactions"] = sum(_int(v) for v in (val.values() if isinstance(val, dict) else [val]))
        elif name == "post_comments":
            m["comments_received"] = _int(val)
        elif name == "post_shares":
            m["shares"] = _int(val)

    return NormalizedMetrics(**m)


def _normalize_instagram(raw: dict) -> NormalizedMetrics:
    data = raw.get("insights", raw).get("data", [])
    m: dict[str, int] = {}
    for item in data:
        name   = item.get("name", "")
        values = item.get("values", [{}])
        val    = _int(values[0].get("value", 0) if values else 0)
        if name == "impressions":
            m["impressions"] = val
        elif name == "reach":
            m["reach"] = val
        elif name == "likes":
            m["reactions"] = val
        elif name == "comments":
            m["comments_received"] = val
        elif name == "shares":
            m["shares"] = val
        elif name == "video_views":
            m["video_views"] = val
    return NormalizedMetrics(**m)


def _normalize_manual(raw: dict) -> NormalizedMetrics:
    """Accept a pre-normalized dict — passthrough with type coercion."""
    return NormalizedMetrics(
        impressions=_int(raw.get("impressions")),
        reach=_int(raw.get("reach")),
        clicks=_int(raw.get("clicks")),
        reactions=_int(raw.get("reactions")),
        comments_received=_int(raw.get("comments") or raw.get("comments_received")),
        shares=_int(raw.get("shares")),
        video_views=_int(raw.get("video_views")),
    )


def _int(v: Any) -> int:
    try:
        return max(0, int(v or 0))
    except (TypeError, ValueError):
        return 0


_NORMALIZERS = {
    "linkedin":  _normalize_linkedin,
    "x":         _normalize_x,
    "facebook":  _normalize_facebook,
    "instagram": _normalize_instagram,
}
