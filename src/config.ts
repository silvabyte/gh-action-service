import { Config, type ConfigError, Effect, type Redacted } from "effect"
import * as os from "node:os"

const OS_LABELS: Readonly<Record<string, string>> = { darwin: "macOS", linux: "Linux" }
const ARCH_LABELS: Readonly<Record<string, string>> = { x64: "X64", arm64: "ARM64" }

/**
 * Runtime configuration for the runner supervisor.
 *
 * Everything is sourced from environment variables (Bun auto-loads `.env`).
 * See `.env.example` for the full list and defaults.
 */
export interface AppConfig {
  /** Fine-grained PAT with the org "Self-hosted runners: Read and write" permission. */
  readonly token: Redacted.Redacted<string>
  /** GitHub organization login the runners register against. */
  readonly org: string
  /** How many ephemeral runners to keep alive concurrently. */
  readonly count: number
  /** Standard host labels plus any custom labels applied to every runner. */
  readonly labels: ReadonlyArray<string>
  /** Runner group id to place the runners in. `bun run groups` lists them; the default group is 1. */
  readonly runnerGroupId: number
  /**
   * actions/runner release to use, e.g. "2.320.0", or "latest".
   * "latest" is re-resolved while the process is running; a failed lookup keeps the current release.
   */
  readonly runnerVersion: string
  /** Prefix for runner names; the slot index is appended (e.g. "my-laptop-0"). Defaults to hostname. */
  readonly namePrefix: string
  /** Directory holding the downloaded runner binary + per-runner working dirs. */
  readonly runnersDir: string
}

export const runnerLabels = (
  customLabels: ReadonlyArray<string>,
  platform = os.platform(),
  architecture = os.arch(),
): ReadonlyArray<string> => {
  const osLabel = OS_LABELS[platform] ?? platform
  const archLabel = ARCH_LABELS[architecture] ?? architecture
  const labels = ["self-hosted", osLabel, archLabel, ...customLabels]
  const seen = new Set<string>()

  return labels.filter((label) => {
    const normalized = label.toLowerCase()
    if (seen.has(normalized)) return false
    seen.add(normalized)
    return true
  })
}

export const loadConfig: Effect.Effect<AppConfig, ConfigError.ConfigError> = Effect.gen(function* () {
  const token = yield* Config.redacted("GITHUB_TOKEN")
  const org = yield* Config.string("GITHUB_ORG")
  const count = yield* Config.integer("RUNNER_COUNT").pipe(Config.withDefault(2))
  const labels = yield* Config.string("RUNNER_LABELS").pipe(Config.withDefault(""))
  const runnerGroupId = yield* Config.integer("RUNNER_GROUP_ID").pipe(Config.withDefault(1))
  const runnerVersion = yield* Config.string("RUNNER_VERSION").pipe(Config.withDefault("latest"))
  const namePrefix = yield* Config.string("RUNNER_NAME_PREFIX").pipe(Config.withDefault(os.hostname()))
  const runnersDir = yield* Config.string("RUNNERS_DIR").pipe(Config.withDefault(".runners"))

  return {
    token,
    org,
    count,
    labels: runnerLabels(
      labels
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
    runnerGroupId,
    runnerVersion,
    namePrefix,
    runnersDir,
  } satisfies AppConfig
})
