import { Effect } from "effect";
import { Fault, Interrupt, Uncertain, type ExecutionError } from "./domain.js";
export function classify(cause: unknown): ExecutionError {
  return cause instanceof Fault ||
    cause instanceof Interrupt ||
    cause instanceof Uncertain
    ? cause
    : new Fault("INTERNAL_ERROR");
}
/** Promise libraries terminate here; application workflows stay in the typed Effect channel. */
export const external = <A>(
  operation: string,
  run: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, ExecutionError> =>
  Effect.tryPromise({ try: run, catch: classify }).pipe(
    Effect.withSpan(operation),
  );
