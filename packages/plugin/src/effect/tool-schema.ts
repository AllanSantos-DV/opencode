import { Schema } from "effect"
import type { Tool } from "@opencode-ai/schema/tool"

/**
 * Converts a tool's Effect schemas into detached Standard Schema wrappers so they
 * survive the crossing from the plugin's module world into the host.
 *
 * Plugins often load their own copy of `effect` (for example from the config
 * directory's node_modules) while the host bundles a different instance. A live
 * Effect schema cannot be interpreted across that boundary: schema parsing relies on
 * per-instance sentinels and class identity, so the host misvalidates checks and
 * turns branded-type failures into defects. A Standard Schema wrapper instead carries
 * validation and JSON Schema generation as closures bound to the instance that
 * created the schema, which the host invokes as-is.
 */
export function instanceSafeTool(tool: Tool.Info<any, any>): Tool.Info<any, any> {
  const input = instanceSafeValueSchema(tool.input, "input")
  const output = tool.output === undefined ? undefined : instanceSafeValueSchema(tool.output, "output")
  if (input === tool.input && output === tool.output) return tool
  return { ...tool, input, ...(output === undefined ? {} : { output }) }
}

function instanceSafeValueSchema(schema: Tool.ValueSchema<any>, direction: "input" | "output"): Tool.ValueSchema<any> {
  if (!Schema.isSchema(schema)) return schema
  // Inputs are decoded (Encoded -> Type) but outputs are encoded (Type -> Encoded),
  // so outputs use the flipped schema: its standard `validate` runs in the encode
  // direction and its `jsonSchema.output` still describes the encoded shape.
  const oriented = direction === "input" ? (schema as Schema.Top) : Schema.flip(schema as Schema.Top)
  // Both converters augment the schema object in place and return it; the host must
  // receive a plain wrapper instead, because the augmented object still satisfies
  // `Schema.isSchema` and would route back into cross-instance interpretation.
  const augmented = Schema.toStandardJSONSchemaV1(
    Schema.toStandardSchemaV1(oriented as never) as never,
  ) as unknown as StandardWrapper
  return { "~standard": augmented["~standard"] } as Tool.ValueSchema<any>
}

type StandardWrapper = { readonly "~standard": Record<string, unknown> }
