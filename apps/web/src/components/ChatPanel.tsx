import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type {
  ChatMessage,
  ChatRequest,
  Citation,
  DocumentSummary,
  FormContextEntry,
} from "@forma/shared";
import {
  ArrowUpIcon,
  CircleAlertIcon,
  LoaderCircleIcon,
  LockIcon,
  SparklesIcon,
  SquareIcon,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MessageBody } from "@/components/MessageBody";
import { ApiError } from "@/lib/api";
import { streamChat } from "@/lib/sse";
import { cn } from "@/lib/utils";

interface ChatMsg {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  status?: "pending" | "streaming" | "done" | "error";
  error?: string;
  routing?: { needsRetrieval: boolean; model: string };
  sharedContext?: boolean;
}

const SUGGESTIONS: Array<{ q: string; share?: boolean }> = [
  { q: "What is the application fee?" },
  { q: "What are the surety bond requirements?" },
  { q: "List every document I must attach." },
  { q: "Am I eligible based on my answers?", share: true },
];

interface ChatPanelProps {
  /** The form selected in the Application tab (source of shared answers). */
  selectedForm: DocumentSummary | null;
  getFormContext: () => FormContextEntry[];
  onCitationClick: (citation: Citation) => void;
}

export function ChatPanel({ selectedForm, getFormContext, onCitationClick }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [shareAnswers, setShareAnswers] = useState(false);

  const messagesRef = useRef<ChatMsg[]>(messages);
  messagesRef.current = messages;
  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  // Abort any in-flight stream on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  // Follow the stream unless the user scrolled away from the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const handleScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const send = useCallback(
    async (raw: string, options?: { forceShare?: boolean }) => {
      const text = raw.trim();
      if (!text || busyRef.current) return;

      const share = (options?.forceShare === true || shareAnswers) && selectedForm !== null;
      if (options?.forceShare && selectedForm) setShareAnswers(true);

      const history: ChatMessage[] = [
        ...messagesRef.current
          .filter((m) => m.status !== "error" && m.content.trim() !== "")
          .map((m): ChatMessage => ({ role: m.role, content: m.content })),
        { role: "user", content: text },
      ];
      const formContext = share ? getFormContext() : [];
      const request: ChatRequest = {
        messages: history,
        ...(formContext.length > 0 ? { formContext } : {}),
      };

      const assistantId = crypto.randomUUID();
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "user",
          content: text,
          sharedContext: formContext.length > 0,
        },
        { id: assistantId, role: "assistant", content: "", status: "pending" },
      ]);
      setInput("");
      setBusy(true);
      busyRef.current = true;
      stickToBottomRef.current = true;

      const controller = new AbortController();
      abortRef.current = controller;
      const update = (fn: (m: ChatMsg) => ChatMsg): void =>
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? fn(m) : m)));

      try {
        await streamChat(
          request,
          (event) => {
            switch (event.type) {
              case "routing":
                update((m) => ({
                  ...m,
                  routing: { needsRetrieval: event.needsRetrieval, model: event.model },
                }));
                break;
              case "sources":
                update((m) => ({ ...m, citations: event.citations }));
                break;
              case "delta":
                update((m) => ({ ...m, content: m.content + event.text, status: "streaming" }));
                break;
              case "done":
                update((m) => ({ ...m, status: "done" }));
                break;
              case "error":
                update((m) => ({ ...m, status: "error", error: event.message }));
                break;
            }
          },
          controller.signal,
        );
        update((m) => (m.status === "done" || m.status === "error" ? m : { ...m, status: "done" }));
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          update((m) =>
            m.content
              ? { ...m, status: "done" }
              : { ...m, status: "error", error: "Generation stopped." },
          );
        } else {
          const message =
            err instanceof ApiError
              ? err.message
              : "Something went wrong while contacting the assistant.";
          update((m) => ({ ...m, status: "error", error: message }));
        }
      } finally {
        setBusy(false);
        busyRef.current = false;
        abortRef.current = null;
      }
    },
    [shareAnswers, selectedForm, getFormContext],
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send(input);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Thread */}
      <div ref={scrollRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-y-auto">
        {messages.length === 0 ? (
          <EmptyThread onAsk={(q, share) => void send(q, { forceShare: share })} />
        ) : (
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 py-5 lg:px-6">
            {messages.map((message) =>
              message.role === "user" ? (
                <UserMessage key={message.id} message={message} />
              ) : (
                <AssistantMessage
                  key={message.id}
                  message={message}
                  onCitationClick={onCitationClick}
                />
              ),
            )}
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="shrink-0 border-t bg-card px-4 pb-3.5 pt-2.5 lg:px-6">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-2.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Switch
              id="share-answers"
              size="sm"
              checked={shareAnswers && selectedForm !== null}
              onCheckedChange={setShareAnswers}
              disabled={selectedForm === null}
            />
            <Label
              htmlFor="share-answers"
              className={cn(
                "gap-1.5 text-xs font-normal",
                selectedForm === null && "text-muted-foreground",
              )}
            >
              <LockIcon className="size-3 text-muted-foreground" aria-hidden />
              Share my form answers with the assistant
            </Label>
            <span className="ml-auto text-[11px] text-muted-foreground">
              {selectedForm === null
                ? "Select a form in Application first"
                : shareAnswers
                  ? "Sent only with this message — never stored."
                  : ""}
            </span>
          </div>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              void send(input);
            }}
            className="flex items-end gap-2 rounded-xl border bg-background p-2 transition-[border-color,box-shadow] duration-150 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30"
          >
            <Textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleKeyDown}
              rows={1}
              placeholder="Ask about fees, bonds, eligibility, attachments…"
              aria-label="Message the assistant"
              className="max-h-36 min-h-0 flex-1 resize-none border-0 bg-transparent px-1.5 py-1 shadow-none focus-visible:border-transparent focus-visible:ring-0"
            />
            {busy ? (
              <Button
                type="button"
                variant="secondary"
                size="icon-sm"
                aria-label="Stop generating"
                onClick={() => abortRef.current?.abort()}
              >
                <SquareIcon className="size-3 fill-current" aria-hidden />
              </Button>
            ) : (
              <Button type="submit" size="icon-sm" disabled={!input.trim()} aria-label="Send message">
                <ArrowUpIcon aria-hidden />
              </Button>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}

function EmptyThread({ onAsk }: { onAsk: (question: string, share?: boolean) => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 px-6 py-10">
      <div className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <SparklesIcon className="size-5" aria-hidden />
      </div>
      <div className="text-center">
        <h2 className="font-heading text-lg font-semibold tracking-tight">
          Ask about any ingested document
        </h2>
        <p className="mx-auto mt-1.5 max-w-sm text-[13px] leading-relaxed text-muted-foreground">
          Answers are grounded in the source PDFs with page-level citations. If it isn't in the
          documents, Forma says so.
        </p>
      </div>
      <div className="grid w-full max-w-sm gap-2">
        {SUGGESTIONS.map((suggestion) => (
          <Button
            key={suggestion.q}
            variant="outline"
            className="h-auto justify-start gap-2 whitespace-normal px-3 py-2 text-left text-[13px] font-normal"
            onClick={() => onAsk(suggestion.q, suggestion.share)}
          >
            {suggestion.share && <LockIcon className="size-3.5 shrink-0 text-primary" aria-hidden />}
            {suggestion.q}
          </Button>
        ))}
      </div>
    </div>
  );
}

function UserMessage({ message }: { message: ChatMsg }) {
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-xl rounded-br-sm bg-secondary px-3.5 py-2 text-sm leading-relaxed">
        {message.content}
      </div>
      {message.sharedContext && (
        <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <LockIcon className="size-2.5" aria-hidden />
          Form answers included with this message
        </span>
      )}
    </div>
  );
}

function AssistantMessage({
  message,
  onCitationClick,
}: {
  message: ChatMsg;
  onCitationClick: (citation: Citation) => void;
}) {
  const waiting = message.status === "pending";

  return (
    <div className="flex flex-col gap-2">
      {waiting && (
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <LoaderCircleIcon className="size-3.5 animate-spin text-primary" aria-hidden />
          <span>
            {message.routing
              ? message.routing.needsRetrieval
                ? "Searching documents…"
                : "Answering…"
              : "Thinking…"}
          </span>
          {message.routing && (
            <span className="font-mono text-[10px] text-muted-foreground/70">
              {message.routing.model}
            </span>
          )}
        </div>
      )}

      {message.content !== "" && (
        <MessageBody
          content={message.content}
          citations={message.citations}
          streaming={message.status === "streaming"}
          onCitationClick={onCitationClick}
        />
      )}

      {message.status === "error" && (
        <Alert variant="destructive">
          <CircleAlertIcon aria-hidden />
          <AlertTitle>The assistant hit a snag</AlertTitle>
          <AlertDescription className="text-[13px]">{message.error}</AlertDescription>
        </Alert>
      )}

      {message.citations && message.citations.length > 0 && message.status !== "pending" && (
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            Sources
          </span>
          {message.citations.map((citation) => (
            <SourceChip
              key={citation.n}
              citation={citation}
              onClick={() => onCitationClick(citation)}
            />
          ))}
          {message.routing && message.status === "done" && (
            <span className="ml-auto font-mono text-[10px] text-muted-foreground/60">
              {message.routing.model}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function SourceChip({ citation, onClick }: { citation: Citation; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          className="inline-flex max-w-56 items-center gap-1 rounded-md border bg-card px-1.5 py-0.5 text-[11px] text-muted-foreground outline-none transition-colors duration-150 hover:border-primary/40 hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <span className="font-semibold text-primary">{citation.n}</span>
          <span className="truncate">{citation.documentTitle}</span>
          {citation.page != null && (
            <span className="shrink-0 text-muted-foreground/70">p.{citation.page}</span>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="block max-w-72 px-3 py-2">
        <span className="block text-xs font-medium">
          {citation.documentTitle}
          {citation.page != null && <span className="opacity-70"> · p. {citation.page}</span>}
        </span>
        {citation.snippet && (
          <span className="mt-1 line-clamp-4 block text-xs leading-relaxed opacity-80">
            {citation.snippet}
          </span>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
