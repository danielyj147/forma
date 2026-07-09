# Eval results

Dataset: `licensing-golden`, regenerated per corpus revision. K=5. See ADR-6.

## Current — 7-document corpus + contextual table summaries (2026-07-09)

68 golden rows (65 answerable) over 7 documents incl. the famously-hard IRS
Form 1023, NY BitLicense, and CMS-855A. Chunks carry **contextual table
summaries** (Anthropic contextual-retrieval technique: a situating line
derived from reading-order context, indexed on both retrieval legs) plus
state-abbreviation query expansion.

| config | MRR | Recall@5 | Precision@5 | NDCG@5 |
|---|---|---|---|---|
| bm25-only | 0.500 | 0.631 | 0.150 | 0.533 |
| dense-only | 0.641 | 0.831 | 0.166 | 0.688 |
| hybrid rrf60 | 0.731 | 0.877 | 0.175 | 0.768 |
| **hybrid rrf60 + rerank** | **0.891** | **0.954** | **0.209** | **0.907** |
| bm25 + rerank | 0.872 | 0.923 | 0.204 | 0.885 |
| dense + rerank | 0.888 | 0.954 | 0.191 | 0.904 |

vs the pre-contextual 4-doc run (below): +0.138 MRR, +0.076 recall, +0.122
NDCG on a *harder* corpus. The motivating failure — "in NY" questions never
retrieving the survey's New York continuation tables (which don't repeat the
state name) — is fixed and spot-verified live.

Generation (n=12 + 3 unanswerable, judge=claude-haiku-4-5): Faithfulness
**0.875**, Answer Relevancy **0.866**, refusal pass-rate **3/3**.
Runs: `20260709-141507-stage1-7docs.json`, `20260709-141812-generation-7docs.json`.

## Archive — initial 4-document corpus (2026-07-09, pre-contextual)

## Retrieval — stage 1: modes × rerank (2026-07-09, n=41)

| config | MRR | Recall@5 | Precision@5 | NDCG@5 |
|---|---|---|---|---|
| bm25-only | 0.482 | 0.707 | 0.144 | 0.539 |
| dense-only | 0.482 | 0.658 | 0.132 | 0.526 |
| hybrid rrf60 | 0.618 | 0.878 | 0.176 | 0.683 |
| **hybrid rrf60 + rerank** | **0.753** | **0.878** | **0.177** | **0.785** |
| bm25 + rerank | 0.720 | 0.829 | 0.167 | 0.748 |
| dense + rerank | 0.753 | 0.878 | 0.176 | 0.785 |

Conclusions:
- **Hybrid fusion beats both single legs** on every metric (+0.17 recall vs
  dense, +0.14 MRR vs either) — the BM25 leg catches exact codes/fee figures,
  the dense leg catches paraphrases; RRF needs no score normalization.
- **Cross-encoder reranking is the single largest quality lever**: +0.135 MRR,
  +0.102 NDCG on top of hybrid. Cost: ~1s per query of Workers AI (free tier).
- dense+rerank ties hybrid+rerank *on this golden set*, but hybrid's
  pre-rerank candidate recall is strictly higher (0.878 vs 0.658 feeds the
  reranker more true positives on harder queries) and protects exact-token
  regulatory queries — hybrid stays the default.

## Retrieval — stage 2: rrfK & time-decay (2026-07-09)

rrfK ∈ {20, 60, 120} and decayLambda ∈ {0, 0.1, 0.3} produce **identical
metrics** under reranking on this corpus: the reranker re-scores the same
candidate pool, and no golden question has same-topic sources of different
ages for decay to separate. Decisions:
- `rrfK = 60` (literature standard; insensitive here)
- `decayLambda = 0.1` — retained at zero measured retrieval cost to satisfy
  the freshness convention; **re-sweep when the corpus gains same-topic
  documents of different ages** (the honest current dataset cannot measure it)

## Generation (2026-07-09, n=12 + 3 unanswerable, judge=claude-haiku-4-5)

| metric | score |
|---|---|
| Faithfulness (DeepEval) | 0.854 |
| Answer Relevancy (DeepEval) | 0.896 |
| "I do not know" pass rate on unanswerable | **3/3 = 1.00** |

Raw runs: `20260709-103655-stage1.json`, `20260709-104240-stage2.json`,
`20260709-104731-generation.json`. Reproduce with the commands in the repo
README; the shipped defaults live in `apps/api/src/retrieval/config.ts`.

Known limitations: single-truth golden rows make Precision@5 ceiling 0.2;
question style is LLM-generated (natural but not adversarial paraphrases);
judge is Haiku (rerun with `--judge claude-opus-4-8` for a stricter pass).
