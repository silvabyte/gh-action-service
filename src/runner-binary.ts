import { Command, CommandExecutor, FileSystem } from "@effect/platform"
import { Effect } from "effect"
import * as os from "node:os"
import * as path from "node:path"
import type { AppConfig } from "./config.ts"
import { resolveLatestVersion } from "./github.ts"

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
 * Ensure the actions/runner release is downloaded and extracted once into a
 * shared, version-pinned template directory. Returns that directory.
 */
export const ensureTemplate = (
  cfg: AppConfig,
): Effect.Effect<string, Error, FileSystem.FileSystem | CommandExecutor.CommandExecutor> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const version = cfg.runnerVersion === "latest" ? yield* resolveLatestVersion : cfg.runnerVersion
    const templateDir = path.join(cfg.runnersDir, `.bin-${version}`)

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
 * Create (once) a dedicated working directory for a runner slot by copying the
 * template. Each runner needs its own dir so `_work`/`_diag`/state don't collide.
 * The directory is reused across respawns of the same slot.
 */
export const prepareSlot = (
  cfg: AppConfig,
  templateDir: string,
  name: string,
): Effect.Effect<string, Error, FileSystem.FileSystem | CommandExecutor.CommandExecutor> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = path.join(cfg.runnersDir, name)
    if (!(yield* fs.exists(path.join(dir, "run.sh")))) {
      yield* Effect.log(`Preparing runner working dir ${dir}`)
      yield* fs.makeDirectory(dir, { recursive: true })
      yield* runShell("prepare runner dir", `set -euo pipefail; cp -R "${templateDir}/." "${dir}/"`)
    }
    return dir
  })
