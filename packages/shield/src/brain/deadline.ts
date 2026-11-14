/** Execution deadline, never a delayed response-ladder wait. */
export async function withDeadline<T>(ms: number, work: (signal: AbortSignal) => Promise<T>, outer?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  outer?.addEventListener("abort", abort, { once: true });
  if (outer?.aborted) controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const stopped = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error("Shield execution timeout or cancellation"));
      controller.signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(abort, ms);
      if (controller.signal.aborted) onAbort();
    });
    return await Promise.race([stopped, Promise.resolve().then(() => {
      controller.signal.throwIfAborted(); return work(controller.signal);
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    outer?.removeEventListener("abort", abort);
    if (onAbort) controller.signal.removeEventListener("abort", onAbort);
    controller.abort();
  }
}
