"""Environment + runtime constants for calc-be.

All values come from environment (.env supported). Every missing or
malformed value is logged explicitly so misconfiguration is obvious
in logs without printing secrets.
"""

import logging
import os

from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger("calc-be.constants")

ENV = os.getenv("ENV", "dev")
# Hosted platforms (Render, Northflank, Cloud Run) require binding all
# interfaces; locally we keep localhost so the port isn't exposed.
SERVER_URL = os.getenv("SERVER_URL", "0.0.0.0" if ENV == "prod" else "localhost")
PORT = os.getenv("PORT", "8900")

# --- OpenRouter (vision) ---
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
OPENROUTER_BASE_URL = os.getenv(
    "OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"
).rstrip("/")
OPENROUTER_MODEL = os.getenv(
    "OPENROUTER_MODEL", "nvidia/nemotron-3.5-super-vl:free"
)
APP_SITE_URL = os.getenv("APP_SITE_URL", "http://localhost:8900")
APP_TITLE = os.getenv("APP_TITLE", "CalcDraw")


def _parse_int(name: str, raw: str, default: int) -> int:
    try:
        value = int(raw)
        if value <= 0:
            raise ValueError("must be > 0")
        return value
    except (TypeError, ValueError) as exc:
        logger.error(
            "invalid int env %s=%r, falling back to default=%d: %s",
            name,
            raw,
            default,
            exc,
        )
        return default


OPENROUTER_TIMEOUT_SEC = _parse_int(
    "OPENROUTER_TIMEOUT_SEC",
    os.getenv("OPENROUTER_TIMEOUT_SEC", "120"),
    120,
)
OPENROUTER_MAX_TOKENS = _parse_int(
    "OPENROUTER_MAX_TOKENS", os.getenv("OPENROUTER_MAX_TOKENS", "4096"), 4096
)
# Retries for transient model failures (empty content / truncation / 502).
# Attempt 1 uses MAX_TOKENS; a length-truncation retry doubles the budget.
# Sleeps grow exponentially (2s, 4s, 8s, ...) to respect free-tier rate limits.
OPENROUTER_MAX_ATTEMPTS = _parse_int(
    "OPENROUTER_MAX_ATTEMPTS", os.getenv("OPENROUTER_MAX_ATTEMPTS", "5"), 5
)
OPENROUTER_RETRY_SLEEP_SEC = 2
OPENROUTER_RETRY_SLEEP_MAX_SEC = 30

# Keep request payloads sane: longest image side after downscale.
MAX_IMAGE_SIDE_PX = _parse_int(
    "MAX_IMAGE_SIDE_PX", os.getenv("MAX_IMAGE_SIDE_PX", "1568"), 1568
)

if not OPENROUTER_API_KEY:
    logger.error(
        "OPENROUTER_API_KEY is missing. Set it in .env or environment. "
        "Vision calls to model=%s will fail with 500 until configured.",
        OPENROUTER_MODEL,
    )
else:
    logger.info(
        "OpenRouter configured: base_url=%s model=%s timeout=%ds max_tokens=%d key_present=True",
        OPENROUTER_BASE_URL,
        OPENROUTER_MODEL,
        OPENROUTER_TIMEOUT_SEC,
        OPENROUTER_MAX_TOKENS,
    )

logger.info(
    "server config: host=%s port=%s env=%s site=%s",
    SERVER_URL,
    PORT,
    ENV,
    APP_SITE_URL,
)
