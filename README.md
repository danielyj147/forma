# Forma — Licensing as a Service

Turn gnarly state/federal licensing PDFs into clean web forms with a grounded,
zero-hallucination assistant — deployable by anyone to a **$0/month**
Cloudflare stack in about five minutes.

**The demo story:** ingest a real money-transmitter application → Forma renders
it as an Ashby-style web form (checkboxes, dropdowns, validation) → an
assistant answers questions about fees, bonds, and eligibility with clickable
citations that highlight the exact coordinates in the source PDF. If the
answer isn't in the documents, it says *"I do not know"* — never guesses.

```
  OFFLINE (your laptop / CI)          DEPLOYED (Cloudflare free tier)
┌──────────────────────────┐   ┌──────────────────────────────────────────┐
│ scripts/ingest.py        │   │  Worker: React SPA + Hono API            │
│  Docling parse (tables   │──▶│   /api/chat  Haiku router → hybrid RAG   │
│  merged, bbox kept)      │   │              → Opus 4.8 grounded answers │
│  Haiku 4.5 form schemas  │   │  Vectorize (dense) ─┐                    │
└──────────────────────────┘   │  D1 FTS5 (BM25)  ───┼─ RRF → decay →     │
                               │  Workers AI (bge-m3,│  rerank → top-5    │
   The compute-heavy part      │   bge-reranker)  ───┘                    │
   never touches production.   │  R2 (PDFs) · KV (rate limits)            │
                               └──────────────────────────────────────────┘
```

The only metered cost is your Anthropic API key.

## Quickstart

Prereqs: Node 20+, [uv](https://docs.astral.sh/uv/), a free Cloudflare
account, an Anthropic API key.

```bash
npm install
cp .env.example .env            # add your ANTHROPIC_API_KEY

# 1. Provision your own demo environment (D1, Vectorize, R2, KV, secrets)
npx wrangler login
npm run setup

# 2. Deploy (SPA + API on a workers.dev URL, or your own domain — see below)
npm run deploy:demo

# 3. Ingest the demo corpus (Docling runs locally; first run downloads models)
./scripts/fetch-corpus.sh
python scripts/ingest.py --file data/pdfs/fl-msb-registration.pdf \
  --title "Florida OFR-560-01 — Application to Register as a Money Services Business" \
  --doc-id fl-msb-registration --state FL --license-type money-services-business \
  --filing-date 2023-02-01
```

Open the URL wrangler printed — done.

- **Custom domain**: set `DEPLOY_DOMAIN_DEMO=forma-demo.your-domain.com` in
  `.env` (zone must be on your Cloudflare account) and re-run setup + deploy.
- **Production env**: `npm run setup -- production && npm run deploy:prod`
  — separate database/index/bucket, optional `ACCESS_CODE` gate.
- **Local dev**: `npm run dev` → http://localhost:5173. Works fully offline
  (no Cloudflare account) via deterministic mock embeddings; set
  `DEV_MOCK_AI=1` in `apps/api/.dev.vars` plus your `ANTHROPIC_API_KEY` and
  `INGEST_TOKEN=dev-local-token`.

## Evaluation-first

Every retrieval technique here is justified by metrics, not vibes — see
[`evals/results/`](evals/results/) for committed runs and
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the decision records.

```bash
python scripts/evaluate.py --generate              # golden QA over YOUR ingested docs
python scripts/evaluate.py --retrieval             # bm25 vs dense vs hybrid × rerank
python scripts/evaluate.py --stage2 '{"mode":"hybrid","rerank":true}'   # rrfK, decay λ
python scripts/evaluate.py --generation            # DeepEval faithfulness + relevancy + IDK rate
```

Metrics: MRR, Context Recall, Context Precision, NDCG@K (retrieval);
Faithfulness, Answer Relevancy, refusal pass-rate (generation, LLM-judged).

## Repo map

| Path | What |
|---|---|
| `apps/api` | Cloudflare Worker: Hono API, hybrid RRF retrieval, SSE chat, admin ingest |
| `apps/web` | React SPA: dynamic forms, chat with citation→PDF-coordinate highlighting |
| `packages/shared` | The typed contract between everything |
| `ingestion/` | Docling pipeline + Haiku form-schema generation (Python 3.12 via uv) |
| `evals/` | Golden dataset + committed metric runs |
| `scripts/` | `setup.mjs` (provision), `deploy.mjs`, `ingest.py`, `evaluate.py` |
| `docs/ARCHITECTURE.md` | ADRs: why this stack, hybrid search design, security model |

## Security model (Late Context Injection)

Applicant PII is **never** embedded, stored server-side, or logged. Form
values live in the browser; when a user explicitly opts in to "share my form
answers", the values ride along on that single request as ephemeral context
and are discarded after the response. The RAG store contains only public
regulatory text. See ADR-5.

## License

MIT. The demo corpus consists of publicly available government documents,
fetched at ingest time and not redistributed here.
