import { BunRuntime } from "@effect/platform-bun"
import { Effect } from "effect"
import { loadConfig } from "./config.ts"
import { listRunnerGroups } from "./github.ts"

/**
 * Diagnostic: list the org's runner groups so you can pick a RUNNER_GROUP_ID.
 * Run with `bun run groups`.
 */
const program = Effect.gen(function* () {
  const cfg = yield* loadConfig
  const groups = yield* listRunnerGroups(cfg)
  yield* Effect.log(`Runner groups for org "${cfg.org}":`)
  for (const g of groups) {
    yield* Effect.log(`  id=${g.id}  name=${g.name}`)
  }
})

program.pipe(BunRuntime.runMain)
