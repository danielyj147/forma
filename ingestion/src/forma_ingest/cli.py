"""Forma ingestion CLI. Entry point for `python scripts/ingest.py`.

Pipeline: Docling convert -> chunk (tables merged, provenance kept) ->
Haiku table summaries (parent-child) -> Haiku form schema -> upload to a
deployed environment's admin API (which embeds via Workers AI).
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import sys
import tempfile
from pathlib import Path

import httpx
from dotenv import load_dotenv

log = logging.getLogger("forma.ingest")

REPO_ROOT = Path(__file__).resolve().parents[3]


def slugify(s: str) -> str:
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", s.lower())).strip("-")[:60]


def main() -> None:
    parser = argparse.ArgumentParser(description="Ingest a licensing PDF into Forma")
    parser.add_argument("--file", required=True, help="Path or https URL of the PDF")
    parser.add_argument("--title", help="Document title (defaults to filename)")
    parser.add_argument("--doc-id", help="Stable document id (defaults to slug of title)")
    parser.add_argument("--state", help="US state / jurisdiction, e.g. CA")
    parser.add_argument("--license-type", help="e.g. money-transmitter, mortgage")
    parser.add_argument("--filing-date", help="ISO date the form/regulation became effective")
    parser.add_argument("--source-url", help="Where the PDF came from")
    parser.add_argument("--env", default="demo", choices=["demo", "production"])
    parser.add_argument("--api-url", help="Override target API base URL")
    parser.add_argument("--token", help="Override INGEST_TOKEN")
    parser.add_argument("--max-tokens", type=int, default=512, help="Chunk size (tokens)")
    parser.add_argument("--skip-schema", action="store_true", help="Skip form-schema generation")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Parse + generate only; write JSON to data/processed/ without uploading",
    )
    parser.add_argument(
        "--from-json",
        metavar="JSON",
        help="Skip parsing/LLM: upload a data/processed/*.json produced by --dry-run (with --file as the PDF)",
    )
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    load_dotenv(REPO_ROOT / ".env")

    if args.from_json:
        _upload_processed(Path(args.from_json), Path(args.file).expanduser().resolve(), args)
        return

    # --- fetch / locate the PDF ------------------------------------------------
    if args.file.startswith(("http://", "https://")):
        log.info("▶ downloading %s", args.file)
        pdf_bytes = httpx.get(args.file, follow_redirects=True, timeout=120).raise_for_status().content
        tmp = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
        tmp.write(pdf_bytes)
        tmp.close()
        pdf_path = Path(tmp.name)
        source_url = args.source_url or args.file
    else:
        pdf_path = Path(args.file).expanduser().resolve()
        if not pdf_path.exists():
            raise SystemExit(f"file not found: {pdf_path}")
        source_url = args.source_url

    title = args.title or pdf_path.stem.replace("_", " ").replace("-", " ").title()
    doc_id = args.doc_id or slugify(args.title or pdf_path.stem)

    # --- Docling (heavy imports deferred so --help stays fast) -----------------
    log.info("▶ parsing with Docling (first run downloads layout/table models)…")
    from importlib.metadata import version as pkg_version

    from .llm import attach_field_sources, build_table_summaries, generate_form_schema
    from .models import DocumentMeta
    from .pipeline import convert_pdf, extract_chunks

    doc = convert_pdf(str(pdf_path))
    page_count = len(doc.pages)
    text_chunks, table_parents = extract_chunks(doc, doc_id, max_tokens=args.max_tokens)
    log.info("✔ parsed: %d pages, %d text chunks, %d tables", page_count, len(text_chunks), len(table_parents))

    # --- LLM steps --------------------------------------------------------------
    from anthropic import Anthropic

    client = Anthropic()  # ANTHROPIC_API_KEY from .env

    log.info("▶ summarizing %d tables (Haiku 4.5)…", len(table_parents))
    table_children = build_table_summaries(client, table_parents, title)

    form_schema = None
    if not args.skip_schema:
        log.info("▶ generating form schema (Haiku 4.5, structured output)…")
        markdown = doc.export_to_markdown()
        form_schema = generate_form_schema(client, markdown, doc_id, title)
        matched = attach_field_sources(doc, form_schema)
        n_fields = sum(len(s["fields"]) for s in form_schema["sections"])
        log.info("✔ schema: %d sections, %d fields (%d with PDF coordinates)",
                 len(form_schema["sections"]), n_fields, matched)

    meta = DocumentMeta(
        id=doc_id,
        title=title,
        state=args.state,
        license_type=args.license_type,
        source_url=source_url,
        filing_date=args.filing_date,
        page_count=page_count,
        docling_version=pkg_version("docling"),
    )
    all_chunks = [c.to_payload() for c in (*text_chunks, *table_parents, *table_children)]

    # --- dry run ----------------------------------------------------------------
    if args.dry_run:
        out_dir = REPO_ROOT / "data" / "processed"
        out_dir.mkdir(parents=True, exist_ok=True)
        out = out_dir / f"{doc_id}.json"
        out.write_text(json.dumps({"document": meta.to_payload(form_schema), "chunks": all_chunks}, indent=2))
        log.info("✔ dry run — wrote %s", out)
        return

    # --- upload -------------------------------------------------------------------
    from .uploader import ApiClient, resolve_target

    url, token = resolve_target(args.env, args.api_url, args.token, REPO_ROOT)
    api = ApiClient(url, token)
    health = api.health()
    log.info("▶ uploading to %s (env=%s, mockAi=%s)", url, health.get("environment"), health.get("mockAi"))

    api.upsert_document(meta.to_payload(form_schema))
    embedded = api.upload_chunks(doc_id, all_chunks)
    api.upload_pdf(doc_id, pdf_path)
    log.info("✔ done: %s — %d chunks uploaded, %d embedded, PDF stored", doc_id, len(all_chunks), embedded)


def _upload_processed(json_path: Path, pdf_path: Path, args) -> None:
    from .uploader import ApiClient, resolve_target

    data = json.loads(json_path.read_text())
    doc = data["document"]
    url, token = resolve_target(args.env, args.api_url, args.token, REPO_ROOT)
    api = ApiClient(url, token)
    health = api.health()
    log.info("▶ uploading %s to %s (env=%s, mockAi=%s)", doc["id"], url,
             health.get("environment"), health.get("mockAi"))
    api.upsert_document(doc)
    embedded = api.upload_chunks(doc["id"], data["chunks"])
    api.upload_pdf(doc["id"], pdf_path)
    log.info("✔ done: %s — %d chunks uploaded, %d embedded, PDF stored",
             doc["id"], len(data["chunks"]), embedded)


if __name__ == "__main__":
    sys.exit(main())
