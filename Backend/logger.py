"""Central logging configuration for calc-be.

Import and call configure_logging() once at startup (main.py).
Use get_logger(__name__) in every other module so all error paths
emit a consistent, debuggable record.
"""

import logging
import os
import sys

_configured = False


def configure_logging() -> logging.Logger:
    """Configure root logging once. Safe to call multiple times."""
    global _configured
    level_name = os.getenv("LOG_LEVEL", "INFO").upper()
    level = getattr(logging, level_name, logging.INFO)

    root = logging.getLogger()
    if not _configured:
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(
            logging.Formatter(
                fmt="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
                datefmt="%Y-%m-%d %H:%M:%S",
            )
        )
        root.handlers.clear()
        root.addHandler(handler)
        root.setLevel(level)
        _configured = True
    else:
        root.setLevel(level)

    logger = logging.getLogger("calc-be")
    logger.debug(
        "logging configured: level=%s handlers=%d",
        logging.getLevelName(root.level),
        len(root.handlers),
    )
    return logger


def get_logger(name: str) -> logging.Logger:
    """Return a module logger. Falls back to basic config if startup missed."""
    if not _configured:
        logging.basicConfig(
            level=logging.INFO,
            format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
            stream=sys.stdout,
        )
    return logging.getLogger(name)
