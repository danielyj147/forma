import type { DocumentSummary, FormField, FormSchema } from "@forma/shared";
import { ArrowLeftIcon, FileTextIcon, LockIcon, MessageCircleIcon, RefreshCwIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { FieldInput } from "@/components/FieldInput";
import { isFieldRequired, isFieldVisible, requiredProgress } from "@/lib/form";
import type { FormValue, FormValues } from "@/lib/storage";

export type SchemaState =
  | { status: "loading" }
  | { status: "none" }
  | { status: "error"; message: string }
  | { status: "ready"; schema: FormSchema };

interface FormPanelProps {
  doc: DocumentSummary;
  schemaState: SchemaState;
  values: FormValues;
  onValueChange: (fieldId: string, value: FormValue) => void;
  onShowSource: (field: FormField) => void;
  onBack: () => void;
  onRetry: () => void;
  onAskAssistant: () => void;
}

export function FormPanel({
  doc,
  schemaState,
  values,
  onValueChange,
  onShowSource,
  onBack,
  onRetry,
  onAskAssistant,
}: FormPanelProps) {
  const progress =
    schemaState.status === "ready" ? requiredProgress(schemaState.schema, values) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Compact header: back to picker + form identity + completion meter */}
      <div className="flex shrink-0 flex-col gap-2.5 border-b bg-card px-4 pb-3 pt-2.5 lg:px-6">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onBack}
            className="-ml-2 shrink-0 text-muted-foreground hover:text-foreground"
          >
            <ArrowLeftIcon data-icon="inline-start" aria-hidden />
            All forms
          </Button>
          <Separator orientation="vertical" className="data-vertical:h-4 data-vertical:self-center" />
          <span className="min-w-0 truncate text-[13px] font-medium" title={doc.title}>
            {doc.title}
          </span>
          <span className="hidden shrink-0 items-center gap-1.5 md:flex">
            {doc.state && (
              <Badge variant="outline" className="text-muted-foreground">
                {doc.state}
              </Badge>
            )}
            {doc.licenseType && <Badge variant="secondary">{doc.licenseType}</Badge>}
          </span>
        </div>
        {progress && progress.total > 0 && (
          <div className="flex items-center gap-3">
            <Progress
              value={(progress.done / progress.total) * 100}
              className="h-1.5 flex-1"
              aria-label="Required fields completed"
            />
            <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
              {progress.done} of {progress.total} required complete
            </span>
          </div>
        )}
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-5 lg:px-6">
          {schemaState.status === "loading" && <FormSkeleton />}

          {schemaState.status === "error" && (
            <Alert variant="destructive">
              <AlertTitle>Couldn't load this form</AlertTitle>
              <AlertDescription>{schemaState.message}</AlertDescription>
              <div className="mt-3">
                <Button variant="outline" size="sm" onClick={onRetry}>
                  <RefreshCwIcon data-icon="inline-start" aria-hidden />
                  Try again
                </Button>
              </div>
            </Alert>
          )}

          {schemaState.status === "none" && (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-12 text-center">
              <div className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <FileTextIcon className="size-5" aria-hidden />
              </div>
              <div>
                <p className="text-sm font-medium">No form for this document yet</p>
                <p className="mx-auto mt-1 max-w-xs text-[13px] leading-relaxed text-muted-foreground">
                  Ingestion hasn't produced a form schema for this PDF. You can still read it in
                  the viewer, or ask the assistant about its contents.
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={onAskAssistant}>
                <MessageCircleIcon data-icon="inline-start" aria-hidden />
                Ask the assistant
              </Button>
            </div>
          )}

          {schemaState.status === "ready" && (
            <>
              {schemaState.schema.sections.map((section) => (
                <Card key={section.id}>
                  <CardHeader className="border-b">
                    <CardTitle className="font-heading text-[15px] font-semibold tracking-tight">
                      {section.title}
                    </CardTitle>
                    {section.description && (
                      <CardDescription className="text-[13px] leading-relaxed">
                        {section.description}
                      </CardDescription>
                    )}
                  </CardHeader>
                  <CardContent className="flex flex-col gap-5">
                    {section.fields.filter((field) => isFieldVisible(field, values)).map((field) => (
                      <FieldInput
                        key={field.id}
                        field={field}
                        value={values[field.id]}
                        required={isFieldRequired(field, values)}
                        onChange={(value) => onValueChange(field.id, value)}
                        onShowSource={onShowSource}
                      />
                    ))}
                  </CardContent>
                </Card>
              ))}
              <p className="flex items-center justify-center gap-1.5 pb-2 pt-1 text-center text-xs text-muted-foreground">
                <LockIcon className="size-3 shrink-0" aria-hidden />
                Your answers stay in your browser — shared only if you opt in from the assistant.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function FormSkeleton() {
  return (
    <>
      {[0, 1].map((i) => (
        <Card key={i}>
          <CardHeader className="border-b">
            <Skeleton className="h-4 w-44" />
            <Skeleton className="h-3 w-72 max-w-full" />
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            {[0, 1, 2].map((j) => (
              <div key={j} className="flex flex-col gap-1.5">
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="h-8 w-full" />
              </div>
            ))}
          </CardContent>
        </Card>
      ))}
    </>
  );
}
