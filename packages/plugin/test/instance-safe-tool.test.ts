import { expect, test } from "bun:test"
import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec"
import { Effect, Schema } from "effect"
import { Plugin } from "../src/effect/index.js"
import type { Tool } from "@opencode-ai/schema/tool"

// `define` must hand the host detached Standard Schema wrappers instead of live
// Effect schemas: hosts may run a different `effect` instance, which cannot
// interpret foreign schemas (checks false-fail and branded types die as defects).
const collectTool = async (tool: Tool.Info<any, any>) => {
  const added: Array<Tool.Info<any, any>> = []
  const context = {
    tool: {
      transform: (callback: (draft: { add: (tool: Tool.Info<any, any>) => void }) => void) => {
        callback({ add: (item) => added.push(item) })
        return Effect.succeed({ dispose: Effect.void })
      },
    },
  } as unknown as Plugin.Context
  const plugin = Plugin.define({
    id: "test.instance-safe",
    effect: (ctx) => ctx.tool.transform((draft) => draft.add(tool)).pipe(Effect.asVoid),
  })
  await Effect.runPromise(Effect.scoped(plugin.effect(context)))
  expect(added).toHaveLength(1)
  return added[0]
}

type StandardValue = StandardSchemaV1<any, any> & StandardJSONSchemaV1<any, any>

test("define converts Effect schemas to detached standard wrappers", async () => {
  const execute = (input: { title?: string }) => Effect.succeed({ output: { id: `ses_${input.title}` } })
  const registered = await collectTool({
    name: "create",
    description: "Create",
    input: Schema.Struct({ title: Schema.optional(Schema.String.check(Schema.isMinLength(1))) }),
    output: Schema.Struct({ id: Schema.String }),
    execute,
  })

  expect(registered.execute).toBe(execute)
  expect(Schema.isSchema(registered.input)).toBe(false)
  expect(Schema.isSchema(registered.output)).toBe(false)

  const input = registered.input as StandardValue
  expect(await input["~standard"].validate({ title: "probe" })).toEqual({ value: { title: "probe" } })
  const invalid = await input["~standard"].validate({ title: "" })
  expect(invalid.issues?.[0]?.message).toContain("a value with a length of at least 1")
  expect(input["~standard"].jsonSchema.input({ target: "draft-2020-12" })).toMatchObject({ type: "object" })

  // Outputs validate in the encode direction (Type -> Encoded) and describe the
  // encoded shape.
  const output = registered.output as StandardValue
  expect(await output["~standard"].validate({ id: "ses_x" })).toEqual({ value: { id: "ses_x" } })
  expect(output["~standard"].jsonSchema.output({ target: "draft-2020-12" })).toMatchObject({
    type: "object",
    required: ["id"],
  })
})

test("define leaves non-Effect schemas untouched", async () => {
  const input = { type: "object" as const }
  const registered = await collectTool({
    name: "raw",
    description: "Raw",
    input,
    execute: () => Effect.succeed({ content: "ok" }),
  })
  expect(registered.input).toBe(input)
  expect(registered.output).toBeUndefined()
})
