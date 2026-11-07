import { describe, expect, test } from "bun:test"
import { chooserCopy, chooserVariantLabel } from "./dialog-select-model-copy"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { createSessionOwnership } from "@/pages/session/session-ownership"
import {
  chooserProvider,
  chooserCapabilityBadges,
  chooserVariantGroups,
  chooserStrengthOptions,
  chooserReasoningVariant,
  chooserStep,
  chooserRangeIndex,
  commitChooserVariant,
} from "./dialog-select-model-presentation"

test("uses the existing English, simplified and traditional locales without translating custom IDs", () => {
  for (const locale of ["zht", "zh-TW", "zh-Hant", "zh_HK"]) expect(chooserCopy(locale).connections).toBe("服務連線")
  for (const locale of ["zh", "zh-Hans"]) expect(chooserCopy(locale).connections).toBe("服务连接")
  for (const locale of ["en", "de", "ja"]) expect(chooserCopy(locale).connections).toBe("Connections")
  expect(chooserVariantLabel("high", "zh", false)).toBe("high")
  expect(chooserVariantLabel("high", "zh", true)).toBe("高")
  expect(chooserVariantLabel("RelayCustom_HIGH", "zht", true)).toBe("RelayCustom_HIGH")
  expect(chooserVariantLabel("none", "en", true, { thinking: { type: "disabled" } })).toBe("Off")
  expect(chooserVariantLabel("none", "zh", true, { reasoning_effort: "none" })).toBe("关闭")
  expect(chooserVariantLabel("none", "zh", false, { temperature: 0.1 })).toBe("none")
  expect(chooserVariantLabel("none", "zh", true, { reasoning_effort: "high" })).toBe("none")
})

describe("configured connection browsing", () => {
  test("keeps relay identity independent of manufacturer and never commits a model", () => {
    const rows = [
      { id: "relay-A", name: "Claude and DeepSeek relay" },
      { id: "native-B", name: "Direct" },
    ]
    const committed = { providerID: "relay-A", modelID: "alias/claude" }
    expect(chooserProvider(rows, "native-B", committed.providerID)).toBe("native-B")
    expect(committed).toEqual({ providerID: "relay-A", modelID: "alias/claude" })
    expect(rows.map((item) => item.id)).toEqual(["relay-A", "native-B"])
  })
  test("retains a browsed provider through refresh and recovers safely when it disappears", () => {
    const rows = [{ id: "same-label-A" }, { id: "same-label-B" }]
    expect(chooserProvider(rows, "same-label-B", "same-label-A")).toBe("same-label-B")
    expect(chooserProvider([rows[0]], "same-label-B", "same-label-A")).toBe("same-label-A")
    expect(chooserProvider([], "same-label-B", "same-label-A")).toBeUndefined()
  })
})

describe("capability evidence", () => {
  test("unknown is not inferred from a model name or request preset", () => {
    expect(chooserCapabilityBadges({})).toEqual([])
    expect(
      chooserCapabilityBadges({
        capabilities: { reasoning: false, input: { image: false } },
        reasoning: true,
        modalities: { input: ["image"] },
      }),
    ).toEqual([])
    expect(chooserCapabilityBadges({ capabilities: { reasoning: true, input: { image: true, audio: true } } })).toEqual(
      ["vision", "audio", "reasoning"],
    )
    expect(chooserCapabilityBadges({ modalities: { input: ["video", "pdf"] } })).toEqual(["video", "pdf"])
  })
})

describe("actual generic variant classification", () => {
  test("preserves default, off, automatic and custom wire identities as different options", () => {
    const grouped = chooserVariantGroups(["off", "auto", "low", "default", "json", "temperature-low"], {
      off: { body: { thinking: { type: "disabled" } } },
      auto: { settings: { reasoningEffort: "auto" } },
      low: { reasoning_effort: "low" },
      default: { request: { body: { reasoning: { effort: "medium" } } } },
      json: { body: { response_format: { type: "json_object" } } },
      "temperature-low": { body: { temperature: 0.1 } },
    })
    expect(grouped.reset.value).toBeUndefined()
    expect(grouped.reasoning.map((item) => item.value)).toEqual(["off", "auto", "low", "default"])
    expect(grouped.reasoning.find((item) => item.value === "default")?.key).not.toBe(grouped.reset.key)
    expect(grouped.other.map((item) => item.value)).toEqual(["json", "temperature-low"])
  })
  test("a high/max name alone is not evidence of a reasoning preset; metadata loss stays visible as other presets", () => {
    const grouped = chooserVariantGroups(["high", "max", "custom", "high"], {
      high: {},
      max: {},
      custom: { headers: { reasoningEffort: "high" } },
    })
    expect(grouped.reasoning).toEqual([])
    expect(grouped.other.map((item) => item.value)).toEqual(["high", "max", "custom"])
    expect(chooserReasoningVariant({ headers: { reasoningEffort: "high" } })).toBe(false)
  })
  test("supports known public request shapes without reading generic headers", () => {
    expect(chooserReasoningVariant({ providerOptions: { anthropic: { thinking: { budget_tokens: 2048 } } } })).toBe(
      true,
    )
    expect(chooserReasoningVariant({ body: { thinkingConfig: { thinkingBudget: 0 } } })).toBe(true)
    expect(chooserReasoningVariant({ body: { reasoning: { effort: "high" } } })).toBe(true)
    expect(chooserReasoningVariant({ body: { style: "reasoning", temperature: 1 } })).toBe(false)
  })
  test("only variants in the supported runtime list are exposed", () => {
    const grouped = chooserVariantGroups(["relay-custom"], {
      "relay-custom": { body: { reasoningEffort: "high" } },
      max: { body: { reasoningEffort: "max" } },
    })
    expect(grouped.reasoning.map((item) => item.value)).toEqual(["relay-custom"])
    expect(chooserVariantGroups([], {}).reasoning).toEqual([])
  })
})

describe("reasoning strength scale", () => {
  test("orders explicit Anthropic efforts independently of variant display IDs", () => {
    const metadata = {
      "relay-largest": { body: { thinking: { type: "adaptive" }, output_config: { effort: "max" } } },
      "relay-smallest": { body: { output_config: { effort: "low" } } },
      "relay-middle": { body: { thinking: { type: "adaptive" }, output_config: { effort: "high" } } },
      off: { body: { thinking: { type: "disabled" } } },
    }
    const groups = chooserVariantGroups(Object.keys(metadata), metadata)
    const strength = chooserStrengthOptions(groups, metadata)
    expect(groups.other).toEqual([])
    expect(strength.levels.map((item) => item.value)).toEqual(["relay-smallest", "relay-middle", "relay-largest"])
    expect(strength.modes.map((item) => item.value)).toEqual([undefined, "off"])
  })

  test("keeps explicit Qwen thinking toggles in reasoning modes without inventing strength tiers", () => {
    const metadata = { enabled: { body: { enable_thinking: true } }, none: { body: { enable_thinking: false } } }
    const groups = chooserVariantGroups(Object.keys(metadata), metadata)
    const strength = chooserStrengthOptions(groups, metadata)
    expect(groups.other).toEqual([])
    expect(groups.reasoning.map((item) => item.value)).toEqual(["enabled", "none"])
    expect(strength.levels).toEqual([])
    expect(strength.modes.map((item) => item.value)).toEqual([undefined, "enabled", "none"])
    expect(chooserVariantLabel("none", "zh", true, metadata.none)).toBe("关闭")
    expect(chooserVariantLabel("none", "en", true, metadata.none)).toBe("Off")
    expect(chooserReasoningVariant({ headers: { enable_thinking: true } })).toBe(false)
    expect(chooserReasoningVariant({ body: { enable_thinking: "true" } })).toBe(false)
  })

  test("orders real DeepSeek request tiers and keeps off/reset outside the maximum", () => {
    const metadata = {
      low: { body: { reasoning_effort: "low" } },
      high: { body: { reasoning_effort: "high" } },
      max: { body: { reasoning_effort: "max" } },
      off: { body: { thinking: { type: "disabled" } } },
    }
    const strength = chooserStrengthOptions(chooserVariantGroups(["max", "low", "high", "off"], metadata), metadata)
    expect(strength.levels.map((option) => option.value)).toEqual(["low", "high", "max"])
    expect(strength.modes.map((option) => option.value)).toEqual([undefined, "off"])
  })
  test("uses request semantics for aliases, preserves custom/default/auto and never uses a name as evidence", () => {
    const metadata = {
      "relay-large": { providerOptions: { vendor: { reasoning: { effort: "high" } } } },
      "relay-small": { settings: { reasoningEffort: "low" } },
      auto: { body: { reasoning_effort: "auto" } },
      default: { body: { reasoning_effort: "medium" } },
      custom: { body: { reasoning_effort: "vendor-custom" } },
      max: { body: { temperature: 0.7 } },
    }
    const groups = chooserVariantGroups(Object.keys(metadata), metadata)
    const strength = chooserStrengthOptions(groups, metadata)
    expect(strength.levels.map((option) => option.value)).toEqual(["relay-small", "relay-large"])
    expect(strength.modes.map((option) => option.value)).toEqual([undefined, "auto", "default", "custom"])
    expect(groups.other.map((option) => option.value)).toEqual(["max"])
  })
  test("orders positive explicit token budgets and separates zero/off and automatic budgets", () => {
    const metadata = {
      larger: { thinking: { type: "enabled", budget_tokens: 8192 } },
      smaller: { thinking: { type: "enabled", budget_tokens: 2048 } },
      off: { thinkingConfig: { thinkingBudget: 0 } },
      auto: { thinkingConfig: { thinkingBudget: -1 } },
    }
    const strength = chooserStrengthOptions(chooserVariantGroups(Object.keys(metadata), metadata), metadata)
    expect(strength.levels.map((option) => option.value)).toEqual(["smaller", "larger"])
    expect(strength.modes.map((option) => option.value)).toEqual([undefined, "off", "auto"])
  })
  test("does not imply an order between unlike scales or expose unsupported metadata", () => {
    const metadata = {
      effort: { reasoning_effort: "high" },
      budget: { thinking: { budget_tokens: 1024 } },
      max: { reasoning_effort: "max" },
    }
    const strength = chooserStrengthOptions(chooserVariantGroups(["effort", "budget"], metadata), metadata)
    expect(strength.levels).toEqual([])
    expect(strength.modes.map((option) => option.value)).toEqual([undefined, "effort", "budget"])
    expect(chooserStrengthOptions(chooserVariantGroups([], undefined), undefined)).toEqual({
      levels: [],
      modes: [{ key: "reset", value: undefined, label: "default" }],
    })
  })
})

test("discrete keyboard movement supports arrows and Home/End, never an invented numeric strength", () => {
  expect(chooserStep("ArrowRight", 2, 3)).toBe(0)
  expect(chooserStep("ArrowLeft", 0, 3)).toBe(2)
  expect(chooserStep("Home", 2, 3)).toBe(0)
  expect(chooserStep("End", 0, 3)).toBe(2)
  expect(chooserStep("End", 0, 0)).toBeUndefined()
  expect(chooserStep("Enter", 0, 3)).toBeUndefined()
})

test("native range positions map only to actual choices, keeping reset and off wire values separate", () => {
  const options = chooserVariantGroups(["none", "relay-medium"], {
    none: { thinking: { type: "disabled" } },
    "relay-medium": { reasoning_effort: "medium" },
  })
  const choices = [options.reset, ...options.reasoning]
  expect(choices[chooserRangeIndex(0, choices.length)!].value).toBeUndefined()
  expect(choices[chooserRangeIndex(1, choices.length)!].value).toBe("none")
  expect(choices[chooserRangeIndex(2, choices.length)!].value).toBe("relay-medium")
  for (const value of [-1, 0.5, 3, 100, NaN, Infinity]) expect(chooserRangeIndex(value, choices.length)).toBeUndefined()
})

describe("authoritative variant callback fence", () => {
  test("the real ownership helper retires a current-model A/B/A capture within the same session", async () => {
    const fixture = createRoot((dispose) => {
      const [state, set] = createStore({ scope: "source/draft", model: "A" })
      const owner = createSessionOwnership(() => JSON.stringify([state.scope, state.model]))
      return { set, capture: () => owner.capture(), dispose }
    })
    try {
      const capture = fixture.capture()
      let release!: () => void
      const pending = commitChooserVariant({
        value: "off",
        supported: () => ["off"],
        current: capture.current,
        write: () =>
          new Promise<void>((resolve) => {
            release = resolve
          }),
      })
      fixture.set("model", "B")
      fixture.set("model", "A")
      release()
      expect(await pending).toBe("stale")
      let writes = 0
      expect(
        await commitChooserVariant({
          value: "off",
          supported: () => ["off"],
          current: capture.current,
          write: () => {
            writes++
          },
        }),
      ).toBe("stale")
      expect(writes).toBe(0)
      expect(fixture.capture().current()).toBe(true)
    } finally {
      fixture.dispose()
    }
  })
  test("passes exact supported wire values and a distinct reset to the existing setter", async () => {
    const writes: Array<string | undefined> = []
    const run = (value: string | undefined) =>
      commitChooserVariant({
        value,
        current: () => true,
        supported: () => ["off", "auto"],
        write: (next) => {
          writes.push(next)
        },
      })
    expect(await run("off")).toBe("acknowledged")
    expect(await run("auto")).toBe("acknowledged")
    expect(await run(undefined)).toBe("acknowledged")
    expect(await run("max")).toBe("unsupported")
    expect(writes).toEqual(["off", "auto", undefined])
  })
  test("retired source/draft/model captures cannot start a write or publish late success", async () => {
    let current = false
    let calls = 0
    expect(
      await commitChooserVariant({
        value: "high",
        current: () => current,
        supported: () => ["high"],
        write: () => {
          calls++
        },
      }),
    ).toBe("stale")
    expect(calls).toBe(0)
    current = true
    let release!: () => void
    const gate = new Promise<void>((yes) => {
      release = yes
    })
    const pending = commitChooserVariant({
      value: "high",
      current: () => current,
      supported: () => ["high"],
      write: () => {
        calls++
        return gate
      },
    })
    current = false
    release()
    expect(await pending).toBe("stale")
    expect(calls).toBe(1)
  })
  test("a versioned A/B/A return cannot publish an old reasoning receipt as current", async () => {
    let scope = "A"
    let generation = 0
    const captured = generation
    let release!: () => void
    const gate = new Promise<void>((yes) => {
      release = yes
    })
    const pending = commitChooserVariant({
      value: "low",
      supported: () => ["low"],
      current: () => scope === "A" && generation === captured,
      write: () => gate,
    })
    scope = "B"
    generation++
    scope = "A"
    generation++
    release()
    expect(await pending).toBe("stale")
  })
})
