/** Trusted local container bootstrap. Never load this module into the guest runtime. */
import { Config, ConfigProvider, Effect } from "effect";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Journal } from "../src/journal.js";
import { Fault } from "../src/domain.js";
import { external } from "../src/effects.js";

const readSecret = (directory: string, name: string) =>
  external("Local.readSecret", async () => {
    const path = resolve(directory, name);
    const stat = await lstat(path);
    const value = (await readFile(path, "utf8")).trim();
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      !/^[a-f0-9]{64}$/.test(value)
    )
      throw new Fault(
        "INVALID_LOCAL_SECRET",
        "Preserve the volume and repair its secret permissions/content explicitly",
      );
    return value;
  });

export const initializeSecrets = Effect.fn("Local.initializeSecrets")(
  function* (directory: string) {
    yield* external("Local.secretDirectory", () =>
      mkdir(directory, { recursive: true, mode: 0o700 }),
    );
    for (const name of [
      "api-token",
      "postgres-password",
      "api-blue-token",
      "mcp-red-token",
      "mcp-blue-token",
    ]) {
      yield* external("Local.createSecret", async () => {
        try {
          await writeFile(
            resolve(directory, name),
            `${randomBytes(32).toString("hex")}\n`,
            { flag: "wx", mode: 0o600 },
          );
        } catch (error) {
          if (
            !(
              error instanceof Error &&
              "code" in error &&
              error.code === "EEXIST"
            )
          )
            throw error;
        }
      });
      yield* readSecret(directory, name);
    }
  },
);

const main = Effect.fn("Local.container")(function* () {
  const command = process.argv[2] ?? "serve";
  const directory = yield* Config.string("ACTION_SPACE_SECRETS").pipe(
    Config.withDefault("/run/action-space-secrets"),
  );
  if (command === "init") {
    yield* initializeSecrets(directory);
    yield* Effect.logInfo(
      "Local credentials initialized; existing secrets preserved",
    );
    return;
  }
  const token = yield* readSecret(directory, "api-token");
  if (command === "token") {
    // Explicit human-requested token access only; startup and demo never print secrets.
    process.stdout.write(`${token}\n`);
    return;
  }
  const environment = {
    ...process.env,
    ACTION_SPACE_TOKEN: token,
    MCP_BLUE_API_TOKEN: yield* readSecret(directory, "api-blue-token"),
    MCP_RED_TOKEN: yield* readSecret(directory, "mcp-red-token"),
    MCP_BLUE_TOKEN: yield* readSecret(directory, "mcp-blue-token"),
  };
  if (command === "mcp-demo") {
    const { mcpJourney } = yield* Effect.promise(
      () => import("../examples/mcp-journey.js"),
    );
    yield* Effect.promise(() => mcpJourney(environment));
    return;
  }
  if (command === "demo") {
    const { journeys } = yield* Effect.promise(
      () => import("../examples/journeys.js"),
    );
    yield* journeys.pipe(
      Effect.provide(
        ConfigProvider.layer(ConfigProvider.fromUnknown(environment)),
      ),
    );
    return;
  }
  const password = yield* readSecret(directory, "postgres-password");
  const host = yield* Config.string("POSTGRES_HOST").pipe(
    Config.withDefault("postgres"),
  );
  const url = new URL("postgresql://action_space@postgres:5432/action_space");
  url.hostname = host;
  url.password = password;
  if (command === "migrate") {
    yield* Effect.acquireUseRelease(
      external("Local.migrate", () => Journal.open(url.href, true)),
      () =>
        Effect.logInfo(
          "Local schema ready; frozen Work evidence was not rewritten",
        ),
      (journal) =>
        external("Local.closeMigration", () => journal.close()).pipe(
          Effect.orDie,
        ),
    );
  } else if (command === "serve") {
    const { runServer } = yield* Effect.promise(
      () => import("../src/server.js"),
    );
    yield* Effect.promise(() =>
      runServer(
        ConfigProvider.fromUnknown({ ...environment, DATABASE_URL: url.href }),
      ),
    );
  } else {
    return yield* new Fault("UNKNOWN_LOCAL_COMMAND");
  }
});

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  Effect.runPromise(main()).catch(() => {
    console.error(
      "Local startup failed. Inspect service status, database ownership and secret-file permissions. Legacy journals require a separate data volume; no secrets were logged.",
    );
    process.exitCode = 1;
  });
}
