/**
 * Form answers persist ONLY to the browser's localStorage ("Late Context
 * Injection"): values never leave the device unless the user explicitly
 * opts in to sharing them with the assistant for a single message.
 */

export type FormValue = string | string[] | boolean;
export type FormValues = Record<string, FormValue>;

const SELECTED_FORM_KEY = "forma:selectedForm";

const formKey = (documentId: string): string => `forma:form:${documentId}`;

export function loadFormValues(documentId: string): FormValues {
  try {
    const raw = localStorage.getItem(formKey(documentId));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as FormValues;
    }
    return {};
  } catch {
    return {};
  }
}

export function saveFormValues(documentId: string, values: FormValues): void {
  try {
    localStorage.setItem(formKey(documentId), JSON.stringify(values));
  } catch {
    // Storage full or blocked — values still live in memory for this session.
  }
}

export function loadSelectedFormId(): string | null {
  try {
    return localStorage.getItem(SELECTED_FORM_KEY);
  } catch {
    return null;
  }
}

export function saveSelectedFormId(documentId: string | null): void {
  try {
    if (documentId) localStorage.setItem(SELECTED_FORM_KEY, documentId);
    else localStorage.removeItem(SELECTED_FORM_KEY);
  } catch {
    // Ignore.
  }
}
