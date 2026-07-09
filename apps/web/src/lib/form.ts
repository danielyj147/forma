import type { FieldCondition, FormContextEntry, FormField, FormSchema } from "@forma/shared";
import type { FormValue, FormValues } from "./storage";

export function isFilled(value: FormValue | undefined): boolean {
  if (value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.length > 0;
  return value.trim().length > 0;
}

/** Evaluate an XLSForm-style relevance condition against current values. */
export function conditionMet(cond: FieldCondition, values: FormValues): boolean {
  const value = values[cond.field];
  if (cond.equals !== undefined) {
    if (typeof cond.equals === "boolean") return value === cond.equals;
    if (Array.isArray(value)) return value.includes(cond.equals);
    return value === cond.equals;
  }
  if (cond.in !== undefined) {
    if (Array.isArray(value)) return value.some((v) => cond.in!.includes(v));
    return typeof value === "string" && cond.in.includes(value);
  }
  return true;
}

/** Skip-logic: a field with visibleIf renders only when its condition holds. */
export function isFieldVisible(field: FormField, values: FormValues): boolean {
  return field.visibleIf ? conditionMet(field.visibleIf, values) : true;
}

/** Effective required state: static `required` plus conditional `requiredIf`. */
export function isFieldRequired(field: FormField, values: FormValues): boolean {
  if (field.required) return true;
  if (field.requiredIf) return conditionMet(field.requiredIf, values);
  return false;
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
 * File fields are excluded — file contents never leave the browser. Fields
 * hidden by skip-logic are excluded even if they hold stale values.
 */
export function buildFormContext(schema: FormSchema, values: FormValues): FormContextEntry[] {
  const entries: FormContextEntry[] = [];
  for (const section of schema.sections) {
    for (const field of section.fields) {
      if (field.type === "file") continue;
      if (!isFieldVisible(field, values)) continue;
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
      if (!isFieldVisible(field, values)) continue;
      if (!isFieldRequired(field, values)) continue;
      total += 1;
      if (isFilled(values[field.id])) done += 1;
    }
  }
  return { done, total };
}
