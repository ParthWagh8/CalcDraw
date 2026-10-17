"""Vision analysis via OpenRouter (thinkingmachines/inkling:free).

Flow:
  PIL Image -> PNG data URL -> OpenRouter chat/completions (vision)
  -> raw text -> JSON list parsing -> normalized [{expr, result, assign}]

Every failure branch logs WHAT failed, WHERE, and the relevant context
(model, status code, payload sizes, truncated bodies) without leaking
the API key, so production debugging is straightforward.
"""

import base64
import io
import json
import logging
import re
import time

import requests
from PIL import Image

from constants import (
    APP_SITE_URL,
    APP_TITLE,
    MAX_IMAGE_SIDE_PX,
    OPENROUTER_API_KEY,
    OPENROUTER_BASE_URL,
    OPENROUTER_MAX_ATTEMPTS,
    OPENROUTER_MAX_TOKENS,
    OPENROUTER_MODEL,
    OPENROUTER_RETRY_SLEEP_MAX_SEC,
    OPENROUTER_RETRY_SLEEP_SEC,
    OPENROUTER_TIMEOUT_SEC,
)

logger = logging.getLogger("calc-be.calculator.utils")

_CHAT_COMPLETIONS_PATH = "/chat/completions"
_LOG_BODY_TRUNCATE = 2000


def _truncate(text: str, limit: int = _LOG_BODY_TRUNCATE) -> str:
    if text is None:
        return "<None>"
    if len(text) <= limit:
        return text
    return text[:limit] + f"...<truncated {len(text) - limit} chars>"


def build_prompt(dict_of_vars: dict) -> str:
    """Build the solver prompt. Logs var count/keys for traceability."""
    try:
        dict_of_vars_str = json.dumps(dict_of_vars or {}, ensure_ascii=False)
    except (TypeError, ValueError) as exc:
        logger.error(
            "build_prompt: dict_of_vars is not JSON-serializable (keys=%s): %s. "
            "Falling back to empty dict.",
            list(dict_of_vars.keys()) if isinstance(dict_of_vars, dict) else type(dict_of_vars),
            exc,
        )
        dict_of_vars_str = "{}"

    logger.debug(
        "build_prompt: vars_count=%d vars=%s",
        len(dict_of_vars) if isinstance(dict_of_vars, dict) else -1,
        _truncate(dict_of_vars_str, 500),
    )

    return (
        "You have been given an image with some mathematical expressions, equations, "
        "or graphical problems, and you need to solve them. "
        "Note: Use the PEMDAS rule for solving mathematical expressions. PEMDAS stands "
        "for the Priority Order: Parentheses, Exponents, Multiplication and Division "
        "(from left to right), Addition and Subtraction (from left to right). "
        "For example: Q. 2 + 3 * 4 -> (3 * 4) => 12, 2 + 12 = 14. "
        "Q. 2 + 3 + 5 * 4 - 8 / 2 -> 5 * 4 => 20, 8 / 2 => 4, 2 + 3 => 5, 5 + 20 => 25, 25 - 4 => 21. "
        "YOU CAN HAVE FIVE TYPES OF EQUATIONS/EXPRESSIONS IN THIS IMAGE, AND ONLY ONE CASE "
        "SHALL APPLY EVERY TIME. Following are the cases: "
        "1. Simple mathematical expressions like 2 + 2, 3 * 4, 5 / 6, 7 - 8, etc.: solve and "
        "return [{\"expr\": given expression, \"result\": calculated answer}]. "
        "2. Set of Equations like x^2 + 2x + 1 = 0: solve for the given variable, return a "
        "COMMA SEPARATED LIST OF DICTS, e.g. [{\"expr\": \"x\", \"result\": 2, \"assign\": true}]. "
        "Include as many dicts as there are variables. "
        "3. Assigning values like x = 4: return [{\"expr\": \"x\", \"result\": 4, \"assign\": true}]. "
        "4. Graphical Math word problems (drawings of collisions, trig, Pythagoras, etc.). "
        "PAY CLOSE ATTENTION TO DIFFERENT COLORS. Return "
        "[{\"expr\": given expression, \"result\": calculated answer}]. "
        "5. Abstract concepts in a drawing (love, war reference, quote, etc.): 'expr' is the "
        "explanation, 'result' is the concept. "
        f"User-assigned variables (use these values when the expression references them): {dict_of_vars_str}. "
        "Return ONLY a JSON list of objects with keys 'expr', 'result', and optional boolean 'assign'. "
        "DO NOT USE BACKTICKS OR MARKDOWN FORMATTING. Output raw JSON only."
    )


def image_to_data_url(img: Image.Image) -> str:
    """Encode a PIL image as a PNG data URL, downscaling if oversized.

    Raises:
        ValueError: if img is None or has invalid dimensions.
        RuntimeError: if PNG encoding/base64 fails.
    """
    if img is None:
        logger.error("image_to_data_url: received img=None")
        raise ValueError("img must not be None")

    orig_w, orig_h = getattr(img, "size", (0, 0))
    logger.debug(
        "image_to_data_url: original mode=%s size=%sx%s",
        getattr(img, "mode", "?"),
        orig_w,
        orig_h,
    )
    if not orig_w or not orig_h:
        logger.error(
            "image_to_data_url: invalid image dimensions w=%s h=%s mode=%s",
            orig_w,
            orig_h,
            getattr(img, "mode", "?"),
        )
        raise ValueError(f"invalid image dimensions: {orig_w}x{orig_h}")

    try:
        working = img
        longest = max(orig_w, orig_h)
        if longest > MAX_IMAGE_SIDE_PX:
            scale = MAX_IMAGE_SIDE_PX / float(longest)
            new_w = max(1, int(orig_w * scale))
            new_h = max(1, int(orig_h * scale))
            logger.info(
                "image_to_data_url: downscaling %dx%d -> %dx%d (max_side=%d)",
                orig_w,
                orig_h,
                new_w,
                new_h,
                MAX_IMAGE_SIDE_PX,
            )
            working = img.resize((new_w, new_h), Image.LANCZOS)
        else:
            logger.debug("image_to_data_url: no resize needed (max_side=%d)", MAX_IMAGE_SIDE_PX)

        if working.mode in ("RGBA", "LA", "P"):
            # Composite transparency over black: canvas drawings are on black.
            logger.debug("image_to_data_url: compositing mode=%s over black", working.mode)
            bg = Image.new("RGB", working.size, (0, 0, 0))
            alpha = working.split()[-1] if working.mode in ("RGBA", "LA") else None
            bg.paste(working.convert("RGB"), mask=alpha)
            working = bg
        elif working.mode != "RGB":
            logger.debug("image_to_data_url: converting mode=%s -> RGB", working.mode)
            working = working.convert("RGB")

        buf = io.BytesIO()
        working.save(buf, format="PNG")
        png_bytes = buf.getvalue()
        if not png_bytes:
            logger.error("image_to_data_url: PNG encoder produced 0 bytes")
            raise RuntimeError("PNG encoding produced empty output")

        b64 = base64.b64encode(png_bytes).decode("ascii")
        logger.debug(
            "image_to_data_url: png_bytes=%d b64_len=%d final_size=%sx%s",
            len(png_bytes),
            len(b64),
            working.size[0],
            working.size[1],
        )
        return f"data:image/png;base64,{b64}"
    except (ValueError, RuntimeError):
        raise
    except Exception as exc:
        logger.exception("image_to_data_url: unexpected encode failure: %s", exc)
        raise RuntimeError(f"failed to encode image as data URL: {exc}") from exc


def _strip_code_fences(raw: str) -> str:
    """Remove ```json ... ``` fences if the model added them anyway."""
    if not raw:
        return raw
    stripped = raw.strip()
    fence_re = re.compile(r"^```(?:json)?\s*(.*?)\s*```$", re.DOTALL | re.IGNORECASE)
    m = fence_re.match(stripped)
    if m:
        logger.warning(
            "_strip_code_fences: model returned markdown fences despite prompt; stripping them"
        )
        return m.group(1).strip()
    return stripped


def _extract_json_array(raw: str) -> list:
    """Parse model text into a Python list.

    Strategy: direct json.loads -> bracket-slice json.loads -> error.
    Raises ValueError with logs on every path.
    """
    if raw is None or not str(raw).strip():
        logger.error("_extract_json_array: model returned empty content")
        raise ValueError("model returned empty content")

    text = _strip_code_fences(str(raw).strip())
    logger.debug("_extract_json_array: cleaned_len=%d head=%r", len(text), _truncate(text, 300))

    # 1) Direct parse.
    first_error: json.JSONDecodeError | None = None
    try:
        parsed = json.loads(text)
        if isinstance(parsed, list):
            logger.debug("_extract_json_array: direct json.loads OK, items=%d", len(parsed))
            return parsed
        if isinstance(parsed, dict):
            logger.warning(
                "_extract_json_array: model returned a single dict, wrapping in list. keys=%s",
                list(parsed.keys()),
            )
            return [parsed]
        logger.error(
            "_extract_json_array: top-level JSON is %s, expected list. body=%s",
            type(parsed).__name__,
            _truncate(text, 500),
        )
        raise ValueError(f"expected JSON list, got {type(parsed).__name__}")
    except json.JSONDecodeError as first_err:
        first_error = first_err
        logger.warning(
            "_extract_json_array: direct json.loads failed (%s). Trying bracket extraction.",
            first_err,
        )

    # 2) Extract outermost [...] substring.
    start = text.find("[")
    end = text.rfind("]")
    if start == -1 or end == -1 or end <= start:
        logger.error(
            "_extract_json_array: no JSON array brackets found. raw=%s",
            _truncate(text, 1000),
        )
        raise ValueError("model output did not contain a JSON list") from first_error

    candidate = text[start : end + 1]
    try:
        parsed = json.loads(candidate)
    except json.JSONDecodeError as exc:
        logger.error(
            "_extract_json_array: bracket-extracted JSON still invalid: %s. candidate=%s",
            exc,
            _truncate(candidate, 1000),
        )
        raise ValueError(f"model returned invalid JSON: {exc}") from exc

    if isinstance(parsed, dict):
        logger.warning("_extract_json_array: bracket parse gave single dict; wrapping in list")
        return [parsed]
    if not isinstance(parsed, list):
        logger.error(
            "_extract_json_array: bracket parse gave %s, expected list",
            type(parsed).__name__,
        )
        raise ValueError(f"expected JSON list, got {type(parsed).__name__}")
    logger.debug("_extract_json_array: bracket extraction OK, items=%d", len(parsed))
    return parsed


def _normalize_answers(parsed: list) -> list:
    """Validate/normalize parsed items to [{expr, result, assign}].

    Skips invalid entries with a warning log each (debuggable, non-fatal).
    Raises ValueError if nothing valid remains.
    """
    if not isinstance(parsed, list):
        logger.error("_normalize_answers: expected list, got %s", type(parsed).__name__)
        raise ValueError(f"expected list, got {type(parsed).__name__}")

    if not parsed:
        logger.error(
            "_normalize_answers: model returned an empty list — nothing recognized in the image "
            "(blank/illegible drawing or invisible ink on background?)."
        )
        raise ValueError("model found nothing to solve in the drawing (empty answer list)")

    normalized: list = []
    for idx, item in enumerate(parsed):
        if not isinstance(item, dict):
            logger.warning(
                "_normalize_answers: skipping index %d: not a dict (type=%s, value=%s)",
                idx,
                type(item).__name__,
                _truncate(str(item), 300),
            )
            continue
        if "expr" not in item or "result" not in item:
            logger.warning(
                "_normalize_answers: skipping index %d: missing 'expr'/'result' (keys=%s, item=%s)",
                idx,
                list(item.keys()),
                _truncate(str(item), 300),
            )
            continue
        normalized.append(
            {
                "expr": str(item["expr"]),
                "result": str(item["result"]),
                "assign": bool(item.get("assign", False)),
            }
        )

    if not normalized:
        logger.error(
            "_normalize_answers: 0 valid answers from %d raw items. raw=%s",
            len(parsed),
            _truncate(str(parsed), 1000),
        )
        raise ValueError("model returned no valid answers (missing expr/result)")

    if len(normalized) != len(parsed):
        logger.warning(
            "_normalize_answers: kept %d/%d items (%d skipped as invalid)",
            len(normalized),
            len(parsed),
            len(parsed) - len(normalized),
        )
    else:
        logger.debug("_normalize_answers: all %d items valid", len(normalized))
    return normalized


def call_openrouter_vision(prompt: str, image_data_url: str, max_tokens: int | None = None) -> str:
    """POST a vision request to OpenRouter. Returns raw model text.

    Raises RuntimeError with logged context on: missing key, timeout,
    connection failure, non-2xx status, empty/truncated content, or malformed
    response envelope. Truncation (finish_reason=length) raises a distinct
    message so callers can retry with a bigger budget.
    """
    budget = max_tokens or OPENROUTER_MAX_TOKENS
    if not OPENROUTER_API_KEY:
        logger.error(
            "call_openrouter_vision: OPENROUTER_API_KEY missing. Cannot call model=%s",
            OPENROUTER_MODEL,
        )
        raise RuntimeError(
            "OPENROUTER_API_KEY is not configured. Set it in .env (see .env.example)."
        )
    if not prompt:
        logger.error("call_openrouter_vision: empty prompt")
        raise ValueError("prompt must not be empty")
    if not image_data_url or not image_data_url.startswith("data:image/"):
        logger.error(
            "call_openrouter_vision: invalid image_data_url (len=%d, prefix=%r)",
            len(image_data_url) if image_data_url else 0,
            (image_data_url[:30] if image_data_url else None),
        )
        raise ValueError("image_data_url must be a data:image/... URL")

    url = f"{OPENROUTER_BASE_URL}{_CHAT_COMPLETIONS_PATH}"
    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": APP_SITE_URL,
        "X-Title": APP_TITLE,
    }
    payload = {
        "model": OPENROUTER_MODEL,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {
                        "type": "image_url",
                        "image_url": {"url": image_data_url},
                    },
                ],
            }
        ],
        "max_tokens": budget,
        "temperature": 0.1,
    }

    logger.info(
        "call_openrouter_vision: POST model=%s url=%s prompt_chars=%d img_url_chars=%d timeout=%ds max_tokens=%d",
        OPENROUTER_MODEL,
        url,
        len(prompt),
        len(image_data_url),
        OPENROUTER_TIMEOUT_SEC,
        budget,
    )
    started = time.monotonic()
    try:
        resp = requests.post(url, headers=headers, json=payload, timeout=OPENROUTER_TIMEOUT_SEC)
    except requests.Timeout as exc:
        logger.error(
            "call_openrouter_vision: timeout after %ds calling model=%s: %s",
            OPENROUTER_TIMEOUT_SEC,
            OPENROUTER_MODEL,
            exc,
        )
        raise RuntimeError(
            f"OpenRouter request timed out after {OPENROUTER_TIMEOUT_SEC}s"
        ) from exc
    except requests.ConnectionError as exc:
        logger.error(
            "call_openrouter_vision: connection error to %s (model=%s): %s",
            url,
            OPENROUTER_MODEL,
            exc,
        )
        raise RuntimeError(f"cannot reach OpenRouter at {url}: {exc}") from exc
    except requests.RequestException as exc:
        logger.exception(
            "call_openrouter_vision: request failed (model=%s): %s", OPENROUTER_MODEL, exc
        )
        raise RuntimeError(f"OpenRouter request failed: {exc}") from exc

    elapsed = time.monotonic() - started
    logger.info(
        "call_openrouter_vision: HTTP %d in %.2fs (model=%s)",
        resp.status_code,
        elapsed,
        OPENROUTER_MODEL,
    )

    if resp.status_code == 401:
        logger.error(
            "call_openrouter_vision: 401 Unauthorized. API key invalid/revoked. body=%s",
            _truncate(resp.text, 500),
        )
        raise RuntimeError("OpenRouter rejected the API key (401 Unauthorized)")
    if resp.status_code == 429:
        logger.error(
            "call_openrouter_vision: 429 rate-limited (free model quotas). body=%s. "
            "Retry later or set OPENROUTER_MODEL to a non-free model.",
            _truncate(resp.text, 500),
        )
        raise RuntimeError("OpenRouter rate limit hit (429). Retry later.")
    if resp.status_code == 402:
        logger.error(
            "call_openrouter_vision: 402 payment required. body=%s", _truncate(resp.text, 500)
        )
        raise RuntimeError("OpenRouter payment required (402)")
    if not resp.ok:
        logger.error(
            "call_openrouter_vision: HTTP %d error. body=%s",
            resp.status_code,
            _truncate(resp.text, 1000),
        )
        raise RuntimeError(f"OpenRouter error HTTP {resp.status_code}: {_truncate(resp.text, 300)}")

    try:
        body = resp.json()
    except ValueError as exc:
        logger.error(
            "call_openrouter_vision: response is not JSON (content-type=%s). body=%s. err=%s",
            resp.headers.get("content-type"),
            _truncate(resp.text, 1000),
            exc,
        )
        raise RuntimeError("OpenRouter returned non-JSON response") from exc

    try:
        choices = body.get("choices")
        if not choices:
            logger.error(
                "call_openrouter_vision: 'choices' missing/empty. keys=%s body=%s",
                list(body.keys()) if isinstance(body, dict) else type(body),
                _truncate(str(body), 1000),
            )
            if isinstance(body, dict) and "error" in body:
                logger.error("call_openrouter_vision: provider error object: %s", _truncate(str(body["error"]), 1000))
            raise RuntimeError("OpenRouter response had no choices")
        content = choices[0].get("message", {}).get("content")
        finish_reason = choices[0].get("finish_reason")
        if content is None:
            logger.error(
                "call_openrouter_vision: choice[0].message.content is None "
                "(finish_reason=%s). choice=%s",
                finish_reason,
                _truncate(str(choices[0]), 1000),
            )
            if finish_reason == "length":
                raise RuntimeError(
                    f"OpenRouter output truncated (finish_reason=length) at max_tokens={budget}. "
                    "The model spent its budget reasoning; retry with a larger budget."
                )
            raise RuntimeError(
                f"OpenRouter returned empty message content (finish_reason={finish_reason})"
            )
        if isinstance(content, list):
            # Some providers return content blocks; join text parts.
            logger.debug("call_openrouter_vision: content is block list, joining text parts")
            parts = [
                b.get("text", "") for b in content if isinstance(b, dict) and "text" in b
            ]
            content = "".join(parts)
        content = str(content).strip()
        if not content:
            logger.error(
                "call_openrouter_vision: model content empty after strip (finish_reason=%s)",
                choices[0].get("finish_reason"),
            )
            raise RuntimeError(
                f"OpenRouter returned empty content (finish_reason={choices[0].get('finish_reason')})"
            )
        usage = body.get("usage")
        logger.info(
            "call_openrouter_vision: success content_chars=%d finish_reason=%s usage=%s",
            len(content),
            choices[0].get("finish_reason"),
            usage,
        )
        logger.debug("call_openrouter_vision: raw content=%s", _truncate(content, 1000))
        return content
    except (AttributeError, KeyError, IndexError, TypeError) as exc:
        logger.error(
            "call_openrouter_vision: malformed response envelope: %s. body=%s",
            exc,
            _truncate(str(body), 1000),
        )
        raise RuntimeError(f"malformed OpenRouter response: {exc}") from exc


def _is_retryable(msg: str) -> bool:
    """Transient model failures worth one more attempt (never auth/rate/timeout)."""
    m = msg.lower()
    if any(s in m for s in ("api key", "401", "429", "402", "timed out", "cannot reach", "not configured")):
        return False
    return any(
        s in m
        for s in (
            "finish_reason=length",
            "truncated",
            "empty message content",
            "empty content",
            "no choices",
            "non-json",
            "malformed",
            "invalid json",
            "no valid answers",
            "did not contain a json list",
            "http 502",
            "http 500",
            "http 503",
        )
    )


def analyze_image(img: Image.Image, dict_of_vars: dict) -> list:
    """Analyze a drawing image and return [{expr, result, assign}].

    Retries transient model failures (up to OPENROUTER_MAX_ATTEMPTS); a
    length-truncation retry doubles the token budget. Non-retryable failures
    (auth, rate limit, timeout, bad input) raise immediately.

    Raises:
        ValueError: bad input image or vars type.
        RuntimeError: OpenRouter call failed or model output unparseable.
    All failures are logged with context before raising.
    """
    start = time.monotonic()
    logger.info(
        "analyze_image: start model=%s vars_count=%d img=%s attempts=%d",
        OPENROUTER_MODEL,
        len(dict_of_vars) if isinstance(dict_of_vars, dict) else -1,
        getattr(img, "size", "?"),
        max(1, OPENROUTER_MAX_ATTEMPTS),
    )

    if not isinstance(dict_of_vars, dict):
        logger.error(
            "analyze_image: dict_of_vars must be dict, got %s",
            type(dict_of_vars).__name__,
        )
        raise ValueError(f"dict_of_vars must be dict, got {type(dict_of_vars).__name__}")

    try:
        prompt = build_prompt(dict_of_vars)
        data_url = image_to_data_url(img)
    except (ValueError, RuntimeError):
        logger.error(
            "analyze_image: input preparation failed after %.2fs (model=%s)",
            time.monotonic() - start,
            OPENROUTER_MODEL,
        )
        raise

    attempts = max(1, OPENROUTER_MAX_ATTEMPTS)
    budget = OPENROUTER_MAX_TOKENS
    last_exc: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            raw = call_openrouter_vision(prompt, data_url, max_tokens=budget)
            parsed = _extract_json_array(raw)
            answers = _normalize_answers(parsed)
            logger.info(
                "analyze_image: done in %.2fs answers=%d model=%s attempt=%d/%d budget=%d",
                time.monotonic() - start,
                len(answers),
                OPENROUTER_MODEL,
                attempt,
                attempts,
                budget,
            )
            return answers
        except ValueError as exc:
            last_exc = exc
            logger.warning(
                "analyze_image: attempt %d/%d unparseable output: %s",
                attempt,
                attempts,
                exc,
            )
        except RuntimeError as exc:
            last_exc = exc
            msg = str(exc)
            if "finish_reason=length" in msg or "truncated" in msg:
                budget = min(budget * 2, 8192)
                logger.warning(
                    "analyze_image: attempt %d/%d truncated output — retrying with budget=%d",
                    attempt,
                    attempts,
                    budget,
                )
            elif _is_retryable(msg):
                logger.warning(
                    "analyze_image: attempt %d/%d transient failure, retrying same budget=%d: %s",
                    attempt,
                    attempts,
                    budget,
                    exc,
                )
            else:
                logger.error(
                    "analyze_image: non-retryable failure after %.2fs (model=%s): %s",
                    time.monotonic() - start,
                    OPENROUTER_MODEL,
                    exc,
                )
                raise
        if attempt < attempts:
            sleep_s = min(OPENROUTER_RETRY_SLEEP_MAX_SEC, OPENROUTER_RETRY_SLEEP_SEC * (2 ** (attempt - 1)))
            logger.info(
                "analyze_image: sleeping %ds before attempt %d (free-tier rate limits)",
                sleep_s,
                attempt + 1,
            )
            time.sleep(sleep_s)

    logger.error(
        "analyze_image: all %d attempts failed after %.2fs (model=%s): %s",
        attempts,
        time.monotonic() - start,
        OPENROUTER_MODEL,
        last_exc,
    )
    raise last_exc if last_exc else RuntimeError("analyze_image failed without an error")
