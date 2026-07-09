"""Golden QA dataset generation for `licensing-golden` (ADR-6).

Questions are LLM-generated (Haiku) from real ingested chunks so that every
row has a labeled relevant chunk. The JSONL in evals/golden/ is committed and
human-reviewable; rerunning --generate overwrites it deliberately.

Row shape:
  {"id", "question", "reference_answer", "doc_id", "relevant_ids": [...],
   "kind": "text"|"table"|"unanswerable"}
"""

from __future__ import annotations

import json
import logging
import random
from pathlib import Path

from anthropic import Anthropic

log = logging.getLogger("forma.evals")

HAIKU = "claude-haiku-4-5"

QA_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["question", "answer"],
    "properties": {
        "question": {"type": "string"},
        "answer": {"type": "string"},
    },
}

QA_SYSTEM = """You write evaluation questions for a retrieval system over regulatory licensing documents.

Given one chunk, write ONE question that:
- a real applicant would plausibly ask (natural phrasing, no "according to the chunk")
- is answerable ONLY from this chunk's specific content
- for tables: ask about a specific value (a fee, deadline, bond amount, threshold) that requires reading the table
Also give the correct answer, verbatim-faithful to the chunk."""

UNANSWERABLE = [
    # Adversarial rows: the correct behavior is the exact refusal phrase.
    ("What is the licensing fee for operating a casino in Nevada?", "unanswerable"),
    ("What are the requirements for a liquor license in Texas?", "unanswerable"),
    ("How long does a New Zealand financial advice provider licence take to process?", "unanswerable"),
]


def generate_golden(
    chunks: list[dict],
    out_path: Path,
    per_doc: int = 12,
    table_share: float = 0.4,
    seed: int = 7,
) -> int:
    """chunks: rows from GET /api/admin/chunks (id, document_id, parent_id, kind, content)."""
    rng = random.Random(seed)
    client = Anthropic()

    by_doc: dict[str, list[dict]] = {}
    for ch in chunks:
        by_doc.setdefault(ch["document_id"], []).append(ch)

    parent_by_id = {ch["id"]: ch for ch in chunks}
    rows: list[dict] = []

    for doc_id, doc_chunks in by_doc.items():
        tables = [c for c in doc_chunks if c["kind"] == "table"]
        texts = [c for c in doc_chunks if c["kind"] == "text" and len(c["content"]) > 200]
        n_tables = min(len(tables), max(1, int(per_doc * table_share)))
        n_texts = min(len(texts), per_doc - n_tables)
        sample = rng.sample(tables, n_tables) + rng.sample(texts, n_texts)

        for ch in sample:
            try:
                resp = client.messages.create(
                    model=HAIKU,
                    max_tokens=500,
                    system=QA_SYSTEM,
                    messages=[{"role": "user", "content": ch["content"][:6000]}],
                    output_config={"format": {"type": "json_schema", "schema": QA_SCHEMA}},
                )
                qa = json.loads(resp.content[0].text)
            except Exception as e:
                log.warning("QA generation failed for %s: %s", ch["id"], e)
                continue

            # alias group: table parent <-> its summary child
            relevant = {ch["id"]}
            if ch["kind"] == "table":
                relevant.add(f"{ch['id']}:s")
            if ch.get("parent_id") and ch["parent_id"] in parent_by_id:
                relevant.add(ch["parent_id"])

            rows.append(
                {
                    "id": f"g{len(rows):03d}",
                    "question": qa["question"],
                    "reference_answer": qa["answer"],
                    "doc_id": doc_id,
                    "relevant_ids": sorted(relevant),
                    "kind": ch["kind"],
                }
            )
            log.info("  [%s] %s", ch["kind"], qa["question"][:90])

    for q, _ in UNANSWERABLE:
        rows.append(
            {
                "id": f"g{len(rows):03d}",
                "question": q,
                "reference_answer": "I do not know based on the ingested documents.",
                "doc_id": None,
                "relevant_ids": [],
                "kind": "unanswerable",
            }
        )

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w") as f:
        for row in rows:
            f.write(json.dumps(row) + "\n")
    log.info("✔ wrote %d golden rows to %s", len(rows), out_path)
    return len(rows)


def load_golden(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
