import { Badge } from "@/components/ui/badge";

export function TopBar() {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b bg-card px-4 lg:px-6">
      <div className="flex items-baseline gap-3">
        <span className="font-heading text-xl font-semibold tracking-tight">
          Forma<span className="text-primary">.</span>
        </span>
        <span className="hidden text-xs font-medium tracking-wide text-muted-foreground sm:inline">
          Licensing as a Service
        </span>
      </div>
      <Badge variant="outline" className="gap-1.5 font-normal text-muted-foreground">
        <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden />
        Demo
      </Badge>
    </header>
  );
}
