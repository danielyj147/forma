import { useState } from "react";
import type { FormEvent } from "react";
import { LockIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api";

interface AccessGateProps {
  /** Stores the code and re-checks the API; throws ApiError on failure. */
  onUnlock: (code: string) => Promise<void>;
}

export function AccessGate({ onUnlock }: AccessGateProps) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!code.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onUnlock(code.trim());
    } catch (err) {
      if (err instanceof ApiError && err.isAccessRequired) {
        setError("That code wasn't accepted. Check it and try again.");
      } else if (err instanceof ApiError && err.isNetwork) {
        setError("Could not reach the API. Is the backend running?");
      } else {
        setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <span className="font-heading text-lg font-semibold tracking-tight">
            Forma<span className="text-primary">.</span>
          </span>
          <CardTitle className="mt-2 flex items-center gap-2 font-heading">
            <LockIcon className="size-4 text-muted-foreground" aria-hidden />
            Access required
          </CardTitle>
          <CardDescription className="text-[13px] leading-relaxed">
            This demo is protected. Enter the access code you were given to continue.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-3">
            <Input
              type="password"
              autoFocus
              autoComplete="off"
              placeholder="Access code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              aria-label="Access code"
              aria-invalid={error ? true : undefined}
            />
            {error && <p className="text-xs leading-relaxed text-destructive">{error}</p>}
            <Button type="submit" disabled={busy || !code.trim()} className="w-full">
              {busy ? "Checking…" : "Unlock"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
