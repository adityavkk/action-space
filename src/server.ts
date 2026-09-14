import { ConfigProvider, Effect, Layer } from "effect";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfiguration } from "./configuration.js";
import { serve } from "./http.js";
import { telemetryExport } from "./observability.js";
import { platformLayer } from "./runtime.js";
import { Fault } from "./domain.js";

const app = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* loadConfiguration();
    return Layer.effectDiscard(serve(config)).pipe(
      Layer.provide(platformLayer(config)),
    );
  }),
).pipe(Layer.provide(telemetryExport));
export function runServer(provider = ConfigProvider.fromUnknown(process.env)) {
  const shutdown = new AbortController();
  process.once("SIGTERM", () => shutdown.abort());
  process.once("SIGINT", () => shutdown.abort());
  return Effect.runPromise(
    Layer.launch(app.pipe(Layer.provide(ConfigProvider.layer(provider)))),
    { signal: shutdown.signal },
  ).catch((error) => {
    if (!shutdown.signal.aborted) {
      console.error(
        error instanceof Fault && error.code === "LEGACY_JOURNAL"
          ? "LEGACY_JOURNAL: Preserve the retired-format database and select a fresh ACTION_SPACE_DATA or DATABASE_URL. No evidence migration was performed."
          : "Action Space startup failed. Check configuration, credentials and database ownership; no secrets were logged.",
      );
      process.exitCode = 1;
    }
  });
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  void runServer();
}
