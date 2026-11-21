"""Structured logging setup for AutoMotion Comic Studio backend."""

from __future__ import annotations

import logging
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path


def setup_logging(logs_dir: Path, level: int = logging.INFO) -> logging.Logger:
    """Configure rotating file + console logging."""
    logs_dir.mkdir(parents=True, exist_ok=True)
    log_file = logs_dir / "backend.log"

    formatter = logging.Formatter(
        fmt="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    root_logger = logging.getLogger("amcs")
    root_logger.setLevel(level)
    root_logger.propagate = False

    # Avoid duplicate handlers on reload/test
    if root_logger.handlers:
        root_logger.handlers.clear()

    file_handler = RotatingFileHandler(
        log_file,
        maxBytes=5 * 1024 * 1024,
        backupCount=5,
        encoding="utf-8",
    )
    file_handler.setFormatter(formatter)
    root_logger.addHandler(file_handler)

    stream_handler = logging.StreamHandler(sys.stderr)
    stream_handler.setFormatter(formatter)
    root_logger.addHandler(stream_handler)

    return root_logger


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(f"amcs.{name}")
