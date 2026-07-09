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


TABLE_SUMMARY_JSON = {
    "type": "object",
    "additionalProperties": False,
    "required": ["situating_line", "summary"],
    "properties": {
        "situating_line": {
            "type": "string",
            "description": "One sentence situating this table within the document, naming the specific subject (jurisdiction/state, form part, entity) it belongs to — inferred from the preceding context.",
        },
        "summary": {
            "type": "string",
            "description": "Dense retrieval summary: what the table lists, columns, notable exact values (fees, deadlines, thresholds, bond amounts).",
        },
    },
}


def summarize_table(client: Anthropic, table_md: str, doc_title: str, context: str | None) -> dict:
    """Contextual retrieval (Anthropic technique): the summary is generated with
    the preceding document content so continuation tables get situated — e.g.
    'This table continues New York's money transmitter licensing requirements.'
    The situating line is written into both the embedded child AND the parent
    table, so state-scoped queries can match either leg."""
    context_block = f"<preceding_document_content>\n{context}\n</preceding_document_content>\n\n" if context else ""
    response = client.messages.create(
        model=HAIKU,
        max_tokens=500,
        system=(
            "You summarize one table from a regulatory licensing document for a retrieval "
            "index. Use the preceding document content to determine WHAT specific subject "
            "(state/jurisdiction, form part, section) the table belongs to — continuation "
            "tables often do not repeat their subject. Never invent a subject not supported "
            "by the context; if genuinely unclear, situate by document and page area only."
        ),
        messages=[
            {
                "role": "user",
                "content": f"Document: {doc_title}\n\n{context_block}<table>\n{table_md[:6000]}\n</table>",
            }
        ],
        output_config={"format": {"type": "json_schema", "schema": TABLE_SUMMARY_JSON}},
    )
    return json.loads(response.content[0].text)


def build_table_summaries(client: Anthropic, parents: list[Chunk], doc_title: str) -> list[Chunk]:
    children: list[Chunk] = []
    for parent in parents:
        try:
            out = summarize_table(client, parent.content, doc_title, parent.context)
            situating, summary = out["situating_line"].strip(), out["summary"].strip()
        except Exception as e:  # keep ingesting even if one summary fails
            log.warning("table summary failed for %s: %s", parent.id, e)
            situating, summary = "", parent.content[:800]
        # Parent carries the situating line too: BM25 over the full table and
        # the LLM reading the swapped-in parent both see the subject.
        if situating:
            parent.content = f"{situating}\n\n{parent.content}"
        children.append(
            Chunk(
                id=f"{parent.id}:s",
                kind="table_summary",
                content=f"{situating} {summary}".strip(),
                parent_id=parent.id,
                page=parent.page,
                rects=parent.rects,
            )
        )
    return children


# ---------------------------------------------------------------------------
# Form schema generation — two-stage design (see docs/ARCHITECTURE.md ADR-7):
#
#   MAP    (Haiku):  extract fields per document section, with the heading
#                    breadcrumb in-context so "Address" under "Mailing Address"
#                    can never collapse into a context-free duplicate.
#   REDUCE (Opus):   critique + repair the assembled draft — merge true
#                    duplicates, fix one-only groups (checkbox -> radio),
#                    infer skip-logic (visibleIf/requiredIf) from the form's
#                    own instruction language.
#   VALIDATE (code): deterministic checks — unique ids, forward-only condition
#                    references, options sanity. Fail-soft with warnings.
#
# The IR intentionally mirrors XLSForm/SurveyJS "relevance" semantics: a
# minimal equality/membership condition on one controlling field.
# ---------------------------------------------------------------------------

OPUS = "claude-opus-4-8"

CONDITION_JSON = {
    "type": "object",
    "additionalProperties": False,
    "required": ["field"],
    "properties": {
        "field": {"type": "string", "description": "id of the controlling field (must appear earlier in the form)"},
        "equals": {"anyOf": [{"type": "string"}, {"type": "boolean"}]},
        "in": {"type": "array", "items": {"type": "string"}},
    },
}

FIELD_JSON = {
    "type": "object",
    "additionalProperties": False,
    "required": ["id", "label", "type"],
    "properties": {
        "id": {"type": "string"},
        "label": {"type": "string"},
        "type": {
            "type": "string",
            "enum": ["text", "textarea", "number", "date", "select", "checkbox", "radio", "file"],
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
        "visibleIf": CONDITION_JSON,
        "requiredIf": CONDITION_JSON,
    },
}

SECTION_JSON = {
    "type": "object",
    "additionalProperties": False,
    "required": ["id", "title", "fields"],
    "properties": {
        "id": {"type": "string"},
        "title": {"type": "string"},
        "description": {"type": "string"},
        "fields": {"type": "array", "items": FIELD_JSON},
    },
}

FORM_SCHEMA_JSON = {
    "type": "object",
    "additionalProperties": False,
    "required": ["title", "sections"],
    "properties": {
        "title": {"type": "string"},
        "sections": {"type": "array", "items": SECTION_JSON},
    },
}

MAP_OUTPUT_JSON = {
    "type": "object",
    "additionalProperties": False,
    "required": ["title", "fields"],
    "properties": {
        "title": {"type": "string"},
        "description": {"type": "string"},
        "fields": {"type": "array", "items": FIELD_JSON},
    },
}

MAP_SYSTEM = """You extract the fillable fields of ONE SECTION of a government/regulatory licensing application (structural markdown from Docling). The section's heading path in the document is given — use it to write CONTEXTUAL labels: a bare "Address" line under the "Mailing Address" heading is labeled "Mailing address", not "Address".

Rules:
- Only fields a filer actually fills IN THIS SECTION, in document order. Do not invent fields; do not repeat fields that clearly belong to another section's heading context.
- Most specific type: radio/select for choose-ONE enumerations ("check one", either/or), checkbox for yes/no or check-ALL-that-apply (include options), date, number for amounts/counts, file for required attachments/exhibits, textarea for narrative answers, text otherwise.
- If the section text conditions a field on an earlier answer IN THIS SECTION ("If yes, …", "complete only if …"), express it as visibleIf/requiredIf on the controlling field's id.
- `required: true` only when the document marks the item mandatory or it is unmistakably mandatory.
- Fee amounts, statutory references, key instructions -> short `help` texts.
- Instructions-only content -> return zero fields (fold anything essential into `description`).
- ids: short snake_case, prefixed to be unique (use the given section prefix)."""

CRITIQUE_SYSTEM = """You are reviewing a DRAFT web-form schema that was extracted section-by-section from a government licensing application. Your job is critique-and-repair, producing the final schema. The section drafts were extracted independently, so cross-section defects are expected. Fix exactly these classes of problems:

1. DUPLICATES: two fields describing the same physical form item (usually created by overlapping heading context, e.g. "address" and "mailing_address"). Keep ONE — the more contextually specific label — in its correct section. Never keep both. But do NOT merge fields that are genuinely distinct (business address vs mailing address IS distinct when the document asks for both).
2. CHOICE SEMANTICS: "check one" enumerations must be radio (or select when more than ~6 options); "check all that apply" must be checkbox with options; lone yes/no items must be a single checkbox (no options).
3. SKIP-LOGIC: where a field's own help/label/section description says it applies only under a prior answer ("If you answered Yes to …", "only if …", "skip to Section N unless …"), attach visibleIf (and requiredIf when it becomes mandatory in that branch) referencing the controlling field's id. Conditions may now cross sections. Only encode conditions the document actually states.
4. IDS & ORDER: snake_case ids unique across the whole form; keep the document's section and field order; sections with zero fields are dropped; a controlling field must appear before its dependents.
5. Do NOT invent new fields, options, or conditions that are not in the draft or clearly implied by it. Preserve `help` texts (shorten if verbose).

Return the complete corrected schema."""


def _split_sections(markdown: str, max_chars: int = 12_000, min_chars: int = 400) -> list[tuple[str, str]]:
    """Split Docling markdown on headings, carrying the heading breadcrumb.
    Small consecutive sections merge; oversized ones split on paragraph breaks."""
    import re as _re

    heading = _re.compile(r"^(#{1,4})\s+(.+)$")
    stack: list[str] = []
    raw: list[tuple[str, list[str]]] = [("(document start)", [])]
    for line in markdown.splitlines():
        m = heading.match(line)
        if m:
            level = len(m.group(1))
            stack = stack[: level - 1] + [m.group(2).strip()]
            raw.append((" > ".join(stack), [line]))
        else:
            raw[-1][1].append(line)

    sections: list[tuple[str, str]] = []
    for crumb, lines in raw:
        text = "\n".join(lines).strip()
        if not text:
            continue
        # merge small continuations into the previous block (same top heading)
        if sections and len(text) < min_chars and len(sections[-1][1]) + len(text) < max_chars:
            prev_crumb, prev_text = sections[-1]
            sections[-1] = (prev_crumb, prev_text + "\n\n" + text)
            continue
        while len(text) > max_chars:  # split giant sections at paragraph breaks
            cut = text.rfind("\n\n", 0, max_chars)
            cut = cut if cut > min_chars else max_chars
            sections.append((crumb, text[:cut].strip()))
            text = text[cut:].strip()
        sections.append((crumb, text))
    return sections


def _map_section(client: Anthropic, crumb: str, text: str, title: str, prefix: str) -> dict | None:
    try:
        response = client.messages.create(
            model=HAIKU,
            max_tokens=8000,
            system=MAP_SYSTEM,
            messages=[
                {
                    "role": "user",
                    "content": (
                        f"Document: {title}\nSection heading path: {crumb}\n"
                        f"Field id prefix: {prefix}\n\n<section_markdown>\n{text}\n</section_markdown>"
                    ),
                }
            ],
            output_config={"format": {"type": "json_schema", "schema": MAP_OUTPUT_JSON}},
        )
        return json.loads(response.content[0].text)
    except Exception as e:
        log.warning("  map failed for section %r: %s", crumb[:60], e)
        return None


def _critique_repair(client: Anthropic, draft: dict, title: str) -> dict:
    """Opus 4.8 cross-section repair — this is genuinely complex reasoning
    (duplicate identity, branching logic), which is Opus territory per the
    model policy. Streaming because repaired schemas can exceed 16k tokens."""
    with client.messages.stream(
        model=OPUS,
        max_tokens=64_000,
        system=CRITIQUE_SYSTEM,
        messages=[
            {
                "role": "user",
                "content": f"Document: {title}\n\n<draft_schema>\n{json.dumps(draft, indent=1)}\n</draft_schema>",
            }
        ],
        # effort=medium: output length is dictated by schema size, not reasoning
        # depth — the recommended Opus cost lever (schema passes dominate spend)
        output_config={"effort": "medium", "format": {"type": "json_schema", "schema": FORM_SCHEMA_JSON}},
    ) as stream:
        response = stream.get_final_message()
    return json.loads(response.content[0].text)


def _validate_schema(schema: dict) -> int:
    """Deterministic post-validation; repairs in place, returns warning count."""
    warnings = 0
    seen_ids: set[str] = set()
    schema["sections"] = [s for s in schema.get("sections", []) if s.get("fields")]
    for section in schema["sections"]:
        for field in section["fields"]:
            if field["id"] in seen_ids:  # duplicate id -> suffix, keep both visible
                base, n = field["id"], 2
                while f"{base}_{n}" in seen_ids:
                    n += 1
                field["id"] = f"{base}_{n}"
                warnings += 1
            seen_ids.add(field["id"])
            if field.get("type") in ("select", "radio") and len(field.get("options") or []) < 2:
                field["type"] = "text" if not field.get("options") else "checkbox"
                warnings += 1
    # conditions must reference an already-seen (earlier) field
    ordered: set[str] = set()
    for section in schema["sections"]:
        for field in section["fields"]:
            for key in ("visibleIf", "requiredIf"):
                cond = field.get(key)
                if cond and cond.get("field") not in ordered:
                    field.pop(key, None)
                    warnings += 1
            ordered.add(field["id"])
    if warnings:
        log.warning("  schema validation repaired %d issue(s)", warnings)
    return warnings


EXAMPLE_FORM_SYSTEM = """The document below is NOT a fillable form — it is a requirements list / checklist / guidance for a license application that has no standard form (applicants typically assemble documents and answers themselves). Design the intuitive web application form that SHOULD exist: the form an applicant would fill once, instead of reading the whole document.

Rules:
- Applicant-centric flow: About the applicant → Business details → Ownership & control persons → Financials → Compliance → Required documents (as `file` upload fields) → Attestations. Only include sections the document's requirements actually call for.
- EVERY field must be traceable to a requirement in the document; cite the requirement briefly in `help` (fee amounts, statute refs). Do not invent requirements.
- Use skip-logic (visibleIf/requiredIf) where requirements are conditional; radio/select for choose-one, checkbox for yes/no or check-all.
- ids: short snake_case, unique. 3-25 fields per section. This is a product demonstration of what a clean form feels like — favor clarity over exhaustiveness."""


def generate_example_form_schema(client: Anthropic, doc_markdown: str, doc_id: str, title: str) -> dict:
    """One-shot Opus design pass — example forms optimize for applicant UX
    derived from requirements, not structural fidelity (ADR-7 addendum)."""
    with client.messages.stream(
        model=OPUS,
        max_tokens=24_000,
        system=EXAMPLE_FORM_SYSTEM,
        messages=[
            {
                "role": "user",
                "content": f"Document title: {title}\n\n<document_markdown>\n{doc_markdown[:100_000]}\n</document_markdown>",
            }
        ],
        # effort=medium: output length is dictated by schema size, not reasoning
        # depth — the recommended Opus cost lever (schema passes dominate spend)
        output_config={"effort": "medium", "format": {"type": "json_schema", "schema": FORM_SCHEMA_JSON}},
    ) as stream:
        response = stream.get_final_message()
    schema = json.loads(response.content[0].text)
    _validate_schema(schema)
    schema["documentId"] = doc_id
    schema["formKind"] = "example"
    n = sum(len(s["fields"]) for s in schema["sections"])
    log.info("  example form: %d sections, %d fields", len(schema["sections"]), n)
    return schema


def generate_form_schema(client: Anthropic, doc_markdown: str, doc_id: str, title: str) -> dict:
    sections = _split_sections(doc_markdown)
    log.info("  map stage: %d sections (Haiku)", len(sections))
    draft_sections: list[dict] = []
    for i, (crumb, text) in enumerate(sections):
        out = _map_section(client, crumb, text, title, prefix=f"s{i:02d}")
        if out and out.get("fields"):
            out["id"] = f"s{i:02d}"
            draft_sections.append(out)
    if not draft_sections:
        raise RuntimeError("map stage extracted no fields")

    n_draft = sum(len(s["fields"]) for s in draft_sections)
    log.info("  reduce stage: critique/repair of %d draft fields (Opus 4.8)", n_draft)
    schema = _critique_repair(client, {"title": title, "sections": draft_sections}, title)
    _validate_schema(schema)
    schema["documentId"] = doc_id
    schema["formKind"] = "faithful"
    n_final = sum(len(s["fields"]) for s in schema["sections"])
    n_cond = sum(
        1 for s in schema["sections"] for f in s["fields"] if f.get("visibleIf") or f.get("requiredIf")
    )
    log.info("  final: %d fields (%+d vs draft), %d with skip-logic conditions", n_final, n_final - n_draft, n_cond)
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
