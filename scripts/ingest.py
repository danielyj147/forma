#!/usr/bin/env python3
"""Shim: re-execs the ingestion CLI under uv with Python 3.12 (Docling does
not support 3.14). Usage per CLAUDE.md:

    python scripts/ingest.py --file <path-or-url> [--state CA --license-type money-transmitter ...]
"""
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

if not shutil.which("uv"):
    sys.exit("uv is required (https://docs.astral.sh/uv/) — install with: brew install uv")

os.execvp(
    "uv",
    [
        "uv", "run",
        "--project", os.path.join(ROOT, "ingestion"),
        "python", "-m", "forma_ingest.cli",
        *sys.argv[1:],
    ],
)
