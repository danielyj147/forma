import type { FormContextEntry, FormField, FormSchema } from "@forma/shared";
import type { FormValue, FormValues } from "./storage";

export function isFilled(value: FormValue | undefined): boolean {
  if (value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.length > 0;
  return value.trim().length > 0;
}

/** Human-readable rendering of a stored value (option labels, Yes/No, …). */
export function displayValue(field: FormField, value: FormValue): string {
  const optionLabel = (v: string): string =>
    field.options?.find((option) => option.value === v)?.label ?? v;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.map(optionLabel).join(", ");
  if (field.type === "select" || field.type === "radio") return optionLabel(value);
  return value;
}

/**
 * Build the ephemeral, per-message form context from FILLED fields only.
 * File fields are excluded — file contents never leave the browser.
 */
export function buildFormContext(schema: FormSchema, values: FormValues): FormContextEntry[] {
  const entries: FormContextEntry[] = [];
  for (const section of schema.sections) {
    for (const field of section.fields) {
      if (field.type === "file") continue;
      const value = values[field.id];
      if (value === undefined || !isFilled(value)) continue;
      entries.push({ label: field.label, value: displayValue(field, value) });
    }
  }
  return entries;
}

export function requiredProgress(
  schema: FormSchema,
  values: FormValues,
): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const section of schema.sections) {
    for (const field of section.fields) {
      if (!field.required) continue;
      total += 1;
      if (isFilled(values[field.id])) done += 1;
    }
  }
  return { done, total };
}
