"""Retrieval sweep + generation eval against a deployed environment.

Retrieval: hits POST /api/search with per-request config overrides and debug
ranks; scores MRR / Context Recall / Context Precision / NDCG@K per config.

Generation: drives POST /api/chat (SSE) and judges Faithfulness + Answer
Relevancy with DeepEval using an Anthropic judge, plus an exact-behavior check
on unanswerable questions (the zero-hallucination contract).
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field

import httpx

from .metrics import aggregate, score_row

log = logging.getLogger("forma.evals")


@dataclass
class SweepConfig:
    label: str
    overrides: dict  # Partial<RetrievalConfig>
    rows: list[dict] = field(default_factory=list)

    def result(self) -> dict:
        return {"label": self.label, "overrides": self.overrides, **aggregate(self.rows)}


def default_grid(quick: bool = False) -> list[SweepConfig]:
    """Stage 1 compares retrieval modes and reranking; stage 2 (run after
    picking a winner) sweeps rrfK and decay — see cli.py --stage2."""
    grid = [
        SweepConfig("bm25-only", {"mode": "bm25", "rerank": False}),
        SweepConfig("dense-only", {"mode": "dense", "rerank": False}),
        SweepConfig("hybrid-rrf60", {"mode": "hybrid", "rrfK": 60, "rerank": False}),
        SweepConfig("hybrid-rrf60+rerank", {"mode": "hybrid", "rrfK": 60, "rerank": True}),
    ]
    if not quick:
        grid += [
            SweepConfig("bm25+rerank", {"mode": "bm25", "rerank": True}),
            SweepConfig("dense+rerank", {"mode": "dense", "rerank": True}),
        ]
    return grid


def stage2_grid(base: dict) -> list[SweepConfig]:
    out = []
    for rrf_k in (20, 60, 120):
        out.append(SweepConfig(f"rrfK={rrf_k}", {**base, "rrfK": rrf_k}))
    for lam in (0.0, 0.1, 0.3):
        out.append(SweepConfig(f"decayλ={lam}", {**base, "decayLambda": lam}))
    return out


def run_retrieval_sweep(
    api_url: str,
    token: str,
    golden: list[dict],
    grid: list[SweepConfig],
    k: int = 5,
) -> list[dict]:
    http = httpx.Client(
        base_url=api_url,
        timeout=60.0,
        headers={"authorization": f"Bearer {token}"},  # rate-limit exempt
    )
    answerable = [g for g in golden if g["relevant_ids"]]

    for cfg in grid:
        t0 = time.time()
        for row in answerable:
            r = http.post(
                "/api/search",
                json={"query": row["question"], "config": {**cfg.overrides, "finalK": k}},
            )
            r.raise_for_status()
            retrieved = [res["chunkId"] for res in r.json()["results"]]
            cfg.rows.append(score_row(retrieved, set(row["relevant_ids"]), k))
        agg = cfg.result()
        log.info(
            "%-22s MRR %.3f  Recall@%d %.3f  Prec@%d %.3f  NDCG@%d %.3f  (%.0fs)",
            cfg.label, agg["mrr"], k, agg["recall"], k, agg["precision"], k, agg["ndcg"],
            time.time() - t0,
        )
    return [cfg.result() for cfg in grid]


# ---------------------------------------------------------------------------
# Generation eval
# ---------------------------------------------------------------------------


def chat_once(http: httpx.Client, question: str, force_model: str | None = None) -> dict:
    """Drive the SSE chat endpoint; returns {answer, contexts, model}."""
    payload = {"messages": [{"role": "user", "content": question}]}
    if force_model:
        payload["forceModel"] = force_model
    answer, contexts, model = [], [], None
    with http.stream("POST", "/api/chat", json=payload) as r:
        r.raise_for_status()
        buffer = ""
        for text in r.iter_text():
            buffer += text
            while "\n\n" in buffer:
                event_raw, buffer = buffer.split("\n\n", 1)
                for line in event_raw.splitlines():
                    if not line.startswith("data:"):
                        continue
                    ev = json.loads(line[5:].strip())
                    if ev["type"] == "delta":
                        answer.append(ev["text"])
                    elif ev["type"] == "sources":
                        contexts = [c.get("content") or c["snippet"] for c in ev["citations"]]
                    elif ev["type"] == "routing":
                        model = ev.get("model")
                    elif ev["type"] == "error":
                        raise RuntimeError(f"chat error: {ev['message']}")
    return {"answer": "".join(answer), "contexts": contexts, "model": model}


def run_generation_eval(
    api_url: str,
    token: str,
    golden: list[dict],
    sample: int = 12,
    judge_model: str = "claude-haiku-4-5",
) -> dict:
    from .judge import AnthropicJudge  # deepeval import deferred (heavy)
    from deepeval.metrics import AnswerRelevancyMetric, FaithfulnessMetric
    from deepeval.test_case import LLMTestCase

    http = httpx.Client(base_url=api_url, timeout=180.0, headers={"authorization": f"Bearer {token}"})
    judge = AnthropicJudge(judge_model)
    faithfulness = FaithfulnessMetric(model=judge, include_reason=False, async_mode=False)
    relevancy = AnswerRelevancyMetric(model=judge, include_reason=False, async_mode=False)

    answerable = [g for g in golden if g["kind"] != "unanswerable"][:sample]
    unanswerable = [g for g in golden if g["kind"] == "unanswerable"]

    faith_scores, rel_scores, per_q = [], [], []
    for row in answerable:
        out = chat_once(http, row["question"])
        if not out["contexts"]:
            log.warning("no contexts for %r — counting faithfulness as 0", row["question"][:60])
            faith_scores.append(0.0)
            rel_scores.append(0.0)
            per_q.append({"id": row["id"], "faithfulness": 0.0, "relevancy": 0.0, "model": out["model"]})
            continue
        tc = LLMTestCase(
            input=row["question"],
            actual_output=out["answer"],
            retrieval_context=out["contexts"],
        )
        faithfulness.measure(tc)
        f = faithfulness.score or 0.0
        relevancy.measure(tc)
        rel = relevancy.score or 0.0
        faith_scores.append(f)
        rel_scores.append(rel)
        per_q.append({"id": row["id"], "faithfulness": round(f, 3), "relevancy": round(rel, 3), "model": out["model"]})
        log.info("  %-70s F=%.2f R=%.2f", row["question"][:70], f, rel)

    idk_pass = 0
    for row in unanswerable:
        out = chat_once(http, row["question"])
        ok = "i do not know" in out["answer"].lower()
        idk_pass += ok
        log.info("  [unanswerable] %-55s %s", row["question"][:55], "✔ refused" if ok else "✘ ANSWERED")

    n = max(1, len(faith_scores))
    return {
        "faithfulness": round(sum(faith_scores) / n, 4),
        "answer_relevancy": round(sum(rel_scores) / n, 4),
        "idk_pass_rate": round(idk_pass / max(1, len(unanswerable)), 4),
        "judge": judge_model,
        "n": len(faith_scores),
        "per_question": per_q,
    }
