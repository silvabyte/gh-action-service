import { Command, CommandExecutor, FileSystem } from "@effect/platform"
import { Effect } from "effect"
import * as path from "node:path"
import type { AppConfig } from "./config.ts"
import { deleteRunner, generateJitConfig } from "./github.ts"
import { prepareSlot } from "./runner-binary.ts"

/** Pause before retrying after a failed cycle so a broken config can't hot-loop. */
const RETRY_DELAY = "5 seconds"

/** Leftover files from a prior JIT run that we clear before starting a fresh one. */
const STALE_STATE = [".runner", ".credentials", ".credentials_rsaparams"]

const cleanState = (dir: string): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* Effect.forEach(
      STALE_STATE,
      (f) => fs.remove(path.join(dir, f), { force: true }).pipe(Effect.ignore),
      { discard: true },
    )
  })

/**
 * One full lifecycle of a single runner slot: register a fresh JIT runner, run
 * it until it picks up a job and exits, then return so the caller can recycle it.
 * If the fiber is interrupted (Ctrl-C) while the runner is idle, we force-delete
 * the registration so no ghost runner is left in the GitHub UI.
 */
const runOnce = (
  cfg: AppConfig,
  dir: string,
  name: string,
): Effect.Effect<void, Error, CommandExecutor.CommandExecutor | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    yield* cleanState(dir)
    const jit = yield* generateJitConfig(cfg, name)
    yield* Effect.log(`[${name}] registered (id=${jit.runnerId}); waiting for a job…`)

    const proc = Command.make("./run.sh", "--jitconfig", jit.encodedJitConfig).pipe(
      Command.workingDirectory(dir),
      Command.stdout("inherit"),
      Command.stderr("inherit"),
    )

    const code = yield* Command.exitCode(proc).pipe(
      // If we're torn down mid-wait, the process is killed by interruption; make
      // sure the idle registration is also removed.
      Effect.onInterrupt(() => deleteRunner(cfg, jit.runnerId)),
    )
    yield* Effect.log(`[${name}] runner exited (code ${code}); recycling`)
  })

/** Keep a single slot alive forever, recycling after each job and backing off on errors. */
const runnerLoop = (
  cfg: AppConfig,
  templateDir: string,
  index: number,
): Effect.Effect<never, Error, CommandExecutor.CommandExecutor | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const name = `${cfg.namePrefix}-${index}`
    const dir = yield* prepareSlot(cfg, templateDir, name)
    return yield* runOnce(cfg, dir, name).pipe(
      Effect.catchAll((e) =>
        Effect.logError(`[${name}] cycle failed: ${e.message}; retrying in ${RETRY_DELAY}`).pipe(
          Effect.zipRight(Effect.sleep(RETRY_DELAY)),
        ),
      ),
      Effect.forever,
    )
  })

/** Run `cfg.count` runner slots concurrently until interrupted. */
export const supervise = (
  cfg: AppConfig,
  templateDir: string,
): Effect.Effect<void, Error, CommandExecutor.CommandExecutor | FileSystem.FileSystem> =>
  Effect.forEach(
    Array.from({ length: cfg.count }, (_, i) => i),
    (i) => runnerLoop(cfg, templateDir, i),
    { concurrency: "unbounded", discard: true },
  )
