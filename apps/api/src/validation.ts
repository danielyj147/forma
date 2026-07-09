/**
 * Runtime validation of every externally-supplied request body (zod). The
 * shapes mirror packages/shared — the `satisfies` clauses below make the
 * compiler fail if the two ever drift.
 */
import { z } from "zod";
import type {
  AdminChunksUpsert,
  AdminDocumentUpsert,
  ChatRequest,
  SearchRequest,
} from "@forma/shared";

const sourceRect = z.object({
  page: z.number().int().min(1),
  rect: z.tuple([z.number(), z.number(), z.number(), z.number()]),
});

const filters = z
  .object({
    documentId: z.string().min(1).optional(),
    state: z.string().min(1).optional(),
    licenseType: z.string().min(1).optional(),
  })
  .strict();

const retrievalOverrides = z
  .object({
    mode: z.enum(["hybrid", "dense", "bm25"]).optional(),
    denseTopK: z.number().int().min(1).max(100).optional(),
    bm25TopK: z.number().int().min(1).max(100).optional(),
    rrfK: z.number().min(1).max(1000).optional(),
    decayLambda: z.number().min(0).max(1).optional(),
    decayFloor: z.number().min(0).max(1).optional(),
    rerank: z.boolean().optional(),
    rerankTopK: z.number().int().min(1).max(100).optional(),
    finalK: z.number().int().min(1).max(20).optional(),
  })
  .strict();

export const searchRequestSchema = z
  .object({
    query: z.string().min(1).max(2000),
    filters: filters.optional(),
    config: retrievalOverrides.optional(),
    debug: z.boolean().optional(),
  })
  .strict() satisfies z.ZodType<SearchRequest>;

export const chatRequestSchema = z
  .object({
    messages: z
      .array(
        z.object({
          role: z.enum(["user", "assistant"]),
          content: z.string().min(1).max(8000),
        }),
      )
      .min(1)
      .max(40),
    filters: filters.optional(),
    formContext: z
      .array(z.object({ label: z.string().max(200), value: z.string().max(2000) }))
      .max(100)
      .optional(),
    forceModel: z.enum(["haiku", "opus"]).optional(),
  })
  .strict() satisfies z.ZodType<ChatRequest>;

export const adminDocumentSchema = z
  .object({
    id: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/),
    title: z.string().min(1).max(300),
    state: z.string().max(40).nullish(),
    licenseType: z.string().max(80).nullish(),
    sourceUrl: z.string().url().max(1000).nullish(),
    filingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
    pageCount: z.number().int().min(1).nullish(),
    formSchema: z.record(z.string(), z.unknown()).nullish(), // deep-validated by the UI's renderer types
    doclingVersion: z.string().max(40).nullish(),
  })
  .strict() satisfies z.ZodType<Omit<AdminDocumentUpsert, "formSchema"> & { formSchema?: unknown }>;

export const adminChunksSchema = z
  .object({
    documentId: z.string().min(1).max(80),
    chunks: z
      .array(
        z
          .object({
            id: z.string().min(1).max(120),
            parentId: z.string().max(120).nullish(),
            kind: z.enum(["text", "table", "table_summary"]),
            content: z.string().min(1).max(60_000),
            embedText: z.string().min(1).max(60_000).optional(),
            page: z.number().int().min(1).nullish(),
            rects: z.array(sourceRect).max(16).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(60),
  })
  .strict() satisfies z.ZodType<AdminChunksUpsert>;

/** Parse a JSON body against a schema; returns [data, null] or [null, response-detail]. */
export async function parseBody<T>(
  req: Request,
  schema: z.ZodType<T>,
): Promise<[T, null] | [null, { error: string; issues?: unknown }]> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return [null, { error: "Body must be JSON" }];
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    return [null, { error: "Invalid request", issues: result.error.issues.slice(0, 5) }];
  }
  return [result.data, null];
}
