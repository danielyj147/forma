"""Docling parsing + chunking (offline, ADR-1).

Why Docling: strict layout/table preservation with multi-page table merging,
per-item provenance (page + bounding box) for UI highlighting, MIT license.
Standard PyPDF/LangChain splitters are prohibited (CLAUDE.md constraint) —
they destroy table structure and provenance.
"""

from __future__ import annotations

import logging

from docling.chunking import HybridChunker
from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import PdfPipelineOptions
from docling.document_converter import DocumentConverter, PdfFormatOption
from docling_core.types.doc import CoordOrigin, DoclingDocument, TableItem

from .models import Chunk, SourceRect

log = logging.getLogger(__name__)

# bge-m3 accepts long inputs, but retrieval quality peaks with focused chunks.
# Baseline 512 (bge family training length); evals sweep retrieval params, and
# chunk-size experiments can rerun ingestion with --max-tokens.
DEFAULT_MAX_TOKENS = 512


def convert_pdf(path: str) -> DoclingDocument:
    """Parse a PDF with table-structure recovery enabled."""
    opts = PdfPipelineOptions()
    opts.do_table_structure = True
    opts.table_structure_options.do_cell_matching = True
    converter = DocumentConverter(
        format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=opts)}
    )
    result = converter.convert(path)
    return result.document


def _normalize_prov(doc: DoclingDocument, prov) -> SourceRect | None:
    """Docling prov bbox -> normalized top-left-origin rect for the UI."""
    try:
        page = doc.pages[prov.page_no]
        width, height = page.size.width, page.size.height
        bbox = prov.bbox
        if bbox.coord_origin == CoordOrigin.BOTTOMLEFT:
            bbox = bbox.to_top_left_origin(page_height=height)
        left = max(0.0, min(1.0, bbox.l / width))
        top = max(0.0, min(1.0, bbox.t / height))
        right = max(0.0, min(1.0, bbox.r / width))
        bottom = max(0.0, min(1.0, bbox.b / height))
        if right <= left or bottom <= top:
            return None
        return SourceRect(page=prov.page_no, rect=(left, top, right, bottom))
    except Exception:  # provenance is best-effort; never fail ingestion on it
        return None


def _item_rects(doc: DoclingDocument, items, limit: int = 4) -> list[SourceRect]:
    rects: list[SourceRect] = []
    for item in items:
        for prov in getattr(item, "prov", []) or []:
            r = _normalize_prov(doc, prov)
            if r:
                rects.append(r)
            if len(rects) >= limit:
                return rects
    return rects


def _table_contexts(doc: DoclingDocument, window: int = 1200) -> dict[int, str]:
    """Walk the document in reading order; for each table, capture the tail of
    the content that precedes it (headings, prose, and the head of the prior
    table — which usually contains the identifying first-column values)."""
    contexts: dict[int, str] = {}
    recent: list[str] = []

    def tail() -> str:
        text = "\n".join(recent)
        return text[-window:] if len(text) > window else text

    try:
        for item, _level in doc.iterate_items():
            if isinstance(item, TableItem):
                contexts[id(item)] = tail()
                try:
                    md = item.export_to_markdown(doc=doc)
                    recent.append(md[:400])  # head rows carry identity cells
                except Exception:
                    pass
            else:
                text = getattr(item, "text", None)
                if text:
                    recent.append(text)
            if sum(len(s) for s in recent) > window * 4:
                recent[:] = ["\n".join(recent)[-window * 2 :]]
    except Exception as e:
        log.warning("reading-order context walk failed: %s", e)
    return contexts


def extract_chunks(doc: DoclingDocument, doc_id: str, max_tokens: int = DEFAULT_MAX_TOKENS) -> tuple[list[Chunk], list[Chunk]]:
    """Returns (text_chunks, table_parents).

    Tables are extracted as full-markdown parent chunks (Docling has already
    merged multi-page tables). Parent-child summaries are attached later by
    the LLM step; text chunks come from HybridChunker with heading context
    used as the embedding text.
    """
    # --- tables (parents) ----------------------------------------------------
    # Reading-order context per table (contextual retrieval): continuation
    # tables often never repeat their subject ("New York" appears pages before
    # the row content), so each table records the tail of what precedes it —
    # including the head of a previous table, whose first cells usually carry
    # the identifying values.
    contexts = _table_contexts(doc)

    table_parents: list[Chunk] = []
    for i, table in enumerate(doc.tables):
        md = table.export_to_markdown(doc=doc)
        if not md.strip():
            continue
        rects = _item_rects(doc, [table])
        table_parents.append(
            Chunk(
                id=f"{doc_id}:tbl{i:03d}",
                kind="table",
                content=md,
                page=rects[0].page if rects else None,
                rects=rects,
                context=contexts.get(id(table)),
            )
        )

    # --- text (skip pure-table chunks; tables are handled above) -------------
    chunker = HybridChunker(max_tokens=max_tokens, merge_peers=True)
    text_chunks: list[Chunk] = []
    for j, chunk in enumerate(chunker.chunk(doc)):
        items = list(getattr(chunk.meta, "doc_items", []) or [])
        if items and all(isinstance(it, TableItem) for it in items):
            continue
        text = chunk.text.strip()
        if len(text) < 30:  # skip page furniture / stray fragments
            continue
        rects = _item_rects(doc, items)
        text_chunks.append(
            Chunk(
                id=f"{doc_id}:t{j:04d}",
                kind="text",
                content=text,
                # heading-contextualized text embeds better than the bare chunk
                embed_text=chunker.contextualize(chunk=chunk),
                page=rects[0].page if rects else None,
                rects=rects,
            )
        )

    log.info("extracted %d text chunks, %d tables", len(text_chunks), len(table_parents))
    return text_chunks, table_parents
