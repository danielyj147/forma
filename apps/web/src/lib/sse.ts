import type { ChatEvent, ChatRequest } from "@forma/shared";
import { ApiError, apiHeaders, toApiError } from "./api";

/**
 * POST /api/chat and stream Server-Sent Events.
 *
 * Each SSE message is a `data: <json>` line where the JSON is a ChatEvent.
 * EventSource cannot POST, so we read the response body manually, splitting
 * on blank lines ("\n\n") and stripping the "data:" prefix.
 */
export async function streamChat(
  request: ChatRequest,
  onEvent: (event: ChatEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch("/api/chat", {
      method: "POST",
      headers: apiHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(request),
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError("Could not reach the Forma API.", 0);
  }
  if (!res.ok) throw await toApiError(res);
  if (!res.body) throw new ApiError("The API returned an empty stream.", 0);

  const emitBlock = (block: string): void => {
    for (const line of block.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trimStart();
      if (!payload) continue;
      try {
        onEvent(JSON.parse(payload) as ChatEvent);
      } catch {
        // Skip malformed frames rather than killing the stream.
      }
    }
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let separator: number;
    while ((separator = buffer.indexOf("\n\n")) !== -1) {
      emitBlock(buffer.slice(0, separator));
      buffer = buffer.slice(separator + 2);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) emitBlock(buffer);
}
