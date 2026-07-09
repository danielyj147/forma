import { Hono } from "hono";
import type { Env } from "../env";
import { ingestAuth } from "../middleware/guards";
import { embedTexts } from "../retrieval/embeddings";
import { vectorDelete, vectorUpsert } from "../retrieval/vectorstore";
import { adminChunksSchema, adminDocumentSchema, parseBody } from "../validation";

/**
 * Ingestion API (Bearer INGEST_TOKEN). The local Docling pipeline pushes
 * documents/chunks/PDFs through these endpoints; embeddings are computed HERE
 * (Workers AI) so index-time and query-time models can never drift (ADR-3).
 * Re-ingest is idempotent: upserting a document wipes its previous chunks.
 */
export const admin = new Hono<{ Bindings: Env }>();
admin.use("/api/admin/*", ingestAuth);

admin.get("/api/admin/health", (c) =>
  c.json({ ok: true, environment: c.env.ENVIRONMENT, mockAi: c.env.DEV_MOCK_AI === "1" }),
);

// Chunk listing for golden-dataset generation (scripts/evaluate.py --generate)
admin.get("/api/admin/chunks", async (c) => {
  const documentId = c.req.query("documentId");
  const where = documentId ? "WHERE document_id = ?1" : "";
  const stmt = c.env.DB.prepare(
    `SELECT id, document_id, parent_id, kind, content, page_number FROM chunks ${where}`,
  );
  const res = await (documentId ? stmt.bind(documentId) : stmt).all();
  return c.json({ chunks: res.results });
});

admin.post("/api/admin/documents", async (c) => {
  const [doc, err] = await parseBody(c.req.raw, adminDocumentSchema);
  if (err) return c.json(err, 400);

  // Clear prior chunks + vectors for idempotent re-ingest
  const oldChunks = await c.env.DB.prepare("SELECT id FROM chunks WHERE document_id = ?1")
    .bind(doc.id)
    .all<{ id: string }>();
  if (oldChunks.results.length > 0) {
    await vectorDelete(c.env, oldChunks.results.map((r) => r.id));
    await c.env.DB.prepare("DELETE FROM chunks WHERE document_id = ?1").bind(doc.id).run();
  }

  await c.env.DB.prepare(
    `INSERT INTO documents (id, title, state, license_type, source_url, filing_date, page_count, form_schema, docling_version)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
     ON CONFLICT(id) DO UPDATE SET
       title=?2, state=?3, license_type=?4, source_url=?5, filing_date=?6,
       page_count=?7, form_schema=COALESCE(?8, form_schema), docling_version=?9`,
  )
    .bind(
      doc.id,
      doc.title,
      doc.state ?? null,
      doc.licenseType ?? null,
      doc.sourceUrl ?? null,
      doc.filingDate ?? null,
      doc.pageCount ?? null,
      doc.formSchema ? JSON.stringify(doc.formSchema) : null,
      doc.doclingVersion ?? null,
    )
    .run();

  return c.json({ ok: true, id: doc.id, clearedChunks: oldChunks.results.length });
});

admin.post("/api/admin/chunks", async (c) => {
  const [body, err] = await parseBody(c.req.raw, adminChunksSchema);
  if (err) return c.json(err, 400);

  const doc = await c.env.DB.prepare(
    "SELECT id, state, license_type, filing_date FROM documents WHERE id = ?1",
  )
    .bind(body.documentId)
    .first<{ id: string; state: string | null; license_type: string | null; filing_date: string | null }>();
  if (!doc) return c.json({ error: "document not found — upsert it first" }, 404);

  // 1. Insert chunk rows (metadata denormalized from the document for filterable legs)
  const stmts = body.chunks.map((ch) =>
    c.env.DB.prepare(
      `INSERT OR REPLACE INTO chunks
         (id, document_id, parent_id, kind, content, page_number, coordinates, state, license_type, filing_date, embedded)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,0)`,
    ).bind(
      ch.id,
      body.documentId,
      ch.parentId ?? null,
      ch.kind,
      ch.content,
      ch.page ?? null,
      ch.rects ? JSON.stringify(ch.rects) : null,
      doc.state,
      doc.license_type,
      doc.filing_date,
    ),
  );
  for (let i = 0; i < stmts.length; i += 40) {
    await c.env.DB.batch(stmts.slice(i, i + 40));
  }

  // 2. Embed + upsert vectors. Parent-child: full tables (kind='table') are NOT
  //    embedded — their summaries are; tables stay lexically searchable via FTS.
  const embeddable = body.chunks.filter((ch) => ch.kind !== "table");
  const vectors = await embedTexts(
    c.env,
    embeddable.map((ch) => ch.embedText ?? ch.content),
  );
  await vectorUpsert(
    c.env,
    embeddable.map((ch, i) => ({
      id: ch.id,
      values: vectors[i],
      metadata: {
        document_id: body.documentId,
        ...(doc.state ? { state: doc.state } : {}),
        ...(doc.license_type ? { license_type: doc.license_type } : {}),
      },
    })),
  );

  const embeddedIds = embeddable.map((ch) => ch.id);
  for (let i = 0; i < embeddedIds.length; i += 40) {
    await c.env.DB.batch(
      embeddedIds
        .slice(i, i + 40)
        .map((id) => c.env.DB.prepare("UPDATE chunks SET embedded = 1 WHERE id = ?1").bind(id)),
    );
  }

  return c.json({ ok: true, inserted: body.chunks.length, embedded: embeddable.length });
});

// Schema-only update: regenerating a form schema must not disturb the
// document's chunks/vectors (unlike a full document upsert).
admin.patch("/api/admin/documents/:id/schema", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => null)) as { formSchema?: unknown } | null;
  if (!body?.formSchema || typeof body.formSchema !== "object") {
    return c.json({ error: "formSchema (object) required" }, 400);
  }
  const result = await c.env.DB.prepare("UPDATE documents SET form_schema = ?1 WHERE id = ?2")
    .bind(JSON.stringify(body.formSchema), id)
    .run();
  if (!result.meta.changes) return c.json({ error: "document not found" }, 404);
  return c.json({ ok: true, id });
});

admin.delete("/api/admin/documents/:id", async (c) => {
  const id = c.req.param("id");
  const chunks = await c.env.DB.prepare("SELECT id FROM chunks WHERE document_id = ?1")
    .bind(id)
    .all<{ id: string }>();
  await vectorDelete(c.env, chunks.results.map((r) => r.id));
  await c.env.DB.prepare("DELETE FROM chunks WHERE document_id = ?1").bind(id).run();
  const doc = await c.env.DB.prepare("SELECT pdf_key FROM documents WHERE id = ?1")
    .bind(id)
    .first<{ pdf_key: string | null }>();
  if (doc?.pdf_key && c.env.PDFS) await c.env.PDFS.delete(doc.pdf_key);
  await c.env.DB.prepare("DELETE FROM documents WHERE id = ?1").bind(id).run();
  return c.json({ ok: true, deletedChunks: chunks.results.length });
});

admin.put("/api/admin/pdf/:documentId", async (c) => {
  const documentId = c.req.param("documentId");
  const doc = await c.env.DB.prepare("SELECT id, source_url FROM documents WHERE id = ?1")
    .bind(documentId)
    .first<{ id: string; source_url: string | null }>();
  if (!doc) return c.json({ error: "document not found — upsert it first" }, 404);

  if (!c.env.PDFS) {
    // R2 not enabled on this account: /api/pdf/:id proxies source_url instead.
    return c.json({
      ok: true,
      stored: false,
      note: doc.source_url
        ? "R2 not configured — PDFs will be proxied from source_url"
        : "R2 not configured and document has no source_url — the PDF viewer will 404 for this document",
    });
  }

  const key = `pdfs/${documentId}.pdf`;
  await c.env.PDFS.put(key, c.req.raw.body, {
    httpMetadata: { contentType: "application/pdf" },
  });
  await c.env.DB.prepare("UPDATE documents SET pdf_key = ?1 WHERE id = ?2")
    .bind(key, documentId)
    .run();
  return c.json({ ok: true, key });
});
