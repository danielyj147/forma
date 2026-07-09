"""Client for the Worker's admin ingest API. Embeddings happen server-side
(Workers AI) so index-time and query-time models can never drift (ADR-3)."""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path

import time

import httpx

log = logging.getLogger(__name__)

CHUNK_BATCH = 30  # keeps each Worker request well under subrequest/body limits
RETRIES = 3


def _retrying(send):
    """5xx from a Worker under load (big deletes, cold isolates) is usually
    transient — retry with backoff before giving up."""
    def wrapper(*args, **kwargs):
        for attempt in range(1, RETRIES + 1):
            try:
                r = send(*args, **kwargs)
                r.raise_for_status()
                return r
            except httpx.HTTPStatusError as e:
                if e.response.status_code < 500 or attempt == RETRIES:
                    raise
                log.warning("  %s -> %d, retrying (%d/%d)…", e.request.url.path, e.response.status_code, attempt, RETRIES)
            except httpx.TransportError as e:
                if attempt == RETRIES:
                    raise
                log.warning("  transport error (%s), retrying (%d/%d)…", e, attempt, RETRIES)
            time.sleep(2**attempt)
    return wrapper


class ApiClient:
    def __init__(self, base_url: str, token: str):
        self.base_url = base_url.rstrip("/")
        self.http = httpx.Client(
            timeout=httpx.Timeout(180.0, connect=15.0),
            headers={"authorization": f"Bearer {token}"},
        )
        self._post = _retrying(self.http.post)
        self._put = _retrying(self.http.put)
        self._patch = _retrying(self.http.patch)

    def health(self) -> dict:
        r = self.http.get(f"{self.base_url}/api/admin/health")
        r.raise_for_status()
        return r.json()

    def upsert_document(self, payload: dict) -> dict:
        return self._post(f"{self.base_url}/api/admin/documents", json=payload).json()

    def patch_schema(self, document_id: str, form_schema: dict) -> dict:
        return self._patch(
            f"{self.base_url}/api/admin/documents/{document_id}/schema",
            json={"formSchema": form_schema},
        ).json()

    def upload_chunks(self, document_id: str, chunks: list[dict]) -> int:
        embedded = 0
        for i in range(0, len(chunks), CHUNK_BATCH):
            batch = chunks[i : i + CHUNK_BATCH]
            res = self._post(
                f"{self.base_url}/api/admin/chunks",
                json={"documentId": document_id, "chunks": batch},
            ).json()
            embedded += res.get("embedded", 0)
            log.info("  chunks %d-%d uploaded (%d embedded)", i + 1, i + len(batch), embedded)
        return embedded

    def upload_pdf(self, document_id: str, pdf_path: Path) -> dict:
        return self._put(
            f"{self.base_url}/api/admin/pdf/{document_id}",
            content=pdf_path.read_bytes(),
            headers={"content-type": "application/pdf"},
        ).json()


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
