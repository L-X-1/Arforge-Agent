import type { Attributes, AttributeValue } from "@opentelemetry/api"
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base"
import { Cause, Effect, Layer, Logger, References } from "effect"
import { OtlpLogger } from "effect/unstable/observability"
import { Flag } from "../flag/flag"
import { InstallationChannel, InstallationVersion } from "../installation/version"
import { redactSecrets } from "../redact"
import { runID } from "./shared"

const endpoint = Flag.OTEL_EXPORTER_OTLP_ENDPOINT

const headers = Flag.OTEL_EXPORTER_OTLP_HEADERS
  ? Flag.OTEL_EXPORTER_OTLP_HEADERS.split(",").reduce(
      (acc, entry) => {
        const [key, ...value] = entry.split("=")
        acc[key] = value.join("=")
        return acc
      },
      {} as Record<string, string>,
    )
  : undefined

const sensitiveAttribute = /(?:^|[._-])(?:prompt|prompt_text|content|message|secret|token|password|authorization|api[_-]?key|credential|request[_-]?body|response[_-]?body|input[_-]?text|output[_-]?text)(?:$|[._-])/i

const redactAttributeValue = (key: string, value: AttributeValue): AttributeValue => {
  if (sensitiveAttribute.test(key)) return "[REDACTED_TELEMETRY]"
  if (typeof value === "string") return redactSecrets(value, [])
  if (Array.isArray(value)) return value.map((item) => (typeof item === "string" ? redactSecrets(item, []) : item)) as AttributeValue
  return value
}

const redactUnknown = (value: unknown, key = ""): unknown => {
  if (sensitiveAttribute.test(key)) return "[REDACTED_TELEMETRY]"
  if (typeof value === "string") return redactSecrets(value, [])
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item))
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redactUnknown(childValue, childKey)]))
  return value
}

export const redactTelemetryAttributes = (attributes: Attributes): Attributes =>
  Object.fromEntries(
    Object.entries(attributes)
      .filter((entry): entry is [string, AttributeValue] => entry[1] !== undefined)
      .map(([key, value]) => [key, redactAttributeValue(key, value)]),
  )

const redactSpan = (span: ReadableSpan): ReadableSpan =>
  new Proxy(span, {
    get(target, property, receiver) {
      if (property === "attributes") return redactTelemetryAttributes(target.attributes)
      if (property === "events")
        return target.events.map((event) => ({
          ...event,
          ...(event.attributes === undefined ? {} : { attributes: redactTelemetryAttributes(event.attributes) }),
        }))
      return Reflect.get(target, property, receiver)
    },
  })

const redactingExporter = (exporter: SpanExporter): SpanExporter => ({
  export: (spans, resultCallback) => exporter.export(spans.map(redactSpan), resultCallback),
  shutdown: () => exporter.shutdown(),
  forceFlush: () => exporter.forceFlush?.() ?? Promise.resolve(),
})

const redactingLogger = (logger: Logger.Logger<unknown, void>) =>
  Logger.make((options) => {
    const fiber = new Proxy(options.fiber, {
      get(target, property, receiver) {
        if (property === "getRef")
          return (reference: unknown) => {
            const value = Reflect.apply(Reflect.get(target, property) as (...args: Array<unknown>) => unknown, target, [reference])
            return reference === References.CurrentLogAnnotations ? redactUnknown(value) : value
          }
        return Reflect.get(target, property, receiver)
      },
    })
    return logger.log({ ...options, fiber, message: redactUnknown(options.message), cause: Cause.empty })
  })

function resourceAttributes() {
  const value = process.env.OTEL_RESOURCE_ATTRIBUTES
  if (!value) return {}
  try {
    return Object.fromEntries(
      value.split(",").map((entry) => {
        const index = entry.indexOf("=")
        if (index < 1) throw new Error("Invalid OTEL_RESOURCE_ATTRIBUTES entry")
        return [decodeURIComponent(entry.slice(0, index)), decodeURIComponent(entry.slice(index + 1))]
      }),
    )
  } catch {
    return {}
  }
}

export function resource(): { serviceName: string; serviceVersion: string; attributes: Record<string, string> } {
  return {
    serviceName: "arforge",
    serviceVersion: InstallationVersion,
    attributes: redactTelemetryAttributes({
      ...resourceAttributes(),
      "deployment.environment.name": InstallationChannel,
      "arforge.client": Flag.ARFORGE_CLIENT,
      "arforge.run": runID,
      "service.instance.id": runID,
    }) as Record<string, string>,
  }
}

export function loggers() {
  if (!endpoint) return []
  return [Effect.map(OtlpLogger.make({ url: `${endpoint}/v1/logs`, resource: resource(), headers }), redactingLogger)]
}

export interface TracingLayerOptions {
  readonly endpoint?: string
  readonly headers?: Readonly<Record<string, string>>
}

export async function tracingLayer(options: TracingLayerOptions = {}) {
  const targetEndpoint = options.endpoint ?? endpoint
  const targetHeaders = options.headers ?? headers
  if (!targetEndpoint) return Layer.empty
  const NodeSdk = await import("@effect/opentelemetry/NodeSdk")
  const OTLP = await import("@opentelemetry/exporter-trace-otlp-http")
  const SdkBase = await import("@opentelemetry/sdk-trace-base")
  const { AsyncLocalStorageContextManager } = await import("@opentelemetry/context-async-hooks")
  const { context } = await import("@opentelemetry/api")

  // The Effect Node SDK does not register a global context manager, but the AI SDK uses it to parent spans.
  const manager = new AsyncLocalStorageContextManager()
  manager.enable()
  context.setGlobalContextManager(manager)

  return NodeSdk.layer(() => ({
    resource: resource(),
    spanProcessor: new SdkBase.BatchSpanProcessor(
      redactingExporter(
        new OTLP.OTLPTraceExporter({
          url: `${targetEndpoint}/v1/traces`,
          headers: targetHeaders,
        }),
      ),
    ),
  }))
}

export * as Otlp from "./otlp"
