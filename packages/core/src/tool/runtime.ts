import type { ToolDefinition } from "@opencode-ai/ai"
import { Tool } from "@opencode-ai/schema/tool"
import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec"
import { Effect, JsonSchema, Schema, SchemaAST } from "effect"

export const definition = (tool: Tool.Info<any, any>): ToolDefinition => ({
  name: effectiveName(tool),
  description: tool.description,
  inputSchema: inputJsonSchema(tool.input),
  ...(tool.output === undefined ? {} : { outputSchema: outputJsonSchema(tool.output) }),
})

export const execute = (tool: Tool.Info<any, any>, input: unknown, context: Tool.Context) =>
  Effect.gen(function* () {
    const decoded = yield* decodeInput(tool.input, input)
    const result = yield* tool.execute(decoded, context)
    if (tool.output === undefined) {
      if ("output" in result) return yield* Effect.die("Tool result declared output without an output schema")
      return {
        output: undefined,
        content: normalizeContent(result.content),
        ...(result.metadata === undefined ? {} : { metadata: result.metadata }),
      }
    }
    if (!("output" in result)) return yield* new Tool.Error({ message: "Tool did not return its declared output" })
    const output = yield* encodeOutput(tool.output, result.output)
    return {
      output,
      content: normalizeContent(result.content, output),
      ...(result.metadata === undefined ? {} : { metadata: result.metadata }),
    }
  })

const decodeInput = (schema: Tool.ValueSchema<any>, value: unknown) =>
  attemptDecodeInput(schema, value).pipe(
    Effect.catchTag("Tool.Error", (error) => {
      // JSON Schema derived from Effect schemas advertises `X | null` for optional
      // fields because JSON cannot express undefined, so callers legitimately send
      // null to mean "omitted". Retry with null properties removed: schemas that
      // genuinely accept null succeed on the first attempt, and the original error
      // is reported when the retry cannot help.
      const stripped = withoutNullProperties(value)
      if (stripped === value) return error
      return attemptDecodeInput(schema, stripped).pipe(Effect.catchTag("Tool.Error", () => error))
    }),
  )

// Removes null-valued object properties recursively. Array elements are positional
// and stay untouched. Returns the input reference when nothing changed.
const withoutNullProperties = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    const items = value.map(withoutNullProperties)
    return items.some((item, index) => item !== value[index]) ? items : value
  }
  if (typeof value !== "object" || value === null) return value
  const entries = Object.entries(value).flatMap(([key, item]) =>
    item === null ? [] : [[key, withoutNullProperties(item)] as const],
  )
  const changed =
    entries.length !== Object.keys(value).length ||
    entries.some(([key, item]) => (value as Record<string, unknown>)[key] !== item)
  return changed ? Object.fromEntries(entries) : value
}

const attemptDecodeInput = (schema: Tool.ValueSchema<any>, value: unknown) => {
  if (Schema.isSchema(schema)) {
    if (isForeignSchema(schema)) return foreignSchemaPassthrough(value)
    return Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError((error) => new Tool.Error({ message: `Invalid tool input: ${error.message}` })),
    )
  }
  if (isStandardSchema(schema)) return validateStandard(schema, value, "Invalid tool input")
  return Effect.succeed(value)
}

const encodeOutput = (schema: Tool.ValueSchema<any>, value: unknown) => {
  if (Schema.isSchema(schema)) {
    if (isForeignSchema(schema)) return foreignSchemaPassthrough(value)
    return Schema.encodeEffect(schema)(value).pipe(
      Effect.mapError(
        (error) =>
          new Tool.Error({ message: `Tool returned an invalid value for its output schema: ${error.message}` }),
      ),
    )
  }
  if (isStandardSchema(schema))
    return validateStandard(schema, value, "Tool returned an invalid value for its output schema")
  return Schema.decodeUnknownEffect(Schema.Json)(value).pipe(
    Effect.mapError(
      (error) => new Tool.Error({ message: `Tool returned a non-JSON value for its output schema: ${error.message}` }),
    ),
  )
}

// A schema created by a different copy of `effect` (for example one loaded from a
// plugin's own node_modules) still satisfies `Schema.isSchema` because the type
// identifier is a shared string, but it cannot be interpreted by this instance:
// schema parsing relies on per-instance sentinels and class identity, so checks
// false-fail on valid values and branded types die as defects. AST classes are plain
// classes, so an instanceof test against this instance's AST base distinguishes the
// two reliably.
const isForeignSchema = (schema: Schema.Top) => !(schema.ast instanceof SchemaAST.Base)

// Current @opencode-ai/plugin versions convert plugin schemas to Standard Schema
// wrappers before registration, keeping validation in the authoring instance. For
// plugins built against older versions, skip validation rather than misvalidate.
const foreignSchemaPassthrough = (value: unknown) =>
  Effect.logWarning(
    "Tool schema was created by a different `effect` module instance; skipping validation. Update the plugin's @opencode-ai/plugin dependency to restore validation.",
  ).pipe(Effect.as(value))

const isStandardSchema = (
  schema: Tool.ValueSchema<any>,
): schema is StandardSchemaV1<any, any> & StandardJSONSchemaV1<any, any> =>
  typeof schema === "object" && schema !== null && "~standard" in schema

const validateStandard = (
  schema: StandardSchemaV1<any, any> & StandardJSONSchemaV1<any, any>,
  value: unknown,
  prefix: string,
) =>
  Effect.gen(function* () {
    const pending = yield* Effect.try({
      try: () => schema["~standard"].validate(value),
      catch: (error) => standardFailure(prefix, error),
    })
    const result =
      pending instanceof Promise
        ? yield* Effect.tryPromise({ try: () => pending, catch: (error) => standardFailure(prefix, error) })
        : pending
    if (result.issues)
      return yield* new Tool.Error({
        message: `${prefix}: ${result.issues.map(standardIssueText).join(", ")}`,
      })
    return result.value
  })

const standardIssueText = (issue: StandardSchemaV1.Issue) => {
  if (issue.path === undefined || issue.path.length === 0) return issue.message
  const segments = issue.path.map((segment) =>
    typeof segment === "object" && segment !== null && "key" in segment ? segment.key : segment,
  )
  return `${issue.message} at ${JSON.stringify(segments)}`
}

const standardFailure = (prefix: string, error: unknown) =>
  new Tool.Error({ message: `${prefix}: ${error instanceof Error ? error.message : String(error)}` })

const inputJsonSchema = (schema: Tool.ValueSchema<any>): JsonSchema.JsonSchema => {
  if (schema === undefined || schema === null) return {}
  if (isStandardSchema(schema))
    return schema["~standard"].jsonSchema.input({ target: "draft-2020-12" }) as JsonSchema.JsonSchema
  return Schema.isSchema(schema) ? toJsonSchema(schema) : (schema as JsonSchema.JsonSchema)
}

const outputJsonSchema = (schema: Tool.ValueSchema<any>): JsonSchema.JsonSchema => {
  if (isStandardSchema(schema))
    return schema["~standard"].jsonSchema.output({ target: "draft-2020-12" }) as JsonSchema.JsonSchema
  return Schema.isSchema(schema) ? toJsonSchema(schema) : (schema as JsonSchema.JsonSchema)
}

const toJsonSchema = (schema: Schema.Top): JsonSchema.JsonSchema => {
  const document = Schema.toJsonSchemaDocument(schema)
  // Effect emits valid JSON Schema that some inference providers handle poorly. Simplify it
  // without changing validation: `{ type: "integer", allOf: [{ minimum: 0 }] }` becomes
  // `{ type: "integer", minimum: 0 }` only when no keyword would be overwritten. Named schemas
  // emit `$ref` plus root `$defs`; inline acyclic local references so providers receive the full
  // nested schema directly, then remove unused `$defs`. Recursive references stay intact because
  // expanding them would never terminate.
  const normalized = flattenAllOf(
    Object.keys(document.definitions).length === 0
      ? document.schema
      : { ...document.schema, $defs: document.definitions },
  )
  return dropDefinitionsIfResolved(inlineLocalReferences(normalized)) as JsonSchema.JsonSchema
}

const flattenAllOf = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(flattenAllOf)
  if (typeof value !== "object" || value === null) return value

  const schema = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, flattenAllOf(item)]))
  if (!Array.isArray(schema.allOf) || !schema.allOf.every(isRecord) || !canFlattenAllOf(schema.allOf, schema))
    return schema
  const { allOf, ...rest } = schema
  return flattenAllOf({ ...Object.assign({}, ...allOf), ...rest })
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const canFlattenAllOf = (allOf: ReadonlyArray<Record<string, unknown>>, parent: Record<string, unknown>) => {
  const keys = new Set(Object.keys(parent).filter((key) => key !== "allOf"))
  return allOf.every((item) =>
    Object.keys(item).every((key) => {
      if (keys.has(key)) return false
      keys.add(key)
      return true
    }),
  )
}

const inlineLocalReferences = (
  value: unknown,
  definitions?: Record<string, unknown>,
  seen = new Set<string>(),
): unknown => {
  if (Array.isArray(value)) return value.map((item) => inlineLocalReferences(item, definitions, seen))
  if (!isRecord(value)) return value

  const localDefinitions = definitions ?? (isRecord(value.$defs) ? value.$defs : undefined)
  if (typeof value.$ref === "string" && localDefinitions) {
    const segment = value.$ref.match(/^#\/\$defs\/([^/]+)$/)?.[1]
    const name = segment?.replaceAll("~1", "/").replaceAll("~0", "~")
    if (name && !seen.has(name)) {
      const target = localDefinitions[name]
      if (target) {
        const { $ref: _, ...rest } = value
        const resolvedTarget = inlineLocalReferences(target, localDefinitions, new Set(seen).add(name))
        const resolvedSiblings = inlineLocalReferences(rest, localDefinitions, seen)
        if (!isRecord(resolvedTarget) || !isRecord(resolvedSiblings)) return resolvedTarget
        if (canMergeRecords(resolvedTarget, resolvedSiblings)) return { ...resolvedTarget, ...resolvedSiblings }
        return { allOf: [resolvedTarget, resolvedSiblings] }
      }
    }
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, inlineLocalReferences(item, localDefinitions, seen)]),
  )
}

const canMergeRecords = (left: Record<string, unknown>, right: Record<string, unknown>) =>
  Object.keys(left).every((key) => !(key in right))

const dropDefinitionsIfResolved = (value: unknown): unknown => {
  if (!isRecord(value) || hasLocalReference(value)) return value
  const { $defs: _, ...rest } = value
  return rest
}

const hasLocalReference = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(hasLocalReference)
  if (!isRecord(value)) return false
  if (typeof value.$ref === "string" && value.$ref.startsWith("#/$defs/")) return true
  return Object.values(value).some(hasLocalReference)
}

export const normalizeContent = (value: string | ReadonlyArray<Tool.Content> | undefined, output?: unknown) => {
  if (typeof value === "string") return [{ type: "text" as const, text: value }]
  if (value !== undefined && value.length > 0) return [...value]
  return [{ type: "text" as const, text: stringify(output) }]
}

const stringify = (value: unknown) => {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

const normalizedName = (tool: Tool.Info) => tool.name.replace(/[^a-zA-Z0-9_-]/g, "_")

const effectiveName = (tool: Tool.Info) =>
  tool.options?.namespace === undefined
    ? normalizedName(tool)
    : `${tool.options.namespace.replaceAll(".", "_")}_${normalizedName(tool)}`
