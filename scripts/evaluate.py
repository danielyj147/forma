#!/usr/bin/env python3
"""Shim: re-execs the eval CLI under uv (with the `evals` extra: DeepEval).

    python scripts/evaluate.py --dataset licensing-golden --retrieval
    python scripts/evaluate.py --generate
    python scripts/evaluate.py --generation --judge claude-haiku-4-5
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
        "--extra", "evals",
        "python", "-m", "forma_evals.cli",
        *sys.argv[1:],
    ],
)
