export * as StructuredOutput from "./structured-output"

import { Effect, JsonSchema, Schema } from "effect"
import { automaticRead } from "./effect-semantics"
import { Tool, type AnyTool } from "./tool"

export const name = "StructuredOutput"
export const description =
  "Submit the final answer in the requested structured format as one JSON object that exactly matches the requested schema. Call this only after all other work is complete."

export const systemPrompt = (input: { readonly retriesUsed: number; readonly retryCount: number }) => {
  const remaining = Math.max(0, input.retryCount - input.retriesUsed)
  return [
    "The user requested structured output.",
    `Complete any research or actions first, then call ${name} exactly once as the only tool call in the final step.`,
    "The tool input is the final answer and must exactly satisfy its JSON Schema; a prose-only answer is not completion.",
    `There ${remaining === 1 ? "is" : "are"} ${remaining} structured-output ${remaining === 1 ? "retry" : "retries"} remaining after this attempt.`,
  ].join(" ")
}

/** Stable user-visible failure shared by every execution root. */
export const exhaustedMessage = (retryCount: number) =>
  `The model did not produce valid structured output after ${retryCount + 1} ` +
  `${retryCount === 0 ? "attempt" : "attempts"}. Expected one ${name} call ` +
  "whose JSON object exactly matches the requested schema."

export class InvalidSchemaError extends Schema.TaggedErrorClass<InvalidSchemaError>()(
  "StructuredOutput.InvalidSchemaError",
  { message: Schema.String },
) {}

export interface Prepared {
  readonly schema: JsonSchema.JsonSchema
  readonly tool: AnyTool
}

type JsonRecord = Record<string, unknown>
type ValidationIssue = { readonly path: string; readonly reason: string }

const maxSchemaBytes = 64 * 1024
const maxSchemaDepth = 32
const maxSchemaNodes = 2_048
const maxValidationSteps = 100_000
const maxStructuredOutputBytes = 48 * 1024
const schemaTypes = new Set(["null", "string", "number", "integer", "boolean", "object", "array"])
const allowedKeys = new Set([
  "$ref",
  "$defs",
  "definitions",
  "$comment",
  "type",
  "const",
  "enum",
  "allOf",
  "anyOf",
  "oneOf",
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "properties",
  "required",
  "additionalProperties",
  "patternProperties",
  "propertyNames",
  "minProperties",
  "maxProperties",
  "items",
  "prefixItems",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
])

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const pointer = (path: string, key: string | number) =>
  typeof key === "number" ? `${path}[${key}]` : `${path}.${key.replaceAll("~", "~0").replaceAll(".", "\\.")}`

const fail = (message: string): never => {
  throw new InvalidSchemaError({ message })
}

function assert(condition: unknown, path: string, message: string): asserts condition {
  if (!condition) fail(`${path}: ${message}`)
}

const nonNegativeInteger = (value: unknown) => Number.isInteger(value) && Number(value) >= 0
const finiteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)
const schemaValue = (value: unknown) => value === true || value === false || isRecord(value)
const literalValue = (value: unknown) =>
  value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean"

const decodePointerToken = (value: string) => value.replaceAll("~1", "/").replaceAll("~0", "~")

const immutable = <T>(value: T): T => {
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) {
      for (const child of item) visit(child)
      Object.freeze(item)
      return
    }
    if (isRecord(item)) {
      for (const child of Object.values(item)) visit(child)
      Object.freeze(item)
    }
  }
  visit(value)
  return value
}

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  return `{${Object.keys(value as JsonRecord)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as JsonRecord)[key])}`)
    .join(",")}}`
}

const inspectSchema = (root: JsonRecord) => {
  let nodes = 0
  const patterns = new WeakMap<object, RegExp>()

  const inspect = (value: unknown, path: string, depth: number, rootNode = false): void => {
    assert(depth <= maxSchemaDepth, path, `schema nesting exceeds ${maxSchemaDepth}`)
    assert(schemaValue(value), path, "a schema must be an object or boolean")
    if (typeof value === "boolean") return
    nodes += 1
    assert(nodes <= maxSchemaNodes, path, `schema contains more than ${maxSchemaNodes} nodes`)

    for (const key of Object.keys(value)) assert(allowedKeys.has(key), pointer(path, key), "unsupported keyword")
    if (!rootNode) {
      assert(value.$defs === undefined, path, "$defs is supported only at the root")
      assert(value.definitions === undefined, path, "definitions is supported only at the root")
    }

    if (value.$ref !== undefined) {
      assert(typeof value.$ref === "string", pointer(path, "$ref"), "must be a string")
      assert(
        /^#\/(?:\$defs|definitions)\/[^/]+$/.test(value.$ref),
        pointer(path, "$ref"),
        "only direct local #/$defs/<name> or #/definitions/<name> references are supported",
      )
    }

    if (rootNode) {
      for (const keyword of ["$defs", "definitions"] as const) {
        const definitions = value[keyword]
        if (definitions === undefined) continue
        assert(isRecord(definitions), pointer(path, keyword), "must be an object")
        for (const [key, member] of Object.entries(definitions))
          inspect(member, pointer(pointer(path, keyword), key), depth + 1)
      }
    }

    if (value.type !== undefined) {
      const types = Array.isArray(value.type) ? value.type : [value.type]
      assert(types.length > 0, pointer(path, "type"), "must not be empty")
      assert(
        types.every((item) => typeof item === "string" && schemaTypes.has(item)),
        pointer(path, "type"),
        "contains an unsupported type",
      )
      assert(new Set(types).size === types.length, pointer(path, "type"), "contains duplicate types")
    }

    if ("const" in value)
      assert(literalValue(value.const), pointer(path, "const"), "only primitive or null constants are supported")
    if (value.enum !== undefined) {
      assert(Array.isArray(value.enum) && value.enum.length > 0, pointer(path, "enum"), "must be a non-empty array")
      assert(value.enum.every(literalValue), pointer(path, "enum"), "only primitive or null enum values are supported")
      assert(
        new Set(value.enum.map(canonical)).size === value.enum.length,
        pointer(path, "enum"),
        "contains duplicate values",
      )
    }

    for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
      const members = value[keyword]
      if (members === undefined) continue
      assert(Array.isArray(members) && members.length > 0, pointer(path, keyword), "must be a non-empty array")
      members.forEach((member, index) => inspect(member, pointer(pointer(path, keyword), index), depth + 1))
    }

    for (const keyword of ["title", "description", "$comment"] as const)
      if (value[keyword] !== undefined)
        assert(typeof value[keyword] === "string", pointer(path, keyword), "must be a string")
    if (value.examples !== undefined)
      assert(Array.isArray(value.examples), pointer(path, "examples"), "must be an array")
    for (const keyword of ["deprecated", "readOnly", "writeOnly"] as const)
      if (value[keyword] !== undefined)
        assert(typeof value[keyword] === "boolean", pointer(path, keyword), "must be a boolean")

    for (const keyword of ["properties", "patternProperties"] as const) {
      const properties = value[keyword]
      if (properties === undefined) continue
      assert(isRecord(properties), pointer(path, keyword), "must be an object")
      for (const [key, member] of Object.entries(properties)) {
        if (keyword === "patternProperties") {
          try {
            new RegExp(key, "u")
          } catch (error) {
            fail(
              `${pointer(pointer(path, keyword), key)}: invalid regular expression (${error instanceof Error ? error.message : String(error)})`,
            )
          }
        }
        inspect(member, pointer(pointer(path, keyword), key), depth + 1)
      }
    }
    if (value.required !== undefined) {
      assert(Array.isArray(value.required), pointer(path, "required"), "must be an array")
      assert(
        value.required.every((item) => typeof item === "string"),
        pointer(path, "required"),
        "must contain only strings",
      )
      assert(
        new Set(value.required).size === value.required.length,
        pointer(path, "required"),
        "contains duplicate names",
      )
    }
    for (const keyword of ["additionalProperties", "propertyNames"] as const)
      if (value[keyword] !== undefined) inspect(value[keyword], pointer(path, keyword), depth + 1)

    for (const keyword of ["items"] as const)
      if (value[keyword] !== undefined) inspect(value[keyword], pointer(path, keyword), depth + 1)
    if (value.prefixItems !== undefined) {
      assert(Array.isArray(value.prefixItems), pointer(path, "prefixItems"), "must be an array")
      value.prefixItems.forEach((member, index) =>
        inspect(member, pointer(pointer(path, "prefixItems"), index), depth + 1),
      )
    }

    for (const keyword of ["minProperties", "maxProperties", "minItems", "maxItems", "minLength", "maxLength"] as const)
      if (value[keyword] !== undefined)
        assert(nonNegativeInteger(value[keyword]), pointer(path, keyword), "must be a non-negative integer")
    for (const [minimum, maximum] of [
      ["minProperties", "maxProperties"],
      ["minItems", "maxItems"],
      ["minLength", "maxLength"],
    ] as const)
      if (value[minimum] !== undefined && value[maximum] !== undefined)
        assert(Number(value[minimum]) <= Number(value[maximum]), path, `${minimum} must not exceed ${maximum}`)
    if (value.uniqueItems !== undefined)
      assert(typeof value.uniqueItems === "boolean", pointer(path, "uniqueItems"), "must be a boolean")

    if (value.pattern !== undefined) {
      assert(typeof value.pattern === "string", pointer(path, "pattern"), "must be a string")
      try {
        patterns.set(value, new RegExp(value.pattern, "u"))
      } catch (error) {
        fail(
          `${pointer(path, "pattern")}: invalid regular expression (${error instanceof Error ? error.message : String(error)})`,
        )
      }
    }
    for (const keyword of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"] as const)
      if (value[keyword] !== undefined)
        assert(finiteNumber(value[keyword]), pointer(path, keyword), "must be a finite number")
    const multipleOf = value.multipleOf
    if (multipleOf !== undefined) {
      assert(finiteNumber(multipleOf), pointer(path, "multipleOf"), "must be a finite number")
      assert(multipleOf > 0, pointer(path, "multipleOf"), "must be greater than zero")
    }
  }

  inspect(root, "$", 0, true)

  const definitions = new Map<string, unknown>()
  for (const keyword of ["$defs", "definitions"] as const) {
    const source = root[keyword]
    if (source === undefined) continue
    assert(isRecord(source), `$.${keyword}`, "must be an object")
    for (const [key, schema] of Object.entries(source)) {
      assert(
        !definitions.has(key),
        `$.${keyword}.${key}`,
        "duplicates a definition name from the other definition collection",
      )
      definitions.set(key, schema)
    }
  }
  const refs = new Set<string>()
  const collectRefs = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(collectRefs)
    if (!isRecord(value)) return
    if (typeof value.$ref === "string") refs.add(decodePointerToken(value.$ref.split("/").at(-1)!))
    Object.values(value).forEach(collectRefs)
  }
  collectRefs(root)
  for (const ref of refs) assert(definitions.has(ref), "$.$ref", `references missing definition ${JSON.stringify(ref)}`)
  return { definitions, patterns }
}

const makeValidator = (
  root: JsonRecord,
  compiled: ReturnType<typeof inspectSchema>,
): ((input: unknown) => ValidationIssue | undefined) => {
  return (input) => {
    const jsonSeen = new Set<object>()
    const jsonIssue = (value: unknown, path: string): ValidationIssue | undefined => {
      if (value === null || typeof value === "string" || typeof value === "boolean") return
      if (typeof value === "number")
        return Number.isFinite(value) ? undefined : { path, reason: "must be a finite JSON number" }
      if (typeof value !== "object") return { path, reason: "must be a JSON value" }
      if (jsonSeen.has(value)) return { path, reason: "must not contain a cycle" }
      jsonSeen.add(value)
      try {
        if (Array.isArray(value)) {
          for (let index = 0; index < value.length; index++) {
            const issue = jsonIssue(value[index], pointer(path, index))
            if (issue) return issue
          }
          return
        }
        if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
          return { path, reason: "must contain only plain JSON objects" }
        for (const [key, member] of Object.entries(value)) {
          const issue = jsonIssue(member, pointer(path, key))
          if (issue) return issue
        }
        return
      } finally {
        jsonSeen.delete(value)
      }
    }
    const invalidJson = jsonIssue(input, "$")
    if (invalidJson) return invalidJson
    const outputBytes = new TextEncoder().encode(JSON.stringify(input)).byteLength
    if (outputBytes > maxStructuredOutputBytes)
      return {
        path: "$",
        reason: `serialized output is ${outputBytes} bytes; maximum is ${maxStructuredOutputBytes}`,
      }
    let steps = 0
    const active = new Map<object, Set<unknown>>()

    const validate = (schema: unknown, value: unknown, path: string): ValidationIssue | undefined => {
      steps += 1
      if (steps > maxValidationSteps) return { path, reason: "validation complexity exceeded the safe bound" }
      if (schema === true) return
      if (schema === false) return { path, reason: "is rejected by a false schema" }
      if (!isRecord(schema)) return { path, reason: "encountered an invalid runtime schema node" }

      const seen = active.get(schema)
      if (seen?.has(value)) return
      if (seen) seen.add(value)
      else active.set(schema, new Set([value]))
      try {
        if (typeof schema.$ref === "string") {
          const ref = decodePointerToken(schema.$ref.split("/").at(-1)!)
          const issue = validate(compiled.definitions.get(ref), value, path)
          if (issue) return issue
        }
        if ("const" in schema && canonical(value) !== canonical(schema.const))
          return { path, reason: `must equal ${canonical(schema.const)}` }
        if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => canonical(candidate) === canonical(value)))
          return { path, reason: `must be one of ${schema.enum.map(canonical).join(", ")}` }

        if (Array.isArray(schema.allOf))
          for (const member of schema.allOf) {
            const issue = validate(member, value, path)
            if (issue) return issue
          }
        if (Array.isArray(schema.anyOf) && !schema.anyOf.some((member) => validate(member, value, path) === undefined))
          return { path, reason: "must satisfy at least one anyOf branch" }
        if (Array.isArray(schema.oneOf)) {
          const matches = schema.oneOf.filter((member) => validate(member, value, path) === undefined).length
          if (matches !== 1) return { path, reason: `must satisfy exactly one oneOf branch (matched ${matches})` }
        }

        const actualType =
          value === null
            ? "null"
            : Array.isArray(value)
              ? "array"
              : typeof value === "number" && Number.isInteger(value)
                ? "integer"
                : typeof value
        const expected =
          schema.type === undefined ? undefined : Array.isArray(schema.type) ? schema.type : [schema.type]
        if (
          expected &&
          !expected.some((type) => type === actualType || (type === "number" && actualType === "integer"))
        )
          return { path, reason: `must be ${expected.join(" or ")}; received ${actualType}` }

        if (typeof value === "number") {
          if (!Number.isFinite(value)) return { path, reason: "must be a finite JSON number" }
          if (typeof schema.minimum === "number" && value < schema.minimum)
            return { path, reason: `must be >= ${schema.minimum}` }
          if (typeof schema.maximum === "number" && value > schema.maximum)
            return { path, reason: `must be <= ${schema.maximum}` }
          if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum)
            return { path, reason: `must be > ${schema.exclusiveMinimum}` }
          if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum)
            return { path, reason: `must be < ${schema.exclusiveMaximum}` }
          if (typeof schema.multipleOf === "number") {
            const quotient = value / schema.multipleOf
            const tolerance = Number.EPSILON * Math.max(1, Math.abs(quotient)) * 8
            if (Math.abs(quotient - Math.round(quotient)) > tolerance)
              return { path, reason: `must be a multiple of ${schema.multipleOf}` }
          }
        }

        if (typeof value === "string") {
          const length = [...value].length
          if (typeof schema.minLength === "number" && length < schema.minLength)
            return { path, reason: `must contain at least ${schema.minLength} Unicode characters` }
          if (typeof schema.maxLength === "number" && length > schema.maxLength)
            return { path, reason: `must contain at most ${schema.maxLength} Unicode characters` }
          const pattern = compiled.patterns.get(schema)
          if (pattern && !pattern.test(value)) return { path, reason: `must match ${pattern}` }
        }

        if (Array.isArray(value)) {
          if (typeof schema.minItems === "number" && value.length < schema.minItems)
            return { path, reason: `must contain at least ${schema.minItems} items` }
          if (typeof schema.maxItems === "number" && value.length > schema.maxItems)
            return { path, reason: `must contain at most ${schema.maxItems} items` }
          if (schema.uniqueItems === true && new Set(value.map(canonical)).size !== value.length)
            return { path, reason: "must contain unique items" }
          const prefix = Array.isArray(schema.prefixItems) ? schema.prefixItems : []
          for (let index = 0; index < value.length; index++) {
            const itemSchema = index < prefix.length ? prefix[index] : schema.items
            if (itemSchema === undefined) continue
            const issue = validate(itemSchema, value[index], pointer(path, index))
            if (issue) return issue
          }
        }

        if (isRecord(value)) {
          const keys = Object.keys(value)
          if (typeof schema.minProperties === "number" && keys.length < schema.minProperties)
            return { path, reason: `must contain at least ${schema.minProperties} properties` }
          if (typeof schema.maxProperties === "number" && keys.length > schema.maxProperties)
            return { path, reason: `must contain at most ${schema.maxProperties} properties` }
          const required = Array.isArray(schema.required) ? schema.required : []
          for (const key of required)
            if (!Object.hasOwn(value, key)) return { path: pointer(path, key), reason: "is required" }

          const properties = isRecord(schema.properties) ? schema.properties : {}
          const patternProperties = isRecord(schema.patternProperties) ? schema.patternProperties : {}
          for (const key of keys) {
            if (schema.propertyNames !== undefined) {
              const issue = validate(schema.propertyNames, key, pointer(path, key))
              if (issue) return { path: issue.path, reason: `property name ${issue.reason}` }
            }
            let matched = false
            if (Object.hasOwn(properties, key)) {
              matched = true
              const issue = validate(properties[key], value[key], pointer(path, key))
              if (issue) return issue
            }
            for (const [pattern, member] of Object.entries(patternProperties)) {
              const expression = new RegExp(pattern, "u")
              if (!expression.test(key)) continue
              matched = true
              const issue = validate(member, value[key], pointer(path, key))
              if (issue) return issue
            }
            if (!matched && schema.additionalProperties !== undefined) {
              const issue = validate(schema.additionalProperties, value[key], pointer(path, key))
              if (issue) return issue
            }
          }
        }
        return
      } finally {
        const values = active.get(schema)
        values?.delete(value)
        if (values?.size === 0) active.delete(schema)
      }
    }

    return validate(root, input, "$")
  }
}

/**
 * Compile one immutable, turn-local StructuredOutput tool. The model-facing
 * schema and the runtime validator are snapshots of the same normalized
 * value, so request reconstruction and settlement cannot drift.
 */
export const prepare = (schema: Readonly<Record<string, unknown>>): Prepared => {
  let cloned: unknown
  try {
    cloned = structuredClone(schema)
  } catch (error) {
    fail(`The structured-output schema is not cloneable: ${error instanceof Error ? error.message : String(error)}`)
  }
  assert(isRecord(cloned), "$", "the structured-output schema must be an object")
  const { $schema, ...withoutDialect } = cloned
  if ($schema !== undefined) assert(typeof $schema === "string", "$.$schema", "must be a string")
  let serialized = ""
  try {
    serialized = JSON.stringify(withoutDialect)
  } catch (error) {
    fail(
      `The structured-output schema is not JSON serializable: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const bytes = new TextEncoder().encode(serialized).byteLength
  assert(bytes <= maxSchemaBytes, "$", `schema is ${bytes} bytes; maximum is ${maxSchemaBytes}`)
  assert(
    withoutDialect.type === "object",
    "$.type",
    "must be object because provider tool-call inputs require a JSON object root",
  )
  const compiled = inspectSchema(withoutDialect)
  const validate = makeValidator(withoutDialect, compiled)
  const input = Schema.Unknown.check(
    Schema.makeFilter<unknown>((value) => {
      const issue = validate(value)
      return issue ? `${issue.path}: ${issue.reason}` : undefined
    }),
  )
  const normalized = immutable(withoutDialect) as JsonSchema.JsonSchema
  const tool = Tool.make({
    description,
    input,
    inputJsonSchema: normalized,
    output: Schema.Unknown,
    outputJsonSchema: normalized,
    effects: automaticRead({ successCriteria: ["the final JSON object satisfies the requested schema"] }),
    metadata: {
      concurrency: "safe",
      sideEffect: "none",
      idempotency: "idempotent",
      timeoutMode: "derived",
      outputPolicy: "model",
    },
    execute: (value) => Effect.succeed(value),
    toModelOutput: () => [{ type: "text", text: "Structured output captured successfully." }],
  })
  return Object.freeze({ schema: normalized, tool })
}
