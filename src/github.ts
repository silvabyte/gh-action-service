import { Effect, Redacted } from "effect"
import type { AppConfig } from "./config.ts"

const API = "https://api.github.com"

const authHeaders = (token: Redacted.Redacted<string>): Record<string, string> => ({
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${Redacted.value(token)}`,
  "X-GitHub-Api-Version": "2022-11-28",
})

const toError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)))

export interface JitRunner {
  /** Numeric runner id GitHub assigned; used to force-deregister on shutdown. */
  readonly runnerId: number
  /** Opaque single-use config blob passed to `run.sh --jitconfig`. */
  readonly encodedJitConfig: string
}

/**
 * Create a just-in-time (ephemeral) runner registration for the org.
 * The returned runner will run exactly one job and then remove itself.
 * POST /orgs/{org}/actions/runners/generate-jitconfig
 */
export const generateJitConfig = (cfg: AppConfig, name: string): Effect.Effect<JitRunner, Error> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(`${API}/orgs/${cfg.org}/actions/runners/generate-jitconfig`, {
        method: "POST",
        headers: { ...authHeaders(cfg.token), "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          runner_group_id: cfg.runnerGroupId,
          labels: cfg.labels,
          work_folder: "_work",
        }),
      })
      if (!res.ok) {
        throw new Error(`generate-jitconfig failed (${res.status}): ${await res.text()}`)
      }
      const json = (await res.json()) as {
        runner: { id: number }
        encoded_jit_config: string
      }
      return { runnerId: json.runner.id, encodedJitConfig: json.encoded_jit_config }
    },
    catch: toError,
  })

/**
 * Best-effort deregistration. Ephemeral runners remove themselves after a job,
 * so this is only meaningful when we tear down an idle (waiting) runner.
 * A 404 means it's already gone — treated as success.
 * DELETE /orgs/{org}/actions/runners/{runner_id}
 */
export const deleteRunner = (cfg: AppConfig, runnerId: number): Effect.Effect<void> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(`${API}/orgs/${cfg.org}/actions/runners/${runnerId}`, {
        method: "DELETE",
        headers: authHeaders(cfg.token),
      })
      if (!res.ok && res.status !== 404) {
        throw new Error(`delete runner ${runnerId} failed (${res.status})`)
      }
    },
    catch: toError,
  }).pipe(
    // Deregistration is best-effort: never let it fail a shutdown.
    Effect.catchAll((e) => Effect.logWarning(`deregister runner ${runnerId} failed: ${e.message}`)),
  )

export interface RunnerGroup {
  readonly id: number
  readonly name: string
}

/** GET /orgs/{org}/actions/runner-groups — used by the `groups` diagnostic script. */
export const listRunnerGroups = (cfg: AppConfig): Effect.Effect<ReadonlyArray<RunnerGroup>, Error> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(`${API}/orgs/${cfg.org}/actions/runner-groups`, {
        headers: authHeaders(cfg.token),
      })
      if (!res.ok) {
        throw new Error(`list runner-groups failed (${res.status}): ${await res.text()}`)
      }
      const json = (await res.json()) as { runner_groups: ReadonlyArray<RunnerGroup> }
      return json.runner_groups.map((g) => ({ id: g.id, name: g.name }))
    },
    catch: toError,
  })

/** Resolve the newest actions/runner release tag (public endpoint, no auth needed). */
export const resolveLatestVersion: Effect.Effect<string, Error> = Effect.tryPromise({
  try: async () => {
    const res = await fetch(`${API}/repos/actions/runner/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
    })
    if (!res.ok) {
      throw new Error(`resolve latest runner version failed (${res.status})`)
    }
    const json = (await res.json()) as { tag_name: string }
    return json.tag_name.replace(/^v/, "")
  },
  catch: toError,
})
