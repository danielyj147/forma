"""Python mirror of the shared TS contract (packages/shared/src/index.ts)."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class SourceRect:
    """Normalized [0,1] rectangle, TOP-LEFT origin — ready for UI overlay."""

    page: int  # 1-based
    rect: tuple[float, float, float, float]  # left, top, right, bottom

    def to_payload(self) -> dict:
        return {"page": self.page, "rect": [round(v, 5) for v in self.rect]}


@dataclass
class Chunk:
    id: str
    kind: str  # text | table | table_summary
    content: str
    embed_text: str | None = None
    parent_id: str | None = None
    page: int | None = None
    rects: list[SourceRect] = field(default_factory=list)

    def to_payload(self) -> dict:
        out: dict = {"id": self.id, "kind": self.kind, "content": self.content}
        if self.embed_text and self.embed_text != self.content:
            out["embedText"] = self.embed_text
        if self.parent_id:
            out["parentId"] = self.parent_id
        if self.page is not None:
            out["page"] = self.page
        if self.rects:
            out["rects"] = [r.to_payload() for r in self.rects]
        return out


@dataclass
class DocumentMeta:
    id: str
    title: str
    state: str | None = None
    license_type: str | None = None
    source_url: str | None = None
    filing_date: str | None = None  # ISO yyyy-mm-dd
    page_count: int | None = None
    docling_version: str | None = None

    def to_payload(self, form_schema: dict | None) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "state": self.state,
            "licenseType": self.license_type,
            "sourceUrl": self.source_url,
            "filingDate": self.filing_date,
            "pageCount": self.page_count,
            "formSchema": form_schema,
            "doclingVersion": self.docling_version,
        }
