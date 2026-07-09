import type { DocumentSummary } from "@forma/shared";
import { ChevronRightIcon, FileTextIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

interface FormPickerProps {
  documents: DocumentSummary[];
  onSelect: (documentId: string) => void;
}

/** Searchable list of ingested applications — the entry point of the demo. */
export function FormPicker({ documents, onSelect }: FormPickerProps) {
  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-col gap-5 overflow-y-auto px-4 py-6 lg:px-6 lg:py-8">
      <div className="flex flex-col gap-1.5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
          Applications
        </p>
        <h2 className="font-heading text-2xl font-semibold tracking-tight">
          Start an application
        </h2>
        <p className="max-w-md text-[13px] leading-relaxed text-muted-foreground">
          Every form below began as a state licensing PDF. Forma converts each one into a
          structured web form, grounded in the original document.
        </p>
      </div>

      <Command className="h-auto shrink-0 rounded-xl bg-card pb-1 ring-1 ring-foreground/10">
        <CommandInput placeholder="Search by title, state, or license type…" autoFocus />
        <CommandList className="max-h-none">
          <CommandEmpty>
            <span className="text-muted-foreground">No forms match that search.</span>
          </CommandEmpty>
          {documents.map((doc) => (
            <CommandItem
              key={doc.id}
              value={`${doc.title} ${doc.state ?? ""} ${doc.licenseType ?? ""}`}
              onSelect={() => onSelect(doc.id)}
              className="group/picker-row items-center gap-3 rounded-lg px-3 py-3"
            >
              <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <FileTextIcon className="size-4" aria-hidden />
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="truncate text-sm font-medium">{doc.title}</span>
                <span className="flex flex-wrap items-center gap-1.5">
                  {doc.state && (
                    <Badge variant="outline" className="bg-card text-muted-foreground">
                      {doc.state}
                    </Badge>
                  )}
                  {doc.licenseType && <Badge variant="secondary">{doc.licenseType}</Badge>}
                  {doc.pageCount != null && (
                    <span className="text-xs text-muted-foreground">{doc.pageCount} pages</span>
                  )}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-2 self-center">
                {doc.hasFormSchema ? (
                  <Badge className="border-transparent bg-primary/10 text-primary">Form ready</Badge>
                ) : (
                  <Badge variant="outline" className="text-muted-foreground">PDF only</Badge>
                )}
                <ChevronRightIcon
                  className="size-4 text-muted-foreground/50 transition-transform duration-150 group-data-selected/picker-row:translate-x-0.5"
                  aria-hidden
                />
              </div>
            </CommandItem>
          ))}
        </CommandList>
      </Command>

      <p className="text-center text-xs text-muted-foreground">
        {documents.length} document{documents.length === 1 ? "" : "s"} ingested · answers cite exact
        pages and coordinates
      </p>
    </div>
  );
}
