"""LLM steps of ingestion (Haiku 4.5 per CLAUDE.md cost policy):
- table summaries (the embedded child in the parent-child pattern)
- form schema generation from Docling's structural markdown
"""

from __future__ import annotations

import json
import logging
import re

from anthropic import Anthropic

from .models import Chunk, SourceRect

log = logging.getLogger(__name__)

HAIKU = "claude-haiku-4-5"

# ---------------------------------------------------------------------------
# Table summaries (parent-child retrieval)
# ---------------------------------------------------------------------------


def summarize_table(client: Anthropic, table_md: str, doc_title: str) -> str:
    response = client.messages.create(
        model=HAIKU,
        max_tokens=300,
        system=(
            "Write a dense retrieval summary of the table from a regulatory "
            "licensing document. One short paragraph: what the table lists, its "
            "columns, notable exact values (fees, deadlines, thresholds, bond "
            "amounts) and categories. No preamble."
        ),
        messages=[{"role": "user", "content": f"Document: {doc_title}\n\n{table_md[:6000]}"}],
    )
    return response.content[0].text.strip()


def build_table_summaries(client: Anthropic, parents: list[Chunk], doc_title: str) -> list[Chunk]:
    children: list[Chunk] = []
    for parent in parents:
        try:
            summary = summarize_table(client, parent.content, doc_title)
        except Exception as e:  # keep ingesting even if one summary fails
            log.warning("table summary failed for %s: %s", parent.id, e)
            summary = parent.content[:800]
        children.append(
            Chunk(
                id=f"{parent.id}:s",
                kind="table_summary",
                content=summary,
                parent_id=parent.id,
                page=parent.page,
                rects=parent.rects,
            )
        )
    return children


# ---------------------------------------------------------------------------
# Form schema generation (Docling markdown -> strict JSON -> Ashby-style UI)
# ---------------------------------------------------------------------------

FORM_SCHEMA_JSON = {
    "type": "object",
    "additionalProperties": False,
    "required": ["title", "sections"],
    "properties": {
        "title": {"type": "string"},
        "sections": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["id", "title", "fields"],
                "properties": {
                    "id": {"type": "string"},
                    "title": {"type": "string"},
                    "description": {"type": "string"},
                    "fields": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "additionalProperties": False,
                            "required": ["id", "label", "type"],
                            "properties": {
                                "id": {"type": "string"},
                                "label": {"type": "string"},
                                "type": {
                                    "type": "string",
                                    "enum": [
                                        "text",
                                        "textarea",
                                        "number",
                                        "date",
                                        "select",
                                        "checkbox",
                                        "radio",
                                        "file",
                                    ],
                                },
                                "required": {"type": "boolean"},
                                "help": {"type": "string"},
                                "placeholder": {"type": "string"},
                                "options": {
                                    "type": "array",
                                    "items": {
                                        "type": "object",
                                        "additionalProperties": False,
                                        "required": ["value", "label"],
                                        "properties": {
                                            "value": {"type": "string"},
                                            "label": {"type": "string"},
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
    },
}

SCHEMA_SYSTEM = """You convert a government/regulatory licensing application (given as structural markdown extracted by Docling) into a clean web-form schema.

Rules:
- Mirror the document's own section structure and field order.
- Every fillable item in the document becomes a field with the most specific type: checkboxes for yes/no or check-all-that-apply, select/radio for enumerated choices (include the options), date for dates, number for amounts/counts, file for required attachments/exhibits, textarea for narrative answers.
- Field ids: short snake_case, unique across the whole form. Section ids: snake_case.
- `required: true` when the document marks an item mandatory (or it is clearly mandatory).
- Put fee amounts, statutory references, or instructions in `help` (short!).
- Skip page headers/footers, signature blocks rendered as images, and instructions-only pages (fold key instructions into section descriptions).
- 3-30 fields per section. Do not invent fields that are not in the document."""


def generate_form_schema(client: Anthropic, doc_markdown: str, doc_id: str, title: str) -> dict:
    response = client.messages.create(
        model=HAIKU,
        max_tokens=16000,
        system=SCHEMA_SYSTEM,
        messages=[
            {
                "role": "user",
                "content": f"Document title: {title}\n\n<document_markdown>\n{doc_markdown[:120_000]}\n</document_markdown>",
            }
        ],
        output_config={"format": {"type": "json_schema", "schema": FORM_SCHEMA_JSON}},
    )
    schema = json.loads(response.content[0].text)
    schema["documentId"] = doc_id
    return schema


# ---------------------------------------------------------------------------
# Best-effort field -> PDF coordinates matching (for highlight-on-focus)
# ---------------------------------------------------------------------------


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9 ]+", "", s.lower()).strip()


def attach_field_sources(doc, schema: dict) -> int:
    """Match field labels to Docling text items to recover page/bbox. Fuzzy and
    best-effort: unmatched fields simply have no highlight affordance."""
    from .pipeline import _normalize_prov  # reuse coordinate normalization

    index: list[tuple[str, list[SourceRect]]] = []
    for item in doc.texts:
        text = _norm(getattr(item, "text", "") or "")
        if not (3 <= len(text) <= 200):
            continue
        rects = []
        for prov in getattr(item, "prov", []) or []:
            r = _normalize_prov(doc, prov)
            if r:
                rects.append(r)
        if rects:
            index.append((text, rects[:2]))

    matched = 0
    for section in schema.get("sections", []):
        for field in section.get("fields", []):
            label = _norm(field.get("label", ""))
            if len(label) < 4:
                continue
            hit = next((rects for text, rects in index if label in text or text in label), None)
            if hit:
                field["source"] = [r.to_payload() for r in hit]
                matched += 1
    return matched
