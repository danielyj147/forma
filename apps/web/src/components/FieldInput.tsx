import { useId, useState } from "react";
import type { FormField } from "@forma/shared";
import { ArrowUpRightIcon, PaperclipIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { FormValue } from "@/lib/storage";
import { cn } from "@/lib/utils";

interface FieldInputProps {
  field: FormField;
  value: FormValue | undefined;
  /** Effective required state (static `required` OR a met `requiredIf`). */
  required: boolean;
  onChange: (value: FormValue) => void;
  /** Highlight this field's source rects in the PDF viewer. */
  onShowSource: (field: FormField) => void;
}

export function FieldInput({ field, value, required, onChange, onShowSource }: FieldInputProps) {
  const inputId = useId();
  const hasSource = Boolean(field.source && field.source.length > 0);
  const options = (field.options ?? []).filter((option) => option.value !== "");
  const groupLike = field.type === "radio" || (field.type === "checkbox" && options.length > 0);

  return (
    <div
      className="group/field flex flex-col gap-1.5"
      onFocusCapture={hasSource ? () => onShowSource(field) : undefined}
    >
      <div className="flex min-h-6 items-center justify-between gap-2">
        <Label
          htmlFor={groupLike ? undefined : inputId}
          className="gap-1 text-[13px] leading-snug"
        >
          {field.label}
          {required && (
            <span className="text-primary" aria-label="required">
              *
            </span>
          )}
        </Label>
        {hasSource && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            tabIndex={-1}
            className="shrink-0 text-primary opacity-0 transition-opacity duration-150 hover:bg-primary/10 hover:text-primary group-focus-within/field:opacity-100 group-hover/field:opacity-100"
            onClick={() => onShowSource(field)}
          >
            View in document
            <ArrowUpRightIcon data-icon="inline-end" aria-hidden />
          </Button>
        )}
      </div>

      <FieldControl
        field={field}
        value={value}
        onChange={onChange}
        inputId={inputId}
        options={options}
      />

      {field.help && <p className="text-xs leading-relaxed text-muted-foreground">{field.help}</p>}
    </div>
  );
}

interface FieldControlProps {
  field: FormField;
  value: FormValue | undefined;
  onChange: (value: FormValue) => void;
  inputId: string;
  options: NonNullable<FormField["options"]>;
}

function FieldControl({ field, value, onChange, inputId, options }: FieldControlProps) {
  const text = typeof value === "string" ? value : "";

  switch (field.type) {
    case "text":
    case "number":
    case "date":
      return (
        <Input
          id={inputId}
          type={field.type}
          placeholder={field.placeholder}
          value={text}
          onChange={(event) => onChange(event.target.value)}
        />
      );

    case "textarea":
      return (
        <Textarea
          id={inputId}
          rows={3}
          placeholder={field.placeholder}
          value={text}
          onChange={(event) => onChange(event.target.value)}
          className="min-h-20 resize-none leading-relaxed"
        />
      );

    case "select":
      return (
        <Select value={text === "" ? undefined : text} onValueChange={onChange}>
          <SelectTrigger id={inputId} className="w-full bg-card">
            <SelectValue placeholder={field.placeholder ?? "Select an option"} />
          </SelectTrigger>
          <SelectContent position="popper" sideOffset={4}>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );

    case "radio":
      return (
        <RadioGroup value={text} onValueChange={onChange} className="gap-2 pt-0.5">
          {options.map((option) => {
            const optionId = `${inputId}-${option.value}`;
            return (
              <div key={option.value} className="flex items-center gap-2.5">
                <RadioGroupItem value={option.value} id={optionId} />
                <Label htmlFor={optionId} className="text-[13px] font-normal leading-snug">
                  {option.label}
                </Label>
              </div>
            );
          })}
        </RadioGroup>
      );

    case "checkbox": {
      if (options.length === 0) {
        return (
          <div className="flex items-center gap-2.5 pt-0.5">
            <Checkbox
              id={inputId}
              checked={value === true}
              onCheckedChange={(checked) => onChange(checked === true)}
            />
            <Label htmlFor={inputId} className="text-[13px] font-normal leading-snug">
              {field.placeholder ?? "Yes"}
            </Label>
          </div>
        );
      }
      const selected = Array.isArray(value) ? value : [];
      return (
        <div className="flex flex-col gap-2 pt-0.5">
          {options.map((option) => {
            const optionId = `${inputId}-${option.value}`;
            const checked = selected.includes(option.value);
            return (
              <div key={option.value} className="flex items-center gap-2.5">
                <Checkbox
                  id={optionId}
                  checked={checked}
                  onCheckedChange={(next) =>
                    onChange(
                      next === true
                        ? [...selected, option.value]
                        : selected.filter((v) => v !== option.value),
                    )
                  }
                />
                <Label htmlFor={optionId} className="text-[13px] font-normal leading-snug">
                  {option.label}
                </Label>
              </div>
            );
          })}
        </div>
      );
    }

    case "file":
      return <FileControl field={field} inputId={inputId} />;
  }
}

/** Visual-only attachment control — nothing ever uploads in this demo. */
function FileControl({ field, inputId }: { field: FormField; inputId: string }) {
  const [fileName, setFileName] = useState<string | null>(null);

  return (
    <label
      htmlFor={inputId}
      className={cn(
        "flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-input bg-background px-3 py-2.5",
        "transition-colors duration-150 hover:border-primary/50 hover:bg-primary/[0.03]",
        "has-[:focus-visible]:border-ring has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50",
      )}
    >
      <PaperclipIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className={cn("truncate text-[13px]", fileName ? "font-medium" : "text-muted-foreground")}>
          {fileName ?? field.placeholder ?? "Choose a file"}
        </span>
        <span className="text-xs text-muted-foreground">
          Stays on your device — nothing is uploaded in this demo.
        </span>
      </span>
      <input
        id={inputId}
        type="file"
        className="sr-only"
        onChange={(event) => setFileName(event.target.files?.[0]?.name ?? null)}
      />
    </label>
  );
}
