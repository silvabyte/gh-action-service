import { Command, CommandExecutor, FileSystem } from "@effect/platform"
import { Effect, Ref } from "effect"
import * as path from "node:path"
import type { AppConfig } from "./config.ts"
import { deleteRunner, generateJitConfig } from "./github.ts"
import { prepareSlot, resolveRelease, type RunnerRelease } from "./runner-binary.ts"

/** Pause before retrying after a failed cycle so a broken config can't hot-loop. */
const RETRY_DELAY = "5 seconds"

/**
 * `run.sh` exits 0 on almost every path, including "version deprecated", unless
 * this is set. actions/runner then exits 7 (ReturnCode.RunnerVersionDeprecated)
 * and the shell wrapper propagates it. Shipped in runner 2.333.0.
 */
const DEPRECATED_RUNNER_ENV = "ACTIONS_RUNNER_RETURN_VERSION_DEPRECATED_EXIT_CODE"
const DEPRECATED_EXIT = 7

/** Leftover files from a prior JIT run that we clear before starting a fresh one. */
const STALE_STATE = [".runner", ".credentials", ".credentials_rsaparams"]

/**
 * Shared release for every slot. The lock keeps two slots from unpacking the
 * same tarball, and from deleting a template the other slot is still copying.
 */
export interface ReleaseCache {
  readonly current: Ref.Ref<RunnerRelease | null>
  readonly lock: Effect.Semaphore
}

/** What one register-run-cleanup pass decided. The supervisor loop repeats it. */
export interface CycleResult {
  /** Release the process that just exited was started from. */
  readonly version: string
  /** Release the next pass should start from. Differs after a deprecated upgrade. */
  readonly nextVersion: string
  /** True when run.sh exited 7: GitHub rejected this runner version. */
  readonly deprecated: boolean
}

export const makeReleaseCache: Effect.Effect<ReleaseCache> = Effect.gen(function* () {
  return {
    current: yield* Ref.make<RunnerRelease | null>(null),
    lock: yield* Effect.makeSemaphore(1),
  }
})

const cleanState = (dir: string): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* Effect.forEach(
      STALE_STATE,
      (f) => fs.remove(path.join(dir, f), { force: true }).pipe(Effect.ignore),
      { discard: true },
    )
  })

/** Best-effort delete. A failed deregister must not hide the runner's own exit. */
const forgetRunner = (cfg: AppConfig, runnerId: number): Effect.Effect<void> =>
  deleteRunner(cfg, runnerId).pipe(
    Effect.catchAll((e) => Effect.logWarning(`deregister runner ${runnerId} failed: ${e.message}`)),
  )

/**
 * One full lifecycle of a single runner slot: register a fresh JIT runner, run
 * it until it exits, then delete that registration if it is still on GitHub.
 * Ephemeral runners that finished a job are already gone (404, treated as
 * success). Runners that exited without a job — deprecated, crashed, killed —
 * would otherwise stick as an offline name and 409 forever.
 */
const runOnce = (
  cfg: AppConfig,
  dir: string,
  name: string,
): Effect.Effect<number, Error, CommandExecutor.CommandExecutor | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    yield* cleanState(dir)
    const jit = yield* generateJitConfig(cfg, name)
    yield* Effect.log(`[${name}] registered (id=${jit.runnerId}); waiting for a job…`)

    const proc = Command.make("./run.sh", "--jitconfig", jit.encodedJitConfig).pipe(
      Command.workingDirectory(dir),
      Command.env({ [DEPRECATED_RUNNER_ENV]: "1" }),
      Command.stdout("inherit"),
      Command.stderr("inherit"),
    )

    // ensuring covers a normal exit and an interrupt (Ctrl-C kills the child).
    const code = yield* Command.exitCode(proc).pipe(Effect.ensuring(forgetRunner(cfg, jit.runnerId)))
    yield* Effect.log(`[${name}] runner exited (code ${code}); recycling`)
    return Number(code)
  })

/**
 * Register, run, and clean up one slot once.
 * The slot directory is rebuilt first when it was copied from a different release.
 * A deprecated exit re-resolves `latest` immediately so the next pass can upgrade.
 */
export const runCycle = (
  cfg: AppConfig,
  cache: ReleaseCache,
  index: number,
): Effect.Effect<CycleResult, Error, CommandExecutor.CommandExecutor | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const name = `${cfg.namePrefix}-${index}`
    const { release, dir } = yield* cache.lock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(cache.current)
        const release = yield* resolveRelease(cfg, current, false)
        yield* Ref.set(cache.current, release)
        const dir = yield* prepareSlot(cfg, release, name)
        return { release, dir }
      }),
    )

    const code = yield* runOnce(cfg, dir, name)
    if (code !== DEPRECATED_EXIT) {
      return { version: release.version, nextVersion: release.version, deprecated: false }
    }

    // Resolve and copy under one lock. Prune runs inside resolve, and another
    // slot must not delete the template this copy is still reading.
    const next = yield* cache.lock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(cache.current)
        const upgraded = yield* resolveRelease(cfg, current, true)
        yield* Ref.set(cache.current, upgraded)
        yield* prepareSlot(cfg, upgraded, name)
        return upgraded
      }),
    )
    return { version: release.version, nextVersion: next.version, deprecated: true }
  })

/**
 * Keep one slot alive forever. A deprecated exit that didn't find a newer
 * release backs off, so a pinned version can't hot-loop. Other failures use
 * the same delay.
 */
const runnerLoop = (
  cfg: AppConfig,
  cache: ReleaseCache,
  index: number,
): Effect.Effect<never, Error, CommandExecutor.CommandExecutor | FileSystem.FileSystem> => {
  const name = `${cfg.namePrefix}-${index}`
  return runCycle(cfg, cache, index).pipe(
    Effect.tap((result) => {
      if (!result.deprecated) return Effect.void
      if (result.nextVersion !== result.version) {
        return Effect.log(
          `[${name}] actions-runner v${result.version} is deprecated; next cycle will use v${result.nextVersion}`,
        )
      }
      return Effect.logWarning(
        `[${name}] actions-runner v${result.version} is deprecated and no newer release is available; retrying in ${RETRY_DELAY}`,
      ).pipe(Effect.zipRight(Effect.sleep(RETRY_DELAY)))
    }),
    Effect.catchAll((e) =>
      Effect.logError(`[${name}] cycle failed: ${e.message}; retrying in ${RETRY_DELAY}`).pipe(
        Effect.zipRight(Effect.sleep(RETRY_DELAY)),
      ),
    ),
    Effect.forever,
  )
}

/** Run `cfg.count` runner slots concurrently until interrupted. */
export const supervise = (
  cfg: AppConfig,
): Effect.Effect<void, Error, CommandExecutor.CommandExecutor | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const cache = yield* makeReleaseCache
    yield* Effect.forEach(
      Array.from({ length: cfg.count }, (_, i) => i),
      (index) => runnerLoop(cfg, cache, index),
      { concurrency: "unbounded", discard: true },
    )
  })
