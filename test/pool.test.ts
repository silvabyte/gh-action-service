import { BunContext } from "@effect/platform-bun"
import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Logger, LogLevel, Redacted } from "effect"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import type { AppConfig } from "../src/config.ts"
import { generateJitConfig } from "../src/github.ts"
import { makeReleaseCache, runCycle } from "../src/supervisor.ts"
import type { CommandExecutor, FileSystem } from "@effect/platform"

const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect.pipe(Logger.withMinimumLogLevel(LogLevel.None)))

const runPlatform = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | CommandExecutor.CommandExecutor>,
) =>
  Effect.runPromise(
    effect.pipe(Logger.withMinimumLogLevel(LogLevel.None), Effect.provide(BunContext.layer)),
  )

const cfg = (runnersDir: string, runnerVersion = "latest"): AppConfig => ({
  token: Redacted.make("test-token"),
  org: "acme",
  count: 1,
  labels: ["self-hosted"],
  runnerGroupId: 1,
  runnerVersion,
  namePrefix: "slot",
  runnersDir,
})

interface FetchCall {
  readonly method: string
  readonly url: URL
  readonly body: string | undefined
}

const installFetch = (handle: (call: FetchCall) => Response) => {
  const calls: Array<FetchCall> = []
  const previous = globalThis.fetch
  globalThis.fetch = (async (input, init) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const call: FetchCall = {
      method: init?.method ?? "GET",
      url: new URL(href),
      body: typeof init?.body === "string" ? init.body : undefined,
    }
    calls.push(call)
    return handle(call)
  }) as typeof fetch
  return {
    calls,
    restore() {
      globalThis.fetch = previous
    },
  }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

const text = (status: number, body: string) => new Response(body, { status })

const writeRunSh = async (dir: string, script: string) => {
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, "run.sh"), script, { mode: 0o755 })
}

/** Fake run.sh. Exits 7 only when the supervisor opted into the deprecated-exit signal. */
const versionScript = (version: string, ranFile: string, exitCode: number) => `#!/bin/sh
if [ "$ACTIONS_RUNNER_RETURN_VERSION_DEPRECATED_EXIT_CODE" != "1" ]; then
  printf '%s\\n' 'missing-env' > '${ranFile}'
  exit 0
fi
printf '%s\\n' '${version}' > '${ranFile}'
exit ${exitCode}
`

const withRoot = async (body: (root: string) => Promise<void>) => {
  const root = await mkdtemp(path.join(tmpdir(), "gh-runners-"))
  try {
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const deletes = (calls: ReadonlyArray<FetchCall>): Array<string> =>
  calls.filter((call) => call.method === "DELETE").map((call) => call.url.pathname)

const orgRunner = (id: number, name: string, status: string, busy: boolean | undefined) => ({
  id,
  name,
  status,
  ...(busy === undefined ? {} : { busy }),
})

describe("slot version", () => {
  test("rebuilds a slot copied from an older release and keeps it once it matches", async () => {
    await withRoot(async (root) => {
      const runnersDir = path.join(root, "runners")
      const ran = path.join(root, "ran")
      await writeRunSh(path.join(runnersDir, ".bin-2.338.2"), versionScript("2.338.2", ran, 0))
      await writeRunSh(path.join(runnersDir, ".bin-2.337.0"), versionScript("2.337.0", ran, 0))
      await writeRunSh(path.join(runnersDir, ".bin-2.336.0"), versionScript("2.336.0", ran, 0))
      // The outage: run.sh already exists, so the old supervisor never recopied.
      await writeRunSh(path.join(runnersDir, "slot-0"), versionScript("stale", ran, 0))
      await writeFile(path.join(runnersDir, "notes.txt"), "keep")

      const github = installFetch((call) => {
        if (call.url.pathname === "/repos/actions/runner/releases/latest") {
          return json(200, { tag_name: "v2.338.2" })
        }
        if (call.url.pathname.endsWith("/generate-jitconfig")) {
          return json(201, { runner: { id: 42 }, encoded_jit_config: "jit" })
        }
        if (call.method === "DELETE") return text(404, "")
        throw new Error(`unexpected ${call.method} ${call.url}`)
      })
      try {
        const cache = await runPlatform(makeReleaseCache)
        const first = await runPlatform(runCycle(cfg(runnersDir), cache, 0))
        expect(first).toEqual({ version: "2.338.2", nextVersion: "2.338.2", deprecated: false })
        expect((await readFile(ran, "utf8")).trim()).toBe("2.338.2")
        expect(existsSync(path.join(runnersDir, ".bin-2.336.0"))).toBe(false)
        expect(existsSync(path.join(runnersDir, ".bin-2.337.0"))).toBe(false)
        expect(existsSync(path.join(runnersDir, ".bin-2.338.2", "run.sh"))).toBe(true)
        expect(await readFile(path.join(runnersDir, "notes.txt"), "utf8")).toBe("keep")

        await writeFile(path.join(runnersDir, "slot-0", "keep-me"), "yes")
        await runPlatform(runCycle(cfg(runnersDir), cache, 0))
        expect(await readFile(path.join(runnersDir, "slot-0", "keep-me"), "utf8")).toBe("yes")
        expect((await readFile(ran, "utf8")).trim()).toBe("2.338.2")
        expect(github.calls.filter((call) => call.url.pathname.endsWith("/releases/latest"))).toHaveLength(1)
      } finally {
        github.restore()
      }
    })
  })

  test("resolves a newer release after the runner exits deprecated", async () => {
    await withRoot(async (root) => {
      const runnersDir = path.join(root, "runners")
      const ran = path.join(root, "ran")
      await writeRunSh(path.join(runnersDir, ".bin-2.338.2"), versionScript("2.338.2", ran, 7))
      const versions = ["2.338.2", "2.339.0"]
      let latestCalls = 0
      const github = installFetch((call) => {
        if (call.url.pathname === "/repos/actions/runner/releases/latest") {
          const version = versions[latestCalls] ?? versions[versions.length - 1]!
          latestCalls += 1
          // The first resolve deletes every other .bin-* tree. Drop the upgrade
          // in place as the lookup returns, which is what a real download would do.
          if (version === "2.339.0") {
            const dir = path.join(runnersDir, ".bin-2.339.0")
            mkdirSync(dir, { recursive: true })
            writeFileSync(path.join(dir, "run.sh"), versionScript("2.339.0", ran, 0), { mode: 0o755 })
          }
          return json(200, { tag_name: `v${version}` })
        }
        if (call.url.pathname.endsWith("/generate-jitconfig")) {
          return json(201, { runner: { id: latestCalls }, encoded_jit_config: "jit" })
        }
        if (call.method === "DELETE") return text(404, "")
        throw new Error(`unexpected ${call.method} ${call.url}`)
      })
      try {
        const cache = await runPlatform(makeReleaseCache)
        const deprecated = await runPlatform(runCycle(cfg(runnersDir), cache, 0))
        expect(deprecated.deprecated).toBe(true)
        expect(deprecated.version).toBe("2.338.2")
        expect(deprecated.nextVersion).toBe("2.339.0")
        expect((await readFile(ran, "utf8")).trim()).toBe("2.338.2")

        const upgraded = await runPlatform(runCycle(cfg(runnersDir), cache, 0))
        expect(upgraded).toEqual({ version: "2.339.0", nextVersion: "2.339.0", deprecated: false })
        expect((await readFile(ran, "utf8")).trim()).toBe("2.339.0")
        expect(latestCalls).toBe(2)
        expect(existsSync(path.join(runnersDir, ".bin-2.338.2"))).toBe(false)
        expect(existsSync(path.join(runnersDir, ".bin-2.339.0", "run.sh"))).toBe(true)
        expect(deletes(github.calls)).toEqual([
          "/orgs/acme/actions/runners/1",
          "/orgs/acme/actions/runners/2",
        ])
      } finally {
        github.restore()
      }
    })
  })

  test("keeps the current release when a latest lookup fails", async () => {
    await withRoot(async (root) => {
      const runnersDir = path.join(root, "runners")
      const ran = path.join(root, "ran")
      await writeRunSh(path.join(runnersDir, ".bin-2.338.2"), versionScript("2.338.2", ran, 7))
      let latestCalls = 0
      const github = installFetch((call) => {
        if (call.url.pathname === "/repos/actions/runner/releases/latest") {
          latestCalls += 1
          if (latestCalls === 1) return json(200, { tag_name: "v2.338.2" })
          return text(500, "unavailable")
        }
        if (call.url.pathname.endsWith("/generate-jitconfig")) {
          return json(201, { runner: { id: 7 }, encoded_jit_config: "jit" })
        }
        if (call.method === "DELETE") return text(404, "")
        throw new Error(`unexpected ${call.method} ${call.url}`)
      })
      try {
        const cache = await runPlatform(makeReleaseCache)
        const result = await runPlatform(runCycle(cfg(runnersDir), cache, 0))
        expect(result).toEqual({ version: "2.338.2", nextVersion: "2.338.2", deprecated: true })
        expect((await readFile(ran, "utf8")).trim()).toBe("2.338.2")
        expect(latestCalls).toBe(2)
        expect(existsSync(path.join(runnersDir, ".bin-2.338.2", "run.sh"))).toBe(true)
        expect((await readFile(path.join(runnersDir, "slot-0", "run.sh"), "utf8")).includes("2.338.2")).toBe(true)
      } finally {
        github.restore()
      }
    })
  })
})

describe("generate-jitconfig 409", () => {
  test("deletes an offline idle runner with that exact name and retries", async () => {
    let created = false
    const github = installFetch((call) => {
      if (call.url.pathname.endsWith("/generate-jitconfig")) {
        if (!created) return text(409, "Already exists - A runner with the name already exists")
        return json(201, { runner: { id: 10 }, encoded_jit_config: "jit-2" })
      }
      if (call.method === "GET") {
        return json(200, {
          total_count: 2,
          runners: [
            orgRunner(3, "slot-0-other", "offline", false),
            orgRunner(9, "slot-0", "offline", false),
          ],
        })
      }
      if (call.method === "DELETE") {
        created = true
        return text(404, "")
      }
      throw new Error(`unexpected ${call.method} ${call.url}`)
    })
    try {
      const jit = await run(generateJitConfig(cfg("/unused"), "slot-0"))
      expect(jit).toEqual({ runnerId: 10, encodedJitConfig: "jit-2" })
      expect(deletes(github.calls)).toEqual(["/orgs/acme/actions/runners/9"])
      expect(github.calls.filter((call) => call.url.pathname.endsWith("/generate-jitconfig"))).toHaveLength(2)
    } finally {
      github.restore()
    }
  })

  const retained = [
    {
      name: "an online runner",
      runners: [orgRunner(7, "slot-0", "online", false)],
      message: "refusing to delete runner slot-0: id=7 is online",
    },
    {
      name: "a busy runner",
      runners: [orgRunner(8, "slot-0", "offline", true)],
      message: "refusing to delete runner slot-0: id=8 is offline, busy",
    },
    {
      name: "a runner whose busy flag is missing",
      runners: [orgRunner(4, "slot-0", "offline", undefined)],
      message: "refusing to delete runner slot-0: id=4 is offline, busy unknown",
    },
    {
      name: "two runners with the exact name",
      runners: [orgRunner(1, "slot-0", "offline", false), orgRunner(2, "slot-0", "offline", false)],
      message: "refusing to delete runner slot-0: 2 registrations use that name",
    },
  ]

  for (const spec of retained) {
    test(`does not delete ${spec.name}`, async () => {
      const github = installFetch((call) => {
        if (call.url.pathname.endsWith("/generate-jitconfig")) {
          return text(409, "Already exists - A runner with the name already exists")
        }
        if (call.method === "GET") {
          return json(200, { total_count: spec.runners.length, runners: spec.runners })
        }
        if (call.method === "DELETE") return text(204, "")
        throw new Error(`unexpected ${call.method} ${call.url}`)
      })
      try {
        await expect(run(generateJitConfig(cfg("/unused"), "slot-0"))).rejects.toThrow(spec.message)
        expect(deletes(github.calls)).toEqual([])
        expect(github.calls.filter((call) => call.method === "POST")).toHaveLength(1)
      } finally {
        github.restore()
      }
    })
  }

  test("does not delete a runner with a different name", async () => {
    let posts = 0
    const github = installFetch((call) => {
      if (call.url.pathname.endsWith("/generate-jitconfig")) {
        posts += 1
        if (posts === 1) return text(409, "Already exists - A runner with the name already exists")
        return json(201, { runner: { id: 11 }, encoded_jit_config: "jit" })
      }
      if (call.method === "GET") {
        return json(200, {
          total_count: 1,
          runners: [orgRunner(5, "slot-0-extra", "offline", false)],
        })
      }
      if (call.method === "DELETE") return text(204, "")
      throw new Error(`unexpected ${call.method} ${call.url}`)
    })
    try {
      const jit = await run(generateJitConfig(cfg("/unused"), "slot-0"))
      expect(jit.runnerId).toBe(11)
      expect(deletes(github.calls)).toEqual([])
    } finally {
      github.restore()
    }
  })
})

describe("registration cleanup", () => {
  test("deletes the registration after the runner exits so the next cycle can register", async () => {
    await withRoot(async (root) => {
      const runnersDir = path.join(root, "runners")
      const ran = path.join(root, "ran")
      await writeRunSh(path.join(runnersDir, ".bin-2.338.2"), versionScript("2.338.2", ran, 0))

      let registration: { id: number; name: string } | null = null
      let nextId = 40
      const created: Array<number> = []
      const github = installFetch((call) => {
        if (call.url.pathname === "/repos/actions/runner/releases/latest") {
          return json(200, { tag_name: "v2.338.2" })
        }
        if (call.url.pathname.endsWith("/generate-jitconfig")) {
          const name = JSON.parse(call.body ?? "{}").name as string
          if (registration?.name === name) {
            return text(409, "Already exists - A runner with the name already exists")
          }
          const id = nextId++
          registration = { id, name }
          created.push(id)
          return json(201, { runner: { id }, encoded_jit_config: "jit" })
        }
        if (call.method === "GET") {
          return json(200, {
            total_count: registration ? 1 : 0,
            runners: registration
              ? [orgRunner(registration.id, registration.name, "online", false)]
              : [],
          })
        }
        if (call.method === "DELETE") {
          const id = Number(call.url.pathname.split("/").pop())
          if (registration?.id === id) registration = null
          return text(404, "")
        }
        throw new Error(`unexpected ${call.method} ${call.url}`)
      })
      try {
        const cache = await runPlatform(makeReleaseCache)
        await runPlatform(runCycle(cfg(runnersDir), cache, 0))
        await runPlatform(runCycle(cfg(runnersDir), cache, 0))
        expect(created).toEqual([40, 41])
        expect(deletes(github.calls)).toEqual([
          "/orgs/acme/actions/runners/40",
          "/orgs/acme/actions/runners/41",
        ])
        expect(registration).toBeNull()
      } finally {
        github.restore()
      }
    })
  })

  test("deletes the registration when the runner is interrupted", async () => {
    await withRoot(async (root) => {
      const runnersDir = path.join(root, "runners")
      const started = path.join(root, "started")
      await writeRunSh(
        path.join(runnersDir, ".bin-2.338.2"),
        `#!/bin/sh\ntouch '${started}'\nwhile true; do sleep 0.2; done\n`,
      )
      let registrationId: number | null = null
      const github = installFetch((call) => {
        if (call.url.pathname === "/repos/actions/runner/releases/latest") {
          return json(200, { tag_name: "v2.338.2" })
        }
        if (call.url.pathname.endsWith("/generate-jitconfig")) {
          registrationId = 77
          return json(201, { runner: { id: 77 }, encoded_jit_config: "jit" })
        }
        if (call.method === "DELETE") {
          registrationId = null
          return text(404, "")
        }
        throw new Error(`unexpected ${call.method} ${call.url}`)
      })
      try {
        const cache = await runPlatform(makeReleaseCache)
        await runPlatform(
          Effect.gen(function* () {
            const fiber = yield* Effect.fork(runCycle(cfg(runnersDir), cache, 0))
            yield* Effect.promise(async () => {
              const deadline = Date.now() + 4000
              while (Date.now() < deadline) {
                try {
                  await access(started)
                  return
                } catch {
                  await new Promise((resolve) => setTimeout(resolve, 20))
                }
              }
              throw new Error("runner did not start")
            })
            yield* Fiber.interrupt(fiber)
          }),
        )
        expect(registrationId).toBeNull()
        expect(deletes(github.calls)).toEqual(["/orgs/acme/actions/runners/77"])
      } finally {
        github.restore()
      }
    })
  }, 10_000)
})
