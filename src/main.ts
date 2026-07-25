import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Effect } from "effect"
import { loadConfig } from "./config.ts"
import { ensureTemplate } from "./runner-binary.ts"
import { supervise } from "./supervisor.ts"

const program = Effect.gen(function* () {
  const cfg = yield* loadConfig
  yield* Effect.log(
    `Starting ${cfg.count} ephemeral runner(s) for org "${cfg.org}" ` +
      `(group ${cfg.runnerGroupId}, labels: ${cfg.labels.join(", ")})`,
  )
  const templateDir = yield* ensureTemplate(cfg)
  yield* supervise(cfg, templateDir)
})

// BunRuntime.runMain wires SIGINT/SIGTERM to fiber interruption, which triggers
// the deregistration finalizers in the supervisor for a clean shutdown.
program.pipe(Effect.provide(BunContext.layer), BunRuntime.runMain)
