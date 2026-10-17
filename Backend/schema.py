import logging
from typing import Any

from pydantic import BaseModel, field_validator

logger = logging.getLogger("calc-be.schema")


class ImageData(BaseModel):
    image: str
    dict_of_vars: dict[str, Any] = {}

    @field_validator("image")
    @classmethod
    def image_must_be_data_url(cls, v: str) -> str:
        if not isinstance(v, str) or not v:
            logger.error("ImageData validation: image missing or not a string")
            raise ValueError("image must be a non-empty data URL string")
        if not v.startswith("data:image/"):
            logger.error(
                "ImageData validation: image does not start with data:image/ (head=%r)",
                v[:40],
            )
            raise ValueError("image must start with data:image/")
        if "," not in v:
            logger.error("ImageData validation: image data URL has no comma separator")
            raise ValueError("image must be a data URL like data:image/png;base64,...")
        # Cap absurd payloads early (roughly ~15MB base64) to avoid OOM.
        if len(v) > 20_000_000:
            logger.error(
                "ImageData validation: image payload too large (chars=%d)", len(v)
            )
            raise ValueError("image payload too large")
        return v

    @field_validator("dict_of_vars", mode="before")
    @classmethod
    def vars_must_be_dict(cls, v: Any) -> dict:
        if v is None:
            logger.warning("ImageData validation: dict_of_vars=None, defaulting to {}")
            return {}
        if not isinstance(v, dict):
            logger.error(
                "ImageData validation: dict_of_vars must be dict, got %s",
                type(v).__name__,
            )
            raise ValueError("dict_of_vars must be a dict")
        return v
