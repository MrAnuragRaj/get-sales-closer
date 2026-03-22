"""
Platform publishers — one adapter per platform.

All publishers implement BasePublisher and return PublishResult.
The queue worker calls the correct adapter based on publish_queue.platform.

Active in v1:   linkedin, facebook, instagram
Dormant in v1:  x (PLATFORM_X_ENABLED=false — no code changes needed to activate)
"""
