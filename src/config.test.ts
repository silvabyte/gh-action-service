import { expect, test } from "bun:test"
import { ConfigProvider, Effect } from "effect"
import * as os from "node:os"
import { loadConfig, runnerLabels } from "./config.ts"

test("includes the host OS and architecture in JIT runner labels", async () => {
  const provider = ConfigProvider.fromMap(
    new Map([
      ["GITHUB_TOKEN", "test-token"],
      ["GITHUB_ORG", "test-org"],
    ]),
  )

  const config = await Effect.runPromise(Effect.withConfigProvider(provider)(loadConfig))
  const osLabel = os.platform() === "darwin" ? "macOS" : "Linux"
  const archLabel = os.arch() === "arm64" ? "ARM64" : "X64"

  expect(config.labels).toEqual(["self-hosted", osLabel, archLabel])
})

test("uses GitHub's standard labels on macOS ARM64", () => {
  expect(runnerLabels([], "darwin", "arm64")).toEqual(["self-hosted", "macOS", "ARM64"])
})

test("preserves custom labels without case-insensitive duplicates", () => {
  expect(runnerLabels(["self-hosted", "linux", "gpu"], "linux", "x64")).toEqual([
    "self-hosted",
    "Linux",
    "X64",
    "gpu",
  ])
})
