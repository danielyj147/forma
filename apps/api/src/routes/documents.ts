import { Hono } from "hono";
import type { DocumentSummary, FormSchema } from "@forma/shared";
import type { Env } from "../env";

export const documents = new Hono<{ Bindings: Env }>();

interface DocRow {
  id: string;
  title: string;
  state: string | null;
  license_type: string | null;
  source_url: string | null;
  filing_date: string | null;
  page_count: number | null;
  form_schema: string | null;
}

documents.get("/api/documents", async (c) => {
  const res = await c.env.DB.prepare(
    `SELECT id, title, state, license_type, source_url, filing_date, page_count,
            CASE WHEN form_schema IS NULL THEN NULL ELSE 'y' END AS form_schema
       FROM documents ORDER BY created_at DESC`,
  ).all<DocRow>();

  const out: DocumentSummary[] = res.results.map((d) => ({
    id: d.id,
    title: d.title,
    state: d.state,
    licenseType: d.license_type,
    sourceUrl: d.source_url,
    filingDate: d.filing_date,
    pageCount: d.page_count,
    pdfUrl: `/api/pdf/${d.id}`,
    hasFormSchema: d.form_schema !== null,
  }));
  return c.json({ documents: out });
});

documents.get("/api/documents/:id/schema", async (c) => {
  const row = await c.env.DB.prepare("SELECT form_schema FROM documents WHERE id = ?1")
    .bind(c.req.param("id"))
    .first<{ form_schema: string | null }>();
  if (!row?.form_schema) return c.json({ error: "No form schema for this document" }, 404);
  return c.json(JSON.parse(row.form_schema) as FormSchema);
});

documents.get("/api/pdf/:id", async (c) => {
  const row = await c.env.DB.prepare("SELECT pdf_key FROM documents WHERE id = ?1")
    .bind(c.req.param("id"))
    .first<{ pdf_key: string | null }>();
  if (!row?.pdf_key) return c.json({ error: "PDF not found" }, 404);

  const obj = await c.env.PDFS.get(row.pdf_key);
  if (!obj) return c.json({ error: "PDF object missing from storage" }, 404);

  return new Response(obj.body, {
    headers: {
      "content-type": "application/pdf",
      "cache-control": "public, max-age=3600",
    },
  });
});
