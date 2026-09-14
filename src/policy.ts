import { Context, Effect, Layer } from "effect";
import { Fault, type Auth, type Work } from "./domain.js";
export class Policy extends Context.Service<
  Policy,
  {
    current: (
      tenant: string,
      actor: string,
      thread: string,
    ) => Effect.Effect<Auth, Fault>;
  }
>()("action-space/Policy") {
  static layer = (principals: Auth[]) =>
    Layer.effect(
      Policy,
      Effect.gen(function* () {
        return Policy.of({
          current: Effect.fn("Policy.current")(
            function* (tenant, actor, thread) {
              const auth = principals.find(
                (x) =>
                  x.tenant === tenant &&
                  x.actor === actor &&
                  x.thread === thread,
              );
              if (!auth) return yield* new Fault("DENIED");
              return auth;
            },
          ),
        });
      }),
    );
}
export function requireGrant(
  auth: Auth,
  work: Pick<Work, "call">,
  connectorGrant?: string,
): void {
  const grant =
    work.call.action === "connector.call"
      ? connectorGrant
      : work.call.action.startsWith("context.")
        ? "context.manage"
        : work.call.action;
  if (!grant || !auth.grants.includes(grant)) throw new Fault("DENIED");
}
