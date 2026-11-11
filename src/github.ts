import { Data, Effect, Redacted } from "effect"
import type { AppConfig } from "./config.ts"

const API = "https://api.github.com"

const authHeaders = (token: Redacted.Redacted<string>): Record<string, string> => ({
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${Redacted.value(token)}`,
  "X-GitHub-Api-Version": "2022-11-28",
})

const toError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)))

/** HTTP failure that callers branch on by status. 409 is a name conflict, not a fatal config error. */
class GitHubRequestError extends Data.TaggedError("GitHubRequestError")<{
  readonly status: number
  readonly message: string
}> {}

/** One GitHub response. Status is data so 404 and 409 stay on the success channel. */
interface HttpResult {
  readonly status: number
  readonly body: string
}

const request = (
  cfg: AppConfig,
  method: string,
  path: string,
  body?: unknown,
): Effect.Effect<HttpResult, Error> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(`${API}${path}`, {
        method,
        headers: {
          ...authHeaders(cfg.token),
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
      return { status: res.status, body: await res.text() }
    },
    catch: toError,
  })

export interface JitRunner {
  /** Numeric runner id GitHub assigned; used to force-deregister on shutdown. */
  readonly runnerId: number
  /** Opaque single-use config blob passed to `run.sh --jitconfig`. */
  readonly encodedJitConfig: string
}

/**
 * A runner already registered to the org under a name we want to reuse.
 * `busy === null` means the payload didn't say — treated as not safe to delete.
 */
interface OrgRunner {
  readonly id: number
  readonly name: string
  readonly status: string
  readonly busy: boolean | null
}

/**
 * What to do about a generate-jitconfig 409 for one exact runner name.
 * Only `OfflineIdle` is deleted. Everything else is left in place.
 */
type NameConflict =
  | { readonly _tag: "Absent" }
  | { readonly _tag: "OfflineIdle"; readonly id: number }
  | { readonly _tag: "Retained"; readonly detail: string }

const classifyNameConflict = (name: string, runners: ReadonlyArray<OrgRunner>): NameConflict => {
  const matches = runners.filter((runner) => runner.name === name)
  const only = matches.length === 1 ? matches[0] : undefined
  if (!only) {
    if (matches.length === 0) return { _tag: "Absent" }
    return { _tag: "Retained", detail: `${matches.length} registrations use that name` }
  }
  if (only.status === "offline" && only.busy === false) {
    return { _tag: "OfflineIdle", id: only.id }
  }
  const state =
    only.busy === true ? `${only.status}, busy` : only.busy === null ? `${only.status}, busy unknown` : only.status
  return { _tag: "Retained", detail: `id=${only.id} is ${state}` }
}

const parseRunnerPage = (text: string): { readonly totalCount: number; readonly runners: ReadonlyArray<OrgRunner> } => {
  const json: unknown = JSON.parse(text)
  if (typeof json !== "object" || json === null) {
    throw new Error("list runners returned invalid JSON")
  }
  const body = json as { total_count?: unknown; runners?: unknown }
  if (!Array.isArray(body.runners)) throw new Error("list runners returned invalid JSON")
  const runners: Array<OrgRunner> = []
  for (const value of body.runners) {
    if (typeof value !== "object" || value === null) continue
    const runner = value as Record<string, unknown>
    if (typeof runner.id !== "number" || typeof runner.name !== "string") continue
    runners.push({
      id: runner.id,
      name: runner.name,
      status: typeof runner.status === "string" ? runner.status : "",
      busy: typeof runner.busy === "boolean" ? runner.busy : null,
    })
  }
  return {
    totalCount: typeof body.total_count === "number" ? body.total_count : runners.length,
    runners,
  }
}

/** GET /orgs/{org}/actions/runners?name= — `name` is an exact-match filter. */
const listRunnersByName = (cfg: AppConfig, name: string): Effect.Effect<ReadonlyArray<OrgRunner>, Error> =>
  Effect.gen(function* () {
    const matches: Array<OrgRunner> = []
    let seen = 0
    let total = Number.POSITIVE_INFINITY
    for (let page = 1; page <= 20 && seen < total; page++) {
      const res = yield* request(
        cfg,
        "GET",
        `/orgs/${cfg.org}/actions/runners?name=${encodeURIComponent(name)}&per_page=100&page=${page}`,
      )
      if (res.status < 200 || res.status >= 300) {
        return yield* Effect.fail(new Error(`list runners failed (${res.status}): ${res.body}`))
      }
      const parsed = yield* Effect.try({
        try: () => parseRunnerPage(res.body),
        catch: toError,
      })
      if (parsed.runners.length === 0) break
      total = parsed.totalCount
      seen += parsed.runners.length
      for (const runner of parsed.runners) {
        if (runner.name === name) matches.push(runner)
      }
    }
    return matches
  })

const postJit = (cfg: AppConfig, name: string): Effect.Effect<JitRunner, Error> =>
  Effect.gen(function* () {
    const res = yield* request(cfg, "POST", `/orgs/${cfg.org}/actions/runners/generate-jitconfig`, {
      name,
      runner_group_id: cfg.runnerGroupId,
      labels: cfg.labels,
      work_folder: "_work",
    })
    if (res.status === 409) {
      return yield* new GitHubRequestError({
        status: 409,
        message: `generate-jitconfig failed (409): ${res.body}`,
      })
    }
    if (res.status < 200 || res.status >= 300) {
      return yield* Effect.fail(new Error(`generate-jitconfig failed (${res.status}): ${res.body}`))
    }
    const json = yield* Effect.try({
      try: () => JSON.parse(res.body) as { runner?: { id?: unknown }; encoded_jit_config?: unknown },
      catch: toError,
    })
    if (typeof json.runner?.id !== "number" || typeof json.encoded_jit_config !== "string") {
      return yield* Effect.fail(new Error("generate-jitconfig returned an unexpected payload"))
    }
    return { runnerId: json.runner.id, encodedJitConfig: json.encoded_jit_config }
  })

/**
 * A 409 means this slot's name is still registered from a runner that exited
 * without removing itself. Delete that registration only when it is offline
 * and not busy, then let the caller retry. An online or busy runner may be
 * mid-job on another machine; never remove it.
 */
const releaseNameConflict = (cfg: AppConfig, name: string): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const conflict = classifyNameConflict(name, yield* listRunnersByName(cfg, name))
    switch (conflict._tag) {
      case "Absent":
        return
      case "OfflineIdle":
        yield* Effect.log(
          `Removing offline runner ${name} (id=${conflict.id}) so a new JIT registration can replace it`,
        )
        yield* deleteRunner(cfg, conflict.id)
        return
      case "Retained":
        return yield* Effect.fail(new Error(`refusing to delete runner ${name}: ${conflict.detail}`))
    }
  })

const isNameConflict = (error: Error): error is GitHubRequestError =>
  error instanceof GitHubRequestError && error.status === 409

/**
 * Create a just-in-time (ephemeral) runner registration for the org.
 * The returned runner will run exactly one job and then remove itself.
 * POST /orgs/{org}/actions/runners/generate-jitconfig
 *
 * On 409, an offline idle runner with this exact name is deleted and the
 * create is retried once. A second 409 is returned to the caller.
 */
export const generateJitConfig = (cfg: AppConfig, name: string): Effect.Effect<JitRunner, Error> =>
  postJit(cfg, name).pipe(
    Effect.catchIf(isNameConflict, () => releaseNameConflict(cfg, name).pipe(Effect.flatMap(() => postJit(cfg, name)))),
  )

/**
 * Deregister a runner by id. Ephemeral runners remove themselves after a job,
 * so a 404 means it's already gone and is success. Any other failure is returned;
 * callers that are shutting down decide whether to ignore it.
 * DELETE /orgs/{org}/actions/runners/{runner_id}
 */
export const deleteRunner = (cfg: AppConfig, runnerId: number): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const res = yield* request(cfg, "DELETE", `/orgs/${cfg.org}/actions/runners/${runnerId}`)
    if (res.status === 404 || (res.status >= 200 && res.status < 300)) return
    return yield* Effect.fail(new Error(`delete runner ${runnerId} failed (${res.status}): ${res.body}`))
  })

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
