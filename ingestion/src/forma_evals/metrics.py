"""Retrieval metrics (CLAUDE.md required set: MRR, Context Recall, Context
Precision, NDCG@K).

Golden-row semantics: each question is generated from ONE source chunk, so the
`relevant` set holds a single ground truth plus its aliases — a table summary
and its parent table are the same evidence (the retriever intentionally swaps
summaries for parents). Any alias appearing in the results is a hit for that
single truth.
"""

from __future__ import annotations

import math


def _first_hit_rank(retrieved: list[str], relevant: set[str]) -> int | None:
    for i, cid in enumerate(retrieved, start=1):
        if cid in relevant:
            return i
    return None


def reciprocal_rank(retrieved: list[str], relevant: set[str]) -> float:
    rank = _first_hit_rank(retrieved, relevant)
    return 1.0 / rank if rank else 0.0


def recall_at_k(retrieved: list[str], relevant: set[str], k: int) -> float:
    """Single-truth recall: did the evidence make it into the top-k at all."""
    rank = _first_hit_rank(retrieved[:k], relevant)
    return 1.0 if rank else 0.0


def precision_at_k(retrieved: list[str], relevant: set[str], k: int) -> float:
    """Share of the top-k that is relevant. With one truth (+aliases) the
    ceiling is 1/k — useful for comparing configs, not as an absolute."""
    top = retrieved[:k]
    if not top:
        return 0.0
    # count alias-group once: any hit contributes exactly one relevant slot
    return (1.0 if set(top) & relevant else 0.0) / len(top)


def ndcg_at_k(retrieved: list[str], relevant: set[str], k: int) -> float:
    """Single-truth NDCG@k = 1/log2(rank+1); ideal = hit at rank 1."""
    rank = _first_hit_rank(retrieved[:k], relevant)
    return 1.0 / math.log2(rank + 1) if rank else 0.0


def score_row(retrieved: list[str], relevant: set[str], k: int) -> dict:
    return {
        "mrr": reciprocal_rank(retrieved, relevant),
        "recall": recall_at_k(retrieved, relevant, k),
        "precision": precision_at_k(retrieved, relevant, k),
        "ndcg": ndcg_at_k(retrieved, relevant, k),
    }


def aggregate(rows: list[dict]) -> dict:
    n = len(rows)
    if n == 0:
        return {"n": 0}
    keys = ["mrr", "recall", "precision", "ndcg"]
    return {k: round(sum(r[k] for r in rows) / n, 4) for k in keys} | {"n": n}
