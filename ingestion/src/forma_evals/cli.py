"""Evaluation CLI. Entry point for `python scripts/evaluate.py`.

Every run writes a JSON result to evals/results/ (committed) so parameter
choices are justified by metrics, not vibes.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import logging
import sys
from pathlib import Path

import httpx
from dotenv import load_dotenv

log = logging.getLogger("forma.evals")

REPO_ROOT = Path(__file__).resolve().parents[3]
GOLDEN_DIR = REPO_ROOT / "evals" / "golden"
RESULTS_DIR = REPO_ROOT / "evals" / "results"


def main() -> None:
    parser = argparse.ArgumentParser(description="Forma RAG evaluation")
    parser.add_argument("--dataset", default="licensing-golden", choices=["licensing-golden"],
                        help="FinTable-X has no public release (ADR-6); licensing-golden is the default")
    parser.add_argument("--env", default="demo", choices=["demo", "production"])
    parser.add_argument("--api-url")
    parser.add_argument("--token")
    parser.add_argument("--generate", action="store_true", help="(Re)generate the golden QA dataset")
    parser.add_argument("--per-doc", type=int, default=12, help="questions per document when generating")
    parser.add_argument("--retrieval", action="store_true", help="Run retrieval sweep (stage 1: modes + rerank)")
    parser.add_argument("--stage2", metavar="BASE_JSON",
                        help='Stage-2 sweep (rrfK, decay) around a base config, e.g. \'{"mode":"hybrid","rerank":true}\'')
    parser.add_argument("--generation", action="store_true", help="Run generation eval (DeepEval)")
    parser.add_argument("--sample", type=int, default=12, help="questions for generation eval")
    parser.add_argument("--judge", default="claude-haiku-4-5")
    parser.add_argument("--k", type=int, default=5)
    parser.add_argument("--label", default="", help="tag for the results file")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    load_dotenv(REPO_ROOT / ".env")

    from forma_ingest.uploader import resolve_target
    api_url, token = resolve_target(args.env, args.api_url, args.token, REPO_ROOT)
    log.info("target: %s (env=%s)\n", api_url, args.env)

    golden_path = GOLDEN_DIR / "licensing_golden.jsonl"
    from .dataset import generate_golden, load_golden

    if args.generate:
        http = httpx.Client(base_url=api_url, timeout=60, headers={"authorization": f"Bearer {token}"})
        chunks = http.get("/api/admin/chunks").raise_for_status().json()["chunks"]
        if not chunks:
            sys.exit("no chunks ingested yet — run scripts/ingest.py first")
        generate_golden(chunks, golden_path, per_doc=args.per_doc)

    if not (args.retrieval or args.stage2 or args.generation):
        if args.generate:
            return
        parser.error("nothing to do: pass --generate, --retrieval, --stage2 or --generation")

    if not golden_path.exists():
        sys.exit(f"golden dataset missing ({golden_path}) — run with --generate first")
    golden = load_golden(golden_path)
    log.info("golden dataset: %d rows (%d answerable)\n",
             len(golden), sum(1 for g in golden if g["relevant_ids"]))

    from .runner import default_grid, run_generation_eval, run_retrieval_sweep, stage2_grid

    report: dict = {
        "dataset": args.dataset,
        "env": args.env,
        "k": args.k,
        "timestamp": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
    }

    if args.retrieval:
        log.info("── retrieval sweep (stage 1) ──")
        report["retrieval"] = run_retrieval_sweep(api_url, token, golden, default_grid(), k=args.k)

    if args.stage2:
        base = json.loads(args.stage2)
        log.info("── retrieval sweep (stage 2, base=%s) ──", base)
        report["retrieval_stage2"] = run_retrieval_sweep(api_url, token, golden, stage2_grid(base), k=args.k)

    if args.generation:
        log.info("── generation eval (judge=%s) ──", args.judge)
        report["generation"] = run_generation_eval(
            api_url, token, golden, sample=args.sample, judge_model=args.judge
        )

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    label = f"-{args.label}" if args.label else ""
    out = RESULTS_DIR / f"{stamp}{label}.json"
    out.write_text(json.dumps(report, indent=2) + "\n")
    log.info("\n✔ results written to %s", out.relative_to(REPO_ROOT))


if __name__ == "__main__":
    sys.exit(main())
