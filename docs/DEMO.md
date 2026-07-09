# Forma — Demo Walkthrough (~5 minutes)

A script for demoing Forma to stakeholders. The demo corpus is real, public
regulatory paperwork for money-transmitter licensing.

## 0. The problem (30s)

Licensing teams work from PDFs like the Florida OFR-560-01 — 17 pages of
sections, checkboxes, fee references, and attachments. Errors mean weeks of
regulatory back-and-forth. Show the raw PDF on the right panel: this is what
applicants face today.

## 1. PDFs become products (90s)

Open the **Application** tab → search "Florida" → select the MSB application.

- The entire form was generated automatically: Docling parsed the PDF's
  structure (sections, checkboxes, enumerations survive intact), and a small
  LLM converted it into a typed form schema. No human templating.
- Fill a couple of fields. Point out the completion meter and the footnote:
  *answers stay in the browser* — applicant PII never enters our servers or
  the AI pipeline (the "Late Context Injection" pattern).
- Focus a field and show the source highlight on the right: every field knows
  its exact coordinates in the original document.

## 2. Grounded answers, not vibes (2m)

Switch to the **Assistant** tab. Ask, in order:

1. **"What are the surety bond requirements for money transmitters?"**
   → Answer with citations. Click a [n] chip — the PDF jumps to the exact
   table and highlights it. Emphasize: every claim is clickable evidence.
2. **"Which document must I attach to prove net worth?"**
   → Pulls the checklist requirements from the Alaska document.
3. **"What is the licensing fee for a casino in Nevada?"**
   → *"I do not know based on the ingested documents."* This is the
   zero-hallucination contract: if it's not in the corpus, Forma refuses —
   it never improvises about regulations. (This behavior is measured in CI:
   see evals.)
4. Go back to the form, fill "net worth" with a low value, return to chat,
   enable **"Share my form answers"**, and ask **"Am I eligible based on my
   answers?"**
   → The assistant evaluates the user's numbers against the cited policy —
   and the numbers were sent only with that one message.

## 3. The business story (60s)

- **Cost**: the entire serving stack runs on Cloudflare's free tier — the
  only metered cost is the Anthropic API (fractions of a cent per question;
  cheap Haiku routes/answers simple lookups, Opus handles complex reasoning).
  The compute-heavy document processing runs offline, never in production.
- **Trust**: retrieval quality and faithfulness are continuously measured
  (MRR/recall/precision/NDCG for search; LLM-judged faithfulness + refusal
  rate for answers) — `evals/results/` in the repo is the receipts.
- **Speed to market**: `npm run setup && npm run deploy:demo` — a new
  isolated environment (new client, new vertical) in minutes.

## Setup for the demo

```bash
npm run setup && npm run deploy:demo
./scripts/fetch-corpus.sh
# parse once (slow), then replay into any env (fast):
python scripts/ingest.py --file data/pdfs/fl-msb-registration.pdf --title "Florida OFR-560-01 — Application to Register as a Money Services Business" --doc-id fl-msb-registration --state FL --license-type money-services-business --filing-date 2023-02-01
python scripts/ingest.py --file data/pdfs/ak-mt-checklist.pdf --title "Alaska Money Transmitter New Application Checklist" --doc-id ak-money-transmitter-checklist --state AK --license-type money-transmitter --filing-date 2025-05-05
python scripts/ingest.py --file data/pdfs/mtl-50-state-survey.pdf --title "50-State Survey: Money Transmitter Licensing Requirements" --doc-id mtl-50-state-survey --license-type money-transmitter --filing-date 2016-01-01 --skip-schema
```
