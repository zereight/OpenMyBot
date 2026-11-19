export type RendererDiagnosticEvent =
  | { kind: "renderer-error"; origin: "error" | "unhandledrejection" | "error-boundary"; error?: { name?: string } }
  | { kind: "api-timeout"; method: string; timeoutMs: number };

function errorName(value: unknown): string {
  if (value && typeof value === "object" && "name" in value && typeof (value as { name?: unknown }).name === "string") {
    return (value as { name: string }).name;
  }
  return "Error";
}

export function reportRendererDiagnostic(event: RendererDiagnosticEvent): void {
  try {
    if (typeof window === "undefined") return;
    window.ogb?.reportDiagnostic?.(event);
  } catch {
  }
}

export function installRendererErrorDiagnostics(
  target: Pick<Window, "addEventListener" | "removeEventListener"> | undefined = typeof window === "undefined" ? undefined : window,
): () => void {
  if (!target) return () => {};
  const onError = (event: Event) => {
    const err = (event as ErrorEvent).error;
    reportRendererDiagnostic({ kind: "renderer-error", origin: "error", error: { name: errorName(err) } });
  };
  const onRejection = (event: Event) => {
    const reason = (event as PromiseRejectionEvent).reason;
    reportRendererDiagnostic({ kind: "renderer-error", origin: "unhandledrejection", error: { name: errorName(reason) } });
  };
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}
