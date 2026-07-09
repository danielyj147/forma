"""Client for the Worker's admin ingest API. Embeddings happen server-side
(Workers AI) so index-time and query-time models can never drift (ADR-3)."""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path

import httpx

log = logging.getLogger(__name__)

CHUNK_BATCH = 30  # keeps each Worker request well under subrequest/body limits


class ApiClient:
    def __init__(self, base_url: str, token: str):
        self.base_url = base_url.rstrip("/")
        self.http = httpx.Client(
            timeout=httpx.Timeout(180.0, connect=15.0),
            headers={"authorization": f"Bearer {token}"},
        )

    def health(self) -> dict:
        r = self.http.get(f"{self.base_url}/api/admin/health")
        r.raise_for_status()
        return r.json()

    def upsert_document(self, payload: dict) -> dict:
        r = self.http.post(f"{self.base_url}/api/admin/documents", json=payload)
        r.raise_for_status()
        return r.json()

    def patch_schema(self, document_id: str, form_schema: dict) -> dict:
        r = self.http.patch(
            f"{self.base_url}/api/admin/documents/{document_id}/schema",
            json={"formSchema": form_schema},
        )
        r.raise_for_status()
        return r.json()

    def upload_chunks(self, document_id: str, chunks: list[dict]) -> int:
        embedded = 0
        for i in range(0, len(chunks), CHUNK_BATCH):
            batch = chunks[i : i + CHUNK_BATCH]
            r = self.http.post(
                f"{self.base_url}/api/admin/chunks",
                json={"documentId": document_id, "chunks": batch},
            )
            r.raise_for_status()
            res = r.json()
            embedded += res.get("embedded", 0)
            log.info("  chunks %d-%d uploaded (%d embedded)", i + 1, i + len(batch), embedded)
        return embedded

    def upload_pdf(self, document_id: str, pdf_path: Path) -> dict:
        r = self.http.put(
            f"{self.base_url}/api/admin/pdf/{document_id}",
            content=pdf_path.read_bytes(),
            headers={"content-type": "application/pdf"},
        )
        r.raise_for_status()
        return r.json()


def resolve_target(env_name: str, api_url: str | None, token: str | None, repo_root: Path) -> tuple[str, str]:
    """Resolution order: explicit flags -> FORMA_API_URL/INGEST_TOKEN env ->
    .forma/<env>.json written by `npm run setup`."""
    state = {}
    state_file = repo_root / ".forma" / f"{env_name}.json"
    if state_file.exists():
        state = json.loads(state_file.read_text())

    url = api_url or os.environ.get("FORMA_API_URL") or (
        f"https://{state['domain']}" if state.get("domain") else state.get("workersDevUrl")
    )
    tok = token or os.environ.get("INGEST_TOKEN") or state.get("ingestToken")

    if not url:
        raise SystemExit(
            f"No API URL: pass --api-url, set FORMA_API_URL, or run `npm run setup` "
            f"and `npm run deploy:{'prod' if env_name == 'production' else 'demo'}` first."
        )
    if not tok:
        raise SystemExit("No ingest token: pass --token, set INGEST_TOKEN, or run `npm run setup`.")
    return url, tok
