import { useEffect, useMemo, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import type { DocumentSummary, SourceRect } from "@forma/shared";
import { ChevronLeftIcon, ChevronRightIcon, FileTextIcon, XIcon, ZoomInIcon, ZoomOutIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { pdfFileSource } from "@/lib/api";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

/** A one-shot request to jump to a page and flash a set of source rects. */
export interface HighlightRequest {
  page: number;
  rects: SourceRect[];
  nonce: number;
}

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.5;
const ZOOM_STEP = 0.25;

interface PdfViewerProps {
  doc: DocumentSummary;
  highlight: HighlightRequest | null;
  onClearHighlight: () => void;
}

export function PdfViewer({ doc, highlight, onClearHighlight }: PdfViewerProps) {
  const [numPages, setNumPages] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [containerWidth, setContainerWidth] = useState(0);
  const [renderTick, setRenderTick] = useState(0);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const firstRectRef = useRef<HTMLDivElement | null>(null);
  const scrolledNonceRef = useRef(0);

  const file = useMemo(() => pdfFileSource(doc), [doc]);

  // Reset paging when the viewer switches documents.
  useEffect(() => {
    setNumPages(null);
    setPage(1);
  }, [doc.id]);

  // Jump to the requested page whenever a highlight fires (form-field focus
  // or citation click) — including one that also switched the document.
  useEffect(() => {
    if (highlight) setPage(highlight.page);
  }, [highlight, doc.id]);

  // Track the scroll container's width so pages render at fit-width.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setContainerWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const totalPages = numPages ?? doc.pageCount ?? null;
  const effectivePage = totalPages ? Math.min(Math.max(page, 1), totalPages) : Math.max(page, 1);
  const fitWidth = Math.min(Math.max(containerWidth - 48, 240), 1600);
  const pageWidth = Math.round(fitWidth * zoom);

  // After the target page paints, bring the flashed rects into view.
  useEffect(() => {
    if (!highlight || highlight.nonce === scrolledNonceRef.current) return;
    if (effectivePage !== highlight.page) return;
    if (firstRectRef.current) {
      scrolledNonceRef.current = highlight.nonce;
      firstRectRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    } else if (renderTick > 0 && highlight.rects.length === 0) {
      scrolledNonceRef.current = highlight.nonce;
      containerRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, [highlight, renderTick, effectivePage]);

  const goTo = (next: number): void => {
    const clamped = totalPages ? Math.min(Math.max(next, 1), totalPages) : Math.max(next, 1);
    setPage(clamped);
    if (highlight) onClearHighlight();
  };

  const pageRects = highlight ? highlight.rects.filter((r) => r.page === effectivePage) : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      {/* Toolbar */}
      <div className="flex h-11 shrink-0 items-center gap-1.5 border-b bg-card px-3">
        <FileTextIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 truncate text-[13px] font-medium" title={doc.title}>
          {doc.title}
        </span>
        {doc.state && (
          <Badge variant="outline" className="hidden shrink-0 text-muted-foreground xl:inline-flex">
            {doc.state}
          </Badge>
        )}
        <div className="flex-1" />
        {highlight && (
          <Button
            variant="secondary"
            size="xs"
            className="hidden text-muted-foreground sm:inline-flex"
            onClick={onClearHighlight}
          >
            <XIcon data-icon="inline-start" aria-hidden />
            Clear highlight
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Previous page"
          disabled={effectivePage <= 1}
          onClick={() => goTo(effectivePage - 1)}
        >
          <ChevronLeftIcon aria-hidden />
        </Button>
        <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
          Page {effectivePage} of {totalPages ?? "—"}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Next page"
          disabled={totalPages !== null && effectivePage >= totalPages}
          onClick={() => goTo(effectivePage + 1)}
        >
          <ChevronRightIcon aria-hidden />
        </Button>
        <Separator orientation="vertical" className="mx-1 data-vertical:h-4 data-vertical:self-center" />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Zoom out"
          disabled={zoom <= ZOOM_MIN}
          onClick={() => setZoom((z) => Math.max(ZOOM_MIN, Math.round((z - ZOOM_STEP) * 100) / 100))}
        >
          <ZoomOutIcon aria-hidden />
        </Button>
        <button
          type="button"
          className="w-11 rounded-md py-1 text-center text-xs tabular-nums text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
          title="Reset to fit width"
          onClick={() => setZoom(1)}
        >
          {Math.round(zoom * 100)}%
        </button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Zoom in"
          disabled={zoom >= ZOOM_MAX}
          onClick={() => setZoom((z) => Math.min(ZOOM_MAX, Math.round((z + ZOOM_STEP) * 100) / 100))}
        >
          <ZoomInIcon aria-hidden />
        </Button>
      </div>

      {/* Page canvas */}
      <div ref={containerRef} className="min-h-0 flex-1 overflow-auto bg-stone-100/80">
        <div className="w-fit min-w-full px-6 py-6">
          {containerWidth > 0 && (
            <Document
              key={doc.id}
              file={file}
              onLoadSuccess={({ numPages: n }) => setNumPages(n)}
              loading={<PageSkeleton width={pageWidth} />}
              error={
                <div className="mx-auto w-fit rounded-xl border bg-card px-6 py-5 text-center">
                  <p className="text-sm font-medium">Couldn't load this PDF</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    The document may still be ingesting, or the API is unreachable.
                  </p>
                </div>
              }
            >
              <div className="relative mx-auto w-fit bg-white shadow-sm ring-1 ring-black/10">
                <Page
                  pageNumber={effectivePage}
                  width={pageWidth}
                  renderTextLayer={false}
                  renderAnnotationLayer={false}
                  onRenderSuccess={() => setRenderTick((t) => t + 1)}
                  loading={<PageSkeleton width={pageWidth} bare />}
                />
                {pageRects.map((r, i) => (
                  <div
                    key={`${highlight?.nonce}-${i}`}
                    ref={i === 0 ? firstRectRef : undefined}
                    aria-hidden
                    className="forma-hl pointer-events-none absolute rounded-sm border-[1.5px] border-primary bg-primary/20"
                    style={{
                      left: `${r.rect[0] * 100}%`,
                      top: `${r.rect[1] * 100}%`,
                      width: `${(r.rect[2] - r.rect[0]) * 100}%`,
                      height: `${(r.rect[3] - r.rect[1]) * 100}%`,
                    }}
                  />
                ))}
              </div>
            </Document>
          )}
        </div>
      </div>
    </div>
  );
}

function PageSkeleton({ width, bare = false }: { width: number; bare?: boolean }) {
  return (
    <Skeleton
      className={bare ? "rounded-none" : "mx-auto rounded-none shadow-sm ring-1 ring-black/5"}
      style={{ width, height: Math.round(width * 1.294) }}
    />
  );
}

/** Default export so the viewer (and pdfjs) can be lazy-loaded. */
export default PdfViewer;
