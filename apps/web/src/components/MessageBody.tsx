import type { ReactNode } from "react";
import type { Citation } from "@forma/shared";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Lightweight, dependency-free renderer for assistant output: paragraphs,
 * bullet/numbered lists, `code`, **bold**, markdown-ish tables (as scrollable
 * monospace blocks) and — crucially — [n] citation markers rendered as
 * clickable superscript chips.
 */

type Block =
  | { kind: "p" | "h"; text: string }
  | { kind: "ul" | "ol"; items: string[] }
  | { kind: "table"; lines: string[] };

function parseBlocks(content: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flush = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "p", text: paragraph.join("\n") });
      paragraph = [];
    }
  };

  for (const line of content.split("\n")) {
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = /^#{1,4}\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "h", text: heading[1] });
      continue;
    }
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (bullet) {
      flush();
      const prev = blocks[blocks.length - 1];
      if (prev && prev.kind === "ul") prev.items.push(bullet[1]);
      else blocks.push({ kind: "ul", items: [bullet[1]] });
      continue;
    }
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      flush();
      const prev = blocks[blocks.length - 1];
      if (prev && prev.kind === "ol") prev.items.push(numbered[1]);
      else blocks.push({ kind: "ol", items: [numbered[1]] });
      continue;
    }
    if (line.trimStart().startsWith("|")) {
      flush();
      const prev = blocks[blocks.length - 1];
      if (prev && prev.kind === "table") prev.lines.push(line);
      else blocks.push({ kind: "table", lines: [line] });
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}

const INLINE_PATTERN = /\[(\d+)\]|\*\*([^*]+?)\*\*|`([^`]+?)`/g;

function renderInline(
  text: string,
  keyPrefix: string,
  citations: Citation[] | undefined,
  onCitationClick: (citation: Citation) => void,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  INLINE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = INLINE_PATTERN.exec(text)) !== null) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    if (match[1] !== undefined) {
      const n = Number(match[1]);
      const citation = citations?.find((c) => c.n === n);
      if (citation) {
        nodes.push(
          <CitationChip
            key={`${keyPrefix}-c${key++}`}
            citation={citation}
            onClick={() => onCitationClick(citation)}
          />,
        );
      } else {
        nodes.push(match[0]);
      }
    } else if (match[2] !== undefined) {
      nodes.push(<strong key={`${keyPrefix}-b${key++}`}>{match[2]}</strong>);
    } else if (match[3] !== undefined) {
      nodes.push(
        <code
          key={`${keyPrefix}-k${key++}`}
          className="rounded bg-muted px-1 py-0.5 font-mono text-[12px]"
        >
          {match[3]}
        </code>,
      );
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function CitationChip({ citation, onClick }: { citation: Citation; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={`Citation ${citation.n}: ${citation.documentTitle}`}
          className="mx-0.5 inline-flex min-w-4 -translate-y-[3px] items-center justify-center rounded bg-primary/10 px-1 text-[10px] font-semibold leading-4 text-primary outline-none transition-colors duration-150 hover:bg-primary hover:text-primary-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {citation.n}
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

interface MessageBodyProps {
  content: string;
  citations?: Citation[];
  streaming?: boolean;
  onCitationClick: (citation: Citation) => void;
}

export function MessageBody({ content, citations, streaming, onCitationClick }: MessageBodyProps) {
  const blocks = parseBlocks(content);

  return (
    <div className="space-y-2.5 text-sm leading-relaxed">
      {blocks.map((block, index) => {
        const key = `b${index}`;
        const isLast = index === blocks.length - 1;
        const caret = streaming && isLast ? <span className="forma-stream-caret" /> : null;

        switch (block.kind) {
          case "h":
            return (
              <p key={key} className="pt-1 font-semibold">
                {renderInline(block.text, key, citations, onCitationClick)}
                {caret}
              </p>
            );
          case "p":
            return (
              <p key={key} className="whitespace-pre-wrap">
                {renderInline(block.text, key, citations, onCitationClick)}
                {caret}
              </p>
            );
          case "ul":
          case "ol": {
            const List = block.kind === "ul" ? "ul" : "ol";
            return (
              <List
                key={key}
                className={
                  block.kind === "ul" ? "list-disc space-y-1 pl-5" : "list-decimal space-y-1 pl-5"
                }
              >
                {block.items.map((item, itemIndex) => (
                  <li key={`${key}-${itemIndex}`}>
                    {renderInline(item, `${key}-${itemIndex}`, citations, onCitationClick)}
                    {caret && itemIndex === block.items.length - 1 ? caret : null}
                  </li>
                ))}
              </List>
            );
          }
          case "table":
            return (
              <div key={key} className="overflow-x-auto rounded-lg border bg-muted/40 px-3 py-2">
                <pre className="font-mono text-xs leading-relaxed">{block.lines.join("\n")}</pre>
              </div>
            );
        }
      })}
      {blocks.length === 0 && streaming && (
        <p>
          <span className="forma-stream-caret" />
        </p>
      )}
    </div>
  );
}
