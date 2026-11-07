"""A respectful, research-oriented TikTok metadata scraper.

Collects *public* metadata about TikTok videos (captions, hashtags, sounds,
engagement counts, publish times) for academic analysis.

Design principles
-----------------
1. Public metadata only. No private, logged-in, or personal data is touched.
2. No anti-bot evasion. We use the same public endpoints a browser uses and
   passively read the responses the browser already received. We do not forge
   signatures, rotate proxies, or defeat bot checks.
3. Slow by default. Rate limiting and jitter are on out of the box.
4. Reproducible. Every record records when and where it came from.
"""

__version__ = "1.0.0"

from .models import FIELDS, VideoRecord  # noqa: F401

__all__ = ["FIELDS", "VideoRecord", "__version__"]
