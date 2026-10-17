"""POST /calculate — decode canvas image, run vision analysis, return answers."""

import base64
import binascii
import io
import logging
import time

from fastapi import APIRouter, HTTPException
from PIL import Image, UnidentifiedImageError

from apps.calculator.utils import analyze_image
from schema import ImageData

logger = logging.getLogger("calc-be.calculator.route")

router = APIRouter()


def _decode_data_url(data_url: str) -> bytes:
    """Decode a data:image/...;base64,... URL to raw bytes.

    Raises HTTPException(400) with a logged reason on any malformed input.
    """
    if not data_url or not isinstance(data_url, str):
        logger.error(
            "_decode_data_url: image payload missing or not a string (type=%s)",
            type(data_url).__name__,
        )
        raise HTTPException(status_code=400, detail="image must be a data URL string")

    if "," not in data_url:
        logger.error(
            "_decode_data_url: no comma separator in payload (len=%d, head=%r)",
            len(data_url),
            data_url[:60],
        )
        raise HTTPException(
            status_code=400,
            detail="image must be a data URL like data:image/png;base64,...",
        )

    header, _, b64_part = data_url.partition(",")
    if "base64" not in header.lower():
        logger.error("_decode_data_url: header missing base64 marker: %r", header[:80])
        raise HTTPException(status_code=400, detail="image data URL must be base64-encoded")
    if not b64_part:
        logger.error("_decode_data_url: base64 body empty (header=%r)", header[:80])
        raise HTTPException(status_code=400, detail="image base64 body is empty")

    try:
        raw = base64.b64decode(b64_part, validate=True)
    except (binascii.Error, ValueError) as exc:
        logger.error(
            "_decode_data_url: base64 decode failed (b64_len=%d): %s",
            len(b64_part),
            exc,
        )
        raise HTTPException(status_code=400, detail=f"image base64 is invalid: {exc}") from exc

    if not raw:
        logger.error("_decode_data_url: decoded 0 bytes")
        raise HTTPException(status_code=400, detail="image decoded to 0 bytes")

    logger.debug("_decode_data_url: decoded %d bytes (header=%s)", len(raw), header[:60])
    return raw


def _bytes_to_image(raw: bytes) -> Image.Image:
    """Open raw bytes as PIL image. Raises HTTPException(400) on failure."""
    try:
        img = Image.open(io.BytesIO(raw))
        img.load()  # force decode now so truncated files fail here, not later
    except UnidentifiedImageError as exc:
        logger.error(
            "_bytes_to_image: PIL cannot identify image (bytes=%d): %s", len(raw), exc
        )
        raise HTTPException(
            status_code=400, detail="image bytes are not a recognizable PNG/JPEG/WEBP"
        ) from exc
    except (OSError, ValueError) as exc:
        logger.error(
            "_bytes_to_image: PIL failed to decode image (bytes=%d): %s", len(raw), exc
        )
        raise HTTPException(status_code=400, detail=f"cannot decode image: {exc}") from exc
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception("_bytes_to_image: unexpected PIL failure: %s", exc)
        raise HTTPException(status_code=400, detail="cannot decode image") from exc

    logger.debug(
        "_bytes_to_image: opened format=%s mode=%s size=%s",
        getattr(img, "format", "?"),
        img.mode,
        img.size,
    )
    return img


@router.post("")
async def run(data: ImageData):
    started = time.monotonic()
    payload_len = len(data.image) if data.image else 0
    logger.info(
        "POST /calculate: received payload_chars=%d vars_count=%d vars_keys=%s",
        payload_len,
        len(data.dict_of_vars) if isinstance(data.dict_of_vars, dict) else -1,
        list(data.dict_of_vars.keys())[:20] if isinstance(data.dict_of_vars, dict) else "?",
    )

    raw_bytes = _decode_data_url(data.image)
    image = _bytes_to_image(raw_bytes)

    try:
        answers = analyze_image(image, dict_of_vars=data.dict_of_vars)
    except ValueError as exc:
        # Bad model output or bad input vars: client-visible but server-logged.
        logger.error("POST /calculate: analysis input/parse error: %s", exc)
        raise HTTPException(status_code=502, detail=f"vision model returned unusable output: {exc}") from exc
    except RuntimeError as exc:
        # OpenRouter/network/config failure.
        logger.error("POST /calculate: vision backend failure: %s", exc)
        msg = str(exc)
        status = 500
        if "timed out" in msg.lower():
            status = 504
        elif "rate limit" in msg.lower() or "429" in msg:
            status = 429
        elif "truncat" in msg.lower() or "output tokens" in msg.lower():
            status = 502
        elif "http 502" in msg.lower() or "http 503" in msg.lower():
            status = 502
        elif "api key" in msg.lower() or "401" in msg:
            status = 500
        raise HTTPException(status_code=status, detail=msg) from exc
    except HTTPException:
        raise
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception("POST /calculate: unexpected failure: %s", exc)
        raise HTTPException(status_code=500, detail="internal calculation error") from exc

    if not answers:
        # analyze_image guarantees non-empty on success, so this is unreachable
        # unless behavior changes; log loudly rather than returning cryptic [].
        logger.error("POST /calculate: analyze_image returned empty list without raising")
        raise HTTPException(status_code=502, detail="vision model returned no answers")

    elapsed = time.monotonic() - started
    logger.info(
        "POST /calculate: success in %.2fs answers=%d first_expr=%r",
        elapsed,
        len(answers),
        answers[0].get("expr") if isinstance(answers[0], dict) else "?",
    )
    return {"message": "Image processed", "data": answers, "status": "success"}
