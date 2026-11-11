import { Command, CommandExecutor, FileSystem } from "@effect/platform"
import { Clock, Effect, Either } from "effect"
import * as os from "node:os"
import * as path from "node:path"
import type { AppConfig } from "./config.ts"
import { resolveLatestVersion } from "./github.ts"

/**
 * How often a long-running process re-checks `releases/latest`.
 * A deprecated runner exit bypasses this and resolves immediately.
 * A failed lookup does not move the timestamp, so it is not treated as a fresh confirmation.
 */
const LATEST_TTL_MS = 15 * 60 * 1000

/** Release tags we will put in a filesystem path and a shell command. */
const RELEASE_VERSION = /^\d+\.\d+\.\d+$/

/**
 * The actions/runner tree every slot should execute.
 * `resolvedAt` is when this version was last confirmed. A failed lookup keeps
 * the previous release, timestamp included.
 */
export interface RunnerRelease {
  readonly version: string
  readonly templateDir: string
  readonly resolvedAt: number
}

/** Written into each slot after a copy. Missing or different means the slot is stale. */
const SLOT_VERSION_FILE = ".template-version"

const templateName = (version: string): string => `.bin-${version}`

/** Map the host platform to actions/runner's release naming (os + arch). */
const platformTriple = (): { osName: string; arch: string } => {
  const p = os.platform()
  const a = os.arch()
  const osName = p === "darwin" ? "osx" : p === "linux" ? "linux" : null
  const arch = a === "x64" ? "x64" : a === "arm64" ? "arm64" : null
  if (osName === null) throw new Error(`unsupported OS for actions/runner: ${p}`)
  if (arch === null) throw new Error(`unsupported CPU arch for actions/runner: ${a}`)
  return { osName, arch }
}

const runShell = (label: string, script: string): Effect.Effect<void, Error, CommandExecutor.CommandExecutor> =>
  Effect.gen(function* () {
    const code = yield* Command.exitCode(Command.make("bash", "-c", script))
    if (code !== 0) return yield* Effect.fail(new Error(`${label} failed (exit ${code})`))
  })

/**
 * Ensure this exact release is downloaded and extracted into `.bin-<version>`.
 * Returns that directory. A later release lives beside it until pruned.
 */
const ensureTemplate = (
  cfg: AppConfig,
  version: string,
): Effect.Effect<string, Error, FileSystem.FileSystem | CommandExecutor.CommandExecutor> =>
  Effect.gen(function* () {
    if (!RELEASE_VERSION.test(version)) {
      return yield* Effect.fail(new Error(`unsupported actions/runner version: ${version}`))
    }
    const fs = yield* FileSystem.FileSystem
    const templateDir = path.join(cfg.runnersDir, templateName(version))

    if (yield* fs.exists(path.join(templateDir, "run.sh"))) {
      return templateDir
    }

    const { osName, arch } = platformTriple()
    const url =
      `https://github.com/actions/runner/releases/download/v${version}` +
      `/actions-runner-${osName}-${arch}-${version}.tar.gz`

    yield* Effect.log(`Downloading actions-runner v${version} (${osName}-${arch})…`)
    yield* fs.makeDirectory(templateDir, { recursive: true })
    yield* runShell(
      "runner download",
      `set -euo pipefail; curl -fsSL "${url}" | tar -xz -C "${templateDir}"`,
    )
    return templateDir
  })

/**
 * Drop `.bin-<version>` directories for releases we are no longer using.
 * Slot working dirs are not touched; a job may still be using its copy.
 */
const pruneTemplates = (
  cfg: AppConfig,
  keepVersion: string,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const entries = yield* fs.readDirectory(cfg.runnersDir).pipe(
      Effect.catchAll((e) =>
        Effect.logWarning(`Could not list ${cfg.runnersDir} to prune old runners: ${e.message}`).pipe(
          Effect.map(() => [] as ReadonlyArray<string>),
        ),
      ),
    )
    const keep = templateName(keepVersion)
    const stale = entries.filter((name) => /^\.bin-\d+\.\d+\.\d+$/.test(name) && name !== keep)
    yield* Effect.forEach(
      stale,
      (name) =>
        fs.remove(path.join(cfg.runnersDir, name), { recursive: true, force: true }).pipe(
          Effect.catchAll((e) => Effect.logWarning(`Could not remove old runner template ${name}: ${e.message}`)),
        ),
      { discard: true },
    )
  })

/**
 * The release slots should run now.
 *
 * `latest` is remembered for {@link LATEST_TTL_MS}. Pass `force` after a
 * deprecated exit to bypass that. If the lookup fails and we already have a
 * release, that release is returned unchanged.
 */
export const resolveRelease = (
  cfg: AppConfig,
  current: RunnerRelease | null,
  force: boolean,
): Effect.Effect<RunnerRelease, Error, FileSystem.FileSystem | CommandExecutor.CommandExecutor> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const pinned = cfg.runnerVersion !== "latest"

    if (current && pinned && current.version === cfg.runnerVersion) return current
    if (current && !pinned && !force && now - current.resolvedAt < LATEST_TTL_MS) return current

    if (!pinned) {
      const fresh = yield* resolveLatestVersion.pipe(Effect.either)
      if (Either.isLeft(fresh)) {
        if (current === null) return yield* Effect.fail(fresh.left)
        yield* Effect.logWarning(
          `Could not resolve latest actions/runner (${fresh.left.message}); keeping v${current.version}`,
        )
        return current
      }
      const version = fresh.right
      const templateDir = yield* ensureTemplate(cfg, version)
      yield* pruneTemplates(cfg, version)
      if (!current) yield* Effect.log(`Using actions-runner v${version}`)
      else if (current.version !== version) {
        yield* Effect.log(`actions-runner v${current.version} -> v${version}`)
      }
      return { version, templateDir, resolvedAt: now }
    }

    const templateDir = yield* ensureTemplate(cfg, cfg.runnerVersion)
    yield* pruneTemplates(cfg, cfg.runnerVersion)
    if (!current) yield* Effect.log(`Using actions-runner v${cfg.runnerVersion}`)
    return { version: cfg.runnerVersion, templateDir, resolvedAt: now }
  })

/**
 * Working directory for one slot, copied from `release`.
 * Rebuilt when the directory was never stamped with this version, which is
 * also the case for slots left behind by older supervisors. A matching stamp
 * is reused so `_work` survives across jobs of the same release.
 */
export const prepareSlot = (
  cfg: AppConfig,
  release: RunnerRelease,
  name: string,
): Effect.Effect<string, Error, FileSystem.FileSystem | CommandExecutor.CommandExecutor> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = path.join(cfg.runnersDir, name)
    const marker = path.join(dir, SLOT_VERSION_FILE)
    const recorded = yield* fs.readFileString(marker).pipe(
      Effect.map((text) => text.trim()),
      Effect.orElseSucceed(() => ""),
    )
    const runnable = recorded === release.version && (yield* fs.exists(path.join(dir, "run.sh")))
    if (runnable) return dir

    yield* Effect.log(
      recorded === ""
        ? `Preparing runner working dir ${dir} (actions-runner v${release.version})`
        : `Rebuilding runner working dir ${dir} for actions-runner v${release.version} (was v${recorded})`,
    )
    yield* fs.remove(dir, { recursive: true, force: true })
    yield* fs.makeDirectory(dir, { recursive: true })
    yield* runShell("prepare runner dir", `set -euo pipefail; cp -R "${release.templateDir}/." "${dir}/"`)
    yield* fs.writeFileString(marker, `${release.version}\n`)
    return dir
  })
