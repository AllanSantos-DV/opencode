import { beforeAll, expect, test } from "bun:test"
import { cp, mkdir, mkdtemp, readFile, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Tool } from "@opencode-ai/core/tool"
import { definition, execute } from "@opencode-ai/core/tool/runtime"
import { Agent } from "@opencode-ai/schema/agent"
import { Session } from "@opencode-ai/schema/session"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import type { Info } from "@opencode-ai/schema/tool"
import { Effect, Schema } from "effect"

const context = {
  sessionID: Session.ID.make("ses_foreign"),
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_foreign"),
  id: Tool.CallID.make("call_foreign"),
  progress: () => Effect.void,
}

// Plugins load `effect` from their own node_modules, so their schemas come from a
// different module instance than the host's. Simulate that by copying the effect
// package to a temporary directory and importing the copy: same version, distinct
// instance, exactly like a plugin installed in the config directory.
let foreign: typeof Schema

beforeAll(async () => {
  const source = path.dirname(fileURLToPath(import.meta.resolve("effect/package.json")))
  const base = await mkdtemp(path.join(tmpdir(), "opencode-foreign-effect-"))
  const target = path.join(base, "node_modules", "effect")
  await cp(source, target, { recursive: true })
  const dependencies = JSON.parse(await readFile(path.join(source, "package.json"), "utf8")).dependencies ?? {}
  for (const name of Object.keys(dependencies)) {
    const real = path.dirname(Bun.resolveSync(`${name}/package.json`, source))
    const link = path.join(base, "node_modules", name)
    await mkdir(path.dirname(link), { recursive: true })
    await symlink(real, link, "dir")
  }
  const mod = (await import(pathToFileURL(path.join(target, "dist", "index.js")).href)) as { Schema: typeof Schema }
  foreign = mod.Schema
  expect<unknown>(foreign).not.toBe(Schema)
})

test("foreign live schemas skip validation instead of misvalidating checks", async () => {
  // Regression: a minLength check from a foreign instance used to fail on valid
  // values ('Expected a value with a length of at least 1 at ["title"]') because the
  // host parser hands the foreign filter an internal sentinel instead of the value.
  const input = foreign.Struct({
    title: foreign.optional(foreign.String.check(foreign.isMinLength(1))),
    prompt: foreign.optional(foreign.String),
  })
  expect(Schema.isSchema(input)).toBe(true)
  let received: unknown
  const tool: Info = {
    name: "create",
    description: "Create",
    input,
    execute: (value) => {
      received = value
      return Effect.succeed({ content: "ok" })
    },
  }
  const result = await Effect.runPromise(execute(tool, { title: "probe", prompt: "Say ready." }, context))
  expect(result.content).toEqual([{ type: "text", text: "ok" }])
  expect(received).toEqual({ title: "probe", prompt: "Say ready." })
})

test("foreign branded schemas no longer die as defects", async () => {
  // Regression: decoding a foreign branded ID (like Session.ID) threw "Sync adapter
  // can only throw schema errors", surfacing as a bare "Tool execution failed".
  const input = foreign.Struct({
    sessionID: foreign.String.check(foreign.isStartsWith("ses")).pipe(foreign.brand("SessionID")),
  })
  const tool: Info = {
    name: "notify",
    description: "Notify",
    input,
    execute: (value) => Effect.succeed({ content: JSON.stringify(value) }),
  }
  const result = await Effect.runPromise(execute(tool, { sessionID: "ses_123" }, context))
  expect(result.content).toEqual([{ type: "text", text: '{"sessionID":"ses_123"}' }])
})

test("foreign output schemas pass the produced value through", async () => {
  const tool: Info = {
    name: "get",
    description: "Get",
    input: foreign.Struct({}),
    output: foreign.Struct({ sessionID: foreign.String }),
    execute: () => Effect.succeed({ output: { sessionID: "ses_123" } }),
  }
  const result = await Effect.runPromise(execute(tool, {}, context))
  expect(result.output).toEqual({ sessionID: "ses_123" })
})

// Mirrors the conversion current @opencode-ai/plugin versions perform in the
// authoring instance before registration (see packages/plugin/src/effect/tool-schema.ts).
const convert = (schema: unknown, direction: "input" | "output") => {
  const anyForeign = foreign as any
  const oriented = direction === "input" ? schema : anyForeign.flip(schema)
  const augmented = anyForeign.toStandardJSONSchemaV1(anyForeign.toStandardSchemaV1(oriented))
  return { "~standard": augmented["~standard"] } as Info["input"]
}

test("converted standard wrappers validate in the authoring instance", async () => {
  const input = convert(
    foreign.Struct({
      title: foreign.optional(foreign.String.check(foreign.isMinLength(1))),
    }),
    "input",
  )
  expect(Schema.isSchema(input)).toBe(false)
  let received: unknown
  const tool: Info = {
    name: "create",
    description: "Create",
    input,
    output: convert(foreign.Struct({ sessionID: foreign.String }), "output"),
    execute: (value) => {
      received = value
      return Effect.succeed({ output: { sessionID: "ses_123" }, content: "created" })
    },
  }

  const success = await Effect.runPromise(execute(tool, { title: "probe" }, context))
  expect(received).toEqual({ title: "probe" })
  expect(success.output).toEqual({ sessionID: "ses_123" })

  const failure = await Effect.runPromiseExit(execute(tool, { title: "" }, context))
  expect(failure.toString()).toContain("Invalid tool input")
  expect(failure.toString()).toContain("a value with a length of at least 1")
  expect(failure.toString()).toContain('at ["title"]')

  const derived = definition(tool)
  expect(derived.inputSchema).toMatchObject({ type: "object" })
  expect((derived.inputSchema as { properties?: Record<string, unknown> }).properties).toHaveProperty("title")
})
