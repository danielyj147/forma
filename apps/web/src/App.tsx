import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Citation, DocumentSummary, FormContextEntry, FormField } from "@forma/shared";
import { ChevronDownIcon, FileSearchIcon, FileTextIcon, RefreshCwIcon, ServerOffIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AccessGate } from "@/components/AccessGate";
import { ChatPanel } from "@/components/ChatPanel";
import { FormPanel } from "@/components/FormPanel";
import type { SchemaState } from "@/components/FormPanel";
import { FormPicker } from "@/components/FormPicker";
import type { HighlightRequest } from "@/components/PdfViewer";
import { TopBar } from "@/components/TopBar";
import { ApiError, fetchDocuments, fetchFormSchema, onAccessRequired, setAccessCode } from "@/lib/api";
import { buildFormContext } from "@/lib/form";
import { loadFormValues, loadSelectedFormId, saveFormValues, saveSelectedFormId } from "@/lib/storage";
import type { FormValue, FormValues } from "@/lib/storage";
import { cn } from "@/lib/utils";

/** Lazy so pdf.js (~500 kB) stays out of the initial bundle. */
const PdfViewer = lazy(() => import("@/components/PdfViewer"));

type DocsState =
  | { status: "loading" }
  | { status: "error"; network: boolean; message: string }
  | { status: "ready"; documents: DocumentSummary[] };

type TabKey = "application" | "assistant";

export default function App() {
  const [docsState, setDocsState] = useState<DocsState>({ status: "loading" });
  const [needsAccess, setNeedsAccess] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [tab, setTab] = useState<TabKey>("application");

  const [selectedFormId, setSelectedFormId] = useState<string | null>(() => loadSelectedFormId());
  const [viewerDocId, setViewerDocId] = useState<string | null>(selectedFormId);
  const [schemaState, setSchemaState] = useState<SchemaState>({ status: "loading" });
  const [values, setValues] = useState<FormValues>(() =>
    selectedFormId ? loadFormValues(selectedFormId) : {},
  );

  const [highlight, setHighlight] = useState<HighlightRequest | null>(null);
  const nonceRef = useRef(0);
  const [pdfOpenMobile, setPdfOpenMobile] = useState(false);

  // ------------------------------------------------------------------
  // Data loading
  // ------------------------------------------------------------------

  useEffect(() => onAccessRequired(() => setNeedsAccess(true)), []);

  useEffect(() => {
    let alive = true;
    setDocsState((prev) => (prev.status === "ready" ? prev : { status: "loading" }));
    fetchDocuments()
      .then((documents) => {
        if (alive) setDocsState({ status: "ready", documents });
      })
      .catch((err: unknown) => {
        if (!alive) return;
        if (err instanceof ApiError && err.isAccessRequired) return; // gate is showing
        const network = err instanceof ApiError && err.isNetwork;
        setDocsState({
          status: "error",
          network,
          message: err instanceof Error ? err.message : "Failed to load documents.",
        });
      });
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  const documents = docsState.status === "ready" ? docsState.documents : null;

  // Drop a persisted selection that no longer exists on the server.
  useEffect(() => {
    if (!documents) return;
    if (selectedFormId && !documents.some((d) => d.id === selectedFormId)) {
      setSelectedFormId(null);
      setViewerDocId(null);
      saveSelectedFormId(null);
    }
    if (viewerDocId && !documents.some((d) => d.id === viewerDocId)) {
      setViewerDocId(null);
    }
  }, [documents, selectedFormId, viewerDocId]);

  // Fetch the form schema for the selected form.
  useEffect(() => {
    if (!selectedFormId || !documents) return;
    let alive = true;
    setSchemaState({ status: "loading" });
    fetchFormSchema(selectedFormId)
      .then((schema) => {
        if (alive) setSchemaState({ status: "ready", schema });
      })
      .catch((err: unknown) => {
        if (!alive) return;
        if (err instanceof ApiError && err.status === 404) setSchemaState({ status: "none" });
        else if (err instanceof ApiError && err.isAccessRequired) setSchemaState({ status: "loading" });
        else {
          setSchemaState({
            status: "error",
            message: err instanceof Error ? err.message : "Failed to load the form schema.",
          });
        }
      });
    return () => {
      alive = false;
    };
  }, [selectedFormId, documents, reloadKey]);

  // ------------------------------------------------------------------
  // Handlers
  // ------------------------------------------------------------------

  const nextHighlight = (page: number, rects: HighlightRequest["rects"]): void => {
    nonceRef.current += 1;
    setHighlight({ page, rects, nonce: nonceRef.current });
    setPdfOpenMobile(true);
  };

  const handleSelectForm = (documentId: string): void => {
    setSelectedFormId(documentId);
    setViewerDocId(documentId);
    saveSelectedFormId(documentId);
    setValues(loadFormValues(documentId));
    setHighlight(null);
  };

  const handleBackToPicker = (): void => {
    setSelectedFormId(null);
    saveSelectedFormId(null);
    setHighlight(null);
  };

  const handleValueChange = (fieldId: string, value: FormValue): void => {
    if (!selectedFormId) return;
    setValues((prev) => {
      const next = { ...prev, [fieldId]: value };
      saveFormValues(selectedFormId, next);
      return next;
    });
  };

  const handleShowSource = (field: FormField): void => {
    const rects = field.source;
    if (!rects || rects.length === 0 || !selectedFormId) return;
    if (viewerDocId !== selectedFormId) setViewerDocId(selectedFormId);
    nextHighlight(rects[0].page, rects);
  };

  const handleCitationClick = (citation: Citation): void => {
    if (!documents) return;
    if (documents.some((d) => d.id === citation.documentId)) {
      setViewerDocId(citation.documentId);
    }
    const page = citation.page ?? citation.rects[0]?.page;
    if (page != null) nextHighlight(page, citation.rects);
  };

  const getFormContext = useCallback((): FormContextEntry[] => {
    if (schemaState.status !== "ready") return [];
    return buildFormContext(schemaState.schema, values);
  }, [schemaState, values]);

  const handleUnlock = async (code: string): Promise<void> => {
    setAccessCode(code);
    const docs = await fetchDocuments(); // throws on a bad code
    setDocsState({ status: "ready", documents: docs });
    setNeedsAccess(false);
    setReloadKey((key) => key + 1);
  };

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  const selectedForm = documents?.find((d) => d.id === selectedFormId) ?? null;
  const viewerDoc = documents?.find((d) => d.id === viewerDocId) ?? null;

  let content: ReactNode;
  if (docsState.status === "loading") {
    content = <SplitSkeleton />;
  } else if (docsState.status === "error") {
    content = docsState.network ? (
      <CenteredNotice
        icon={<ServerOffIcon className="size-5" aria-hidden />}
        title="Backend not running"
        body="The web app couldn't reach the Forma API. From the repository root, start both servers:"
        code="npm run dev"
        footnote="Requests to /api proxy to http://localhost:8787 in development."
        onRetry={() => setReloadKey((key) => key + 1)}
      />
    ) : (
      <CenteredNotice
        icon={<ServerOffIcon className="size-5" aria-hidden />}
        title="Couldn't load documents"
        body={docsState.message}
        onRetry={() => setReloadKey((key) => key + 1)}
      />
    );
  } else if (docsState.documents.length === 0) {
    content = (
      <CenteredNotice
        icon={<FileSearchIcon className="size-5" aria-hidden />}
        title="No documents yet"
        body="Ingest your first licensing PDF — Docling parses it, tables and all, and Forma turns it into a structured form:"
        code="python scripts/ingest.py --file <path-to-pdf>"
        footnote="Then refresh this page to see it in the picker."
        onRetry={() => setReloadKey((key) => key + 1)}
        retryLabel="Refresh"
      />
    );
  } else {
    content = (
      <main className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* Left panel: Application / Assistant */}
        <section className="flex min-h-0 flex-1 flex-col lg:w-[45%] lg:min-w-[420px] lg:flex-none lg:border-r">
          <Tabs
            value={tab}
            onValueChange={(value) => setTab(value as TabKey)}
            className="flex min-h-0 flex-1 flex-col gap-0"
          >
            <div className="shrink-0 border-b bg-card px-4 lg:px-6">
              <TabsList variant="line" className="h-11 gap-5 p-0">
                <TabsTrigger value="application" className={tabTriggerClass}>
                  Application
                </TabsTrigger>
                <TabsTrigger value="assistant" className={tabTriggerClass}>
                  Assistant
                </TabsTrigger>
              </TabsList>
            </div>
            <TabsContent
              value="application"
              forceMount
              className="min-h-0 flex-col data-[state=active]:flex data-[state=inactive]:hidden"
            >
              {selectedForm ? (
                <FormPanel
                  doc={selectedForm}
                  schemaState={schemaState}
                  values={values}
                  onValueChange={handleValueChange}
                  onShowSource={handleShowSource}
                  onBack={handleBackToPicker}
                  onRetry={() => setReloadKey((key) => key + 1)}
                  onAskAssistant={() => setTab("assistant")}
                />
              ) : (
                <FormPicker documents={docsState.documents} onSelect={handleSelectForm} />
              )}
            </TabsContent>
            <TabsContent
              value="assistant"
              forceMount
              className="min-h-0 flex-col data-[state=active]:flex data-[state=inactive]:hidden"
            >
              <ChatPanel
                selectedForm={selectedForm}
                getFormContext={getFormContext}
                onCitationClick={handleCitationClick}
              />
            </TabsContent>
          </Tabs>
        </section>

        {/* Right panel: PDF viewer (collapsible below lg) */}
        <section className="flex min-h-0 shrink-0 flex-col border-t lg:min-h-0 lg:flex-1 lg:border-t-0">
          <button
            type="button"
            className="flex h-11 shrink-0 items-center justify-between bg-card px-4 text-sm font-medium outline-none transition-colors duration-150 hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50 lg:hidden"
            onClick={() => setPdfOpenMobile((open) => !open)}
            aria-expanded={pdfOpenMobile}
          >
            <span className="flex items-center gap-2">
              <FileTextIcon className="size-4 text-muted-foreground" aria-hidden />
              Document preview
            </span>
            <ChevronDownIcon
              className={cn(
                "size-4 text-muted-foreground transition-transform duration-150",
                pdfOpenMobile && "rotate-180",
              )}
              aria-hidden
            />
          </button>
          <div
            className={cn(
              "min-h-0 flex-col lg:flex lg:h-auto lg:flex-1",
              pdfOpenMobile ? "flex h-[55dvh] border-t lg:border-t-0" : "hidden",
            )}
          >
            {viewerDoc ? (
              <Suspense fallback={<div className="min-h-0 flex-1 bg-stone-100/80" />}>
                <PdfViewer
                  doc={viewerDoc}
                  highlight={highlight}
                  onClearHighlight={() => setHighlight(null)}
                />
              </Suspense>
            ) : (
              <ViewerPlaceholder />
            )}
          </div>
        </section>
      </main>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TopBar />
      {content}
      {needsAccess && <AccessGate onUnlock={handleUnlock} />}
    </div>
  );
}

const tabTriggerClass =
  "flex-none px-1 text-[13px] data-active:after:bg-primary data-active:text-foreground";

function ViewerPlaceholder() {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-stone-100/80 px-6 text-center">
      <div className="flex size-10 items-center justify-center rounded-lg bg-card text-muted-foreground ring-1 ring-foreground/10">
        <FileSearchIcon className="size-5" aria-hidden />
      </div>
      <div>
        <p className="text-sm font-medium">Nothing to preview yet</p>
        <p className="mx-auto mt-1 max-w-60 text-xs leading-relaxed text-muted-foreground">
          Pick a form or click a citation — the source PDF renders here with exact-coordinate
          highlights.
        </p>
      </div>
    </div>
  );
}

function CenteredNotice({
  icon,
  title,
  body,
  code,
  footnote,
  onRetry,
  retryLabel = "Retry",
}: {
  icon: ReactNode;
  title: string;
  body: string;
  code?: string;
  footnote?: string;
  onRetry: () => void;
  retryLabel?: string;
}) {
  return (
    <main className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div className="flex w-full max-w-md flex-col items-center gap-4 text-center">
        <div className="flex size-11 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          {icon}
        </div>
        <div>
          <h2 className="font-heading text-xl font-semibold tracking-tight">{title}</h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{body}</p>
        </div>
        {code && (
          <pre className="w-full select-all overflow-x-auto rounded-lg bg-stone-900 px-4 py-3 text-left font-mono text-xs leading-relaxed text-stone-100">
            {code}
          </pre>
        )}
        {footnote && <p className="text-xs text-muted-foreground">{footnote}</p>}
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCwIcon data-icon="inline-start" aria-hidden />
          {retryLabel}
        </Button>
      </div>
    </main>
  );
}

function SplitSkeleton() {
  return (
    <main className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <section className="flex min-h-0 flex-1 flex-col gap-0 lg:w-[45%] lg:min-w-[420px] lg:flex-none lg:border-r">
        <div className="flex h-11 items-center gap-5 border-b bg-card px-4 lg:px-6">
          <Skeleton className="h-3.5 w-20" />
          <Skeleton className="h-3.5 w-16" />
        </div>
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 py-6 lg:px-6">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-7 w-56" />
            <Skeleton className="h-3.5 w-80 max-w-full" />
          </div>
          <div className="flex flex-col gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10">
            <Skeleton className="h-8 w-full" />
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="size-8 rounded-lg" />
                <div className="flex flex-1 flex-col gap-1.5">
                  <Skeleton className="h-3.5 w-3/5" />
                  <Skeleton className="h-3 w-2/5" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
      <section className="hidden min-h-0 flex-1 flex-col lg:flex">
        <div className="flex h-11 items-center gap-3 border-b bg-card px-3">
          <Skeleton className="h-3.5 w-48" />
          <div className="flex-1" />
          <Skeleton className="h-3.5 w-24" />
        </div>
        <div className="flex min-h-0 flex-1 items-start justify-center overflow-hidden bg-stone-100/80 p-6">
          <Skeleton className="aspect-[10/13] w-full max-w-xl rounded-none" />
        </div>
      </section>
    </main>
  );
}
