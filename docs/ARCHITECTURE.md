# Forma — Architecture

**Licensing as a Service.** Regulatory licensing applications (state/federal PDFs) are
parsed into structured, Ashby-style web forms, backed by a zero-hallucination RAG chat
that answers questions grounded in the source documents with clickable, coordinate-level
citations.

```
                        ┌─────────────────────────────────────────────┐
  OFFLINE (local/CI)    │  DEPLOYED (Cloudflare, $0 free tier)        │
┌─────────────────────┐ │                                             │
│ ingestion/ (Python) │ │  ┌────────────── Worker (Hono) ───────────┐ │
│  Docling parse      │ │  │ /api/chat   SSE, router → RAG → Claude │ │
│  table merge        │ │  │ /api/search eval/debug retrieval       │ │
│  HybridChunker      │─┼─▶│ /api/admin/ingest  (token-protected)   │ │
│  parent-child       │ │  │ static assets → React SPA              │ │
│  Haiku form schema  │ │  └───┬─────────┬─────────┬─────────┬──────┘ │
└─────────┬───────────┘ │      │         │         │         │        │
          │             │  Vectorize    D1      Workers AI   R2       │
   Anthropic API        │  (dense)   (SQL+FTS5  (bge-m3,   (PDFs)     │
   (Haiku 4.5 /         │             BM25)     reranker)             │
    Opus 4.8)           │                                             │
                        └─────────────────────────────────────────────┘
```

## Decision records

### ADR-1: All-Cloudflare deployment (Workers + Vectorize + D1 + R2 + Workers AI)

**Context.** Requirements: ~$0 hosting, commercial use allowed, separate demo/prod
environments, custom domains on a Cloudflare-managed zone, public repo, and Docling
is too compute-heavy to run in a serverless request path.

**Decision.** Everything deployable lives on the Cloudflare free tier, managed by a
single `wrangler.jsonc` with `demo` and `production` environments (separate D1
databases, Vectorize indexes, R2 buckets, KV namespaces, hostnames). The only metered
cost is the Anthropic API.

**Alternatives rejected.**
- *Vercel Hobby*: prohibits commercial use; this is a commercial SaaS demo.
- *Supabase (pgvector + FTS)*: free tier allows 2 active projects and both slots are
  occupied by unrelated projects; a paid project violates the $0 goal, and sharing a
  project with unrelated schemas couples environments we want isolated.
- *AWS (Lambda + OpenSearch/pgvector)*: OpenSearch has no meaningful free tier;
  RDS free tier is 12-months-only and single-instance. More moving parts, real cost.

**Docling placement.** Docling (PyTorch-based layout/table models) runs **offline** as a
local/CI batch step — never in the serving path. The deployed system only does
retrieval + generation, so the compute-heavy part costs $0 in production and ingestion
latency never affects users. `scripts/ingest.py` pushes results to a deployed
environment through a token-protected admin API, so contributors don't need Cloudflare
credentials to ingest.

### ADR-2: Hybrid search = Vectorize (dense) + D1 FTS5 (BM25) fused with RRF in the Worker

**Context.** The original convention called for a single DB with native hybrid search.
No such DB fits inside the $0/all-Cloudflare envelope.

**Decision.** Dense retrieval from Vectorize (bge-m3, 1024-dim, cosine) and lexical
BM25 from SQLite FTS5 in D1 (exact regulatory codes, form numbers like "MU1",
"NMLS ID"), each returning top-50, fused with Reciprocal Rank Fusion in the Worker.
RRF is a rank-based algorithm — it is identical math whether it runs inside a DB engine
or in 20 lines of application code, and having it in code makes fusion parameters
(k, weights) sweepable by the eval harness.

**Consequences.** Two stores must stay consistent; the admin ingest endpoint writes
both transactionally-enough (D1 first, then Vectorize upsert keyed by chunk id;
re-ingest is idempotent by document id).

**ORM note.** Prisma was evaluated and rejected: the data layer's load-bearing
pieces — the FTS5 virtual table, its sync triggers, and `bm25()` ranking — are
exactly the surface an ORM cannot model, so it would reduce to raw-SQL escape
hatches plus a second migration system beside `wrangler d1 migrations`. The
dozen hand-written statements are validated at the boundary instead (zod on
every request body, `satisfies`-checked against the shared TS contract).

### ADR-3: Embeddings & reranking on Workers AI (bge-m3 + bge-reranker-base)

Anthropic has no embeddings API. Workers AI provides `@cf/baai/bge-m3` (embeddings)
and `@cf/baai/bge-reranker-base` (cross-encoder reranker) on the free allocation,
callable natively from the Worker via the `AI` binding. Ingestion embeds through the
deployed `/api/admin/embed` endpoint so **query-time and index-time embeddings are
guaranteed to come from the same model version**. Retrieve top-50 → rerank → top-5,
per the retrieval convention. Freshness is a linear time-decay on `filing_date`
applied to fused scores before reranking (decay λ chosen by eval, see
`evals/results/`).

### ADR-4: Zero-hallucination generation policy

- Claude **Haiku 4.5** routes each chat turn (structured output): does it need
  retrieval, standalone query rewrite, metadata filters (state/license type),
  and complexity classification.
- Claude **Opus 4.8** generates answers for complex/numerical/table questions;
  Haiku 4.5 handles simple factual lookups (cost control).
- The system prompt enforces: answer **only** from retrieved context; every claim
  carries a `[n]` citation mapping to chunk id + page + bounding boxes; if the context
  is insufficient the model must reply that it does not know and ask for what's
  missing. Faithfulness is measured in CI-able evals (DeepEval), not assumed.

### ADR-5: Late Context Injection (PII security pattern)

User form data (PII) is **never** embedded, stored server-side, or logged. Form state
lives in the browser (localStorage). When a user asks a question about their own
situation ("am I eligible?"), the client sends only the minimal relevant field values
with that single request; the Worker injects them into the prompt as ephemeral
context alongside retrieved *policy* chunks and discards them after the response.
The RAG store contains only public regulatory text.

### ADR-6: Evaluation datasets

`FinTable-X` (named in the original conventions) has no publicly available release we
could locate, so evals run on:
1. **`licensing-golden`** (default) — a curated QA dataset generated from the actually
   ingested licensing documents (text + table + numerical questions), with labeled
   relevant chunks for retrieval metrics. Question generation is LLM-assisted
   (Haiku), then human-reviewable in `evals/golden/`.
2. **`financebench`** (optional, `--dataset financebench --sample N`) — the open
   150-question subset of FinanceBench for text-and-table reasoning on 10-K PDFs.
   Heavy (requires ingesting referenced PDFs); used for spot-checks, not CI.

**DeepEval** is the framework (local, no account needed): retrieval metrics computed
directly (MRR, Context Recall, Context Precision, NDCG@K) + generation metrics
(Faithfulness, Answer Relevancy) with an Anthropic LLM judge. Every experiment writes
a JSON result + markdown summary to `evals/results/` (committed), and the winning
retrieval config is checked into `apps/api/src/retrieval/config.ts` with a pointer to
the run that justified it.

### ADR-7: Form-schema extraction — section-scoped map, Opus critique, conditional IR

**Context.** Single-pass whole-document extraction produced three systematic
defect classes: context-loss duplicates (a bare "Address" line under a
"Mailing Address" heading extracted as both), wrong choice semantics
(check-ONE groups rendered as multi-select checkboxes), and flattened
skip-logic ("complete only if you answered Yes to 3a" became an
unconditionally-required field).

**Decision.** Three-stage pipeline mirroring how mature form systems model
this (XLSForm/SurveyJS "relevance" expressions + extract-critique-repair):

1. **Map (Haiku 4.5)** — fields are extracted per document section with the
   heading breadcrumb in-prompt, so every label is contextually qualified at
   the moment of extraction rather than repaired afterwards.
2. **Reduce (Opus 4.8)** — a critique/repair pass over the assembled draft:
   merges true duplicates (keeping branch-specific same-label fields that
   carry different conditions), fixes choice semantics, and infers
   `visibleIf`/`requiredIf` conditions from the form's own instruction
   language. Cross-section reasoning about duplicate identity and branching
   is complex-reasoning work — Opus per the model policy.
3. **Validate (code)** — deterministic: unique ids, conditions may only
   reference earlier fields, select/radio option sanity; fail-soft repairs
   with logged warnings.

The IR gains `FieldCondition { field, equals | in }` on `visibleIf` /
`requiredIf`; the renderer evaluates conditions live, hides irrelevant
branches, computes effective requiredness, and excludes hidden fields from
progress and from chat form-context.

**Measured on the corpus:** Florida OFR-560-01 went from 8 flat sections /
context-lost duplicates to 169 fields with 62 skip-logic conditions and 25
draft duplicates removed by the critique pass; Alaska extracts entity-type
branching (LLC vs corporation vs nonprofit document requirements) as
mutually exclusive `visibleIf` branches.

## Environments

| | demo | production |
|---|---|---|
| Worker | `forma-demo` | `forma` |
| Hostname | `$DEPLOY_DOMAIN_DEMO` (else `forma-demo.<account>.workers.dev`) | `$DEPLOY_DOMAIN_PROD` (else `forma.<account>.workers.dev`) |
| D1 | `forma-db-demo` | `forma-db` |
| Vectorize | `forma-chunks-demo` | `forma-chunks` |
| R2 | `forma-pdfs-demo` | `forma-pdfs` |
| Guardrails | KV rate limit + daily request cap | same + `ACCESS_CODE` gate |

Secrets per env via `wrangler secret put`: `ANTHROPIC_API_KEY`, `INGEST_TOKEN`,
(`ACCESS_CODE` prod only). Nothing secret or account-specific lives in the repo:
custom hostnames come from `DEPLOY_DOMAIN_*` in the developer's gitignored `.env`
(the deploy script generates a local wrangler config from them), and local dev
secrets use `.dev.vars` (gitignored).

## Data model (D1)

- `documents(id, title, state, license_type, source_url, filing_date, page_count, pdf_key, form_schema JSON, docling_version, created_at)`
- `chunks(id, document_id, parent_id, kind text|table|table_summary, content, page_number, coordinates JSON, state, license_type, filing_date)`
- `chunks_fts` — FTS5 (porter unicode61) over `chunks.content`, BM25-ranked.
- Vectorize: one vector per *embeddable* chunk (text chunks and table **summaries** —
  parent-child: the summary is embedded, the full Docling table markdown is what gets
  retrieved into the LLM context).
- `coordinates` = Docling provenance: `[{page, bbox:[l,t,r,b], origin}]`, used by the
  frontend to draw highlight overlays on the PDF at citation click.
