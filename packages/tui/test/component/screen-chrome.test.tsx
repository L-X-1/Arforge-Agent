import { afterEach, describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import {
  HomeChrome,
  SessionChrome,
  agentLabel,
  homeComposerGap,
  homeContentWidth,
  promptModeLabel,
  type ChromeTheme,
} from "../../src/component/screen-chrome"

let setup: Awaited<ReturnType<typeof testRender>> | undefined

afterEach(() => {
  setup?.renderer.destroy()
  setup = undefined
})

const theme: ChromeTheme = {
  background: RGBA.fromHex("#080808"),
  primary: RGBA.fromHex("#fab283"),
  success: RGBA.fromHex("#7fd88f"),
  warning: RGBA.fromHex("#f5a742"),
  error: RGBA.fromHex("#e06c75"),
  text: RGBA.fromHex("#eeeeee"),
  textMuted: RGBA.fromHex("#808080"),
  borderSubtle: RGBA.fromHex("#3c3c3c"),
}

async function frame(component: () => ReturnType<typeof HomeChrome>, width: number, height: number) {
  setup = await testRender(component, { width, height })
  await setup.renderOnce()
  await setup.renderOnce()
  return setup
    .captureCharFrame()
    .split("\n")
    .map((line) => line.trimEnd())
}

describe("screen chrome", () => {
  test("keeps the home prompt context legible at narrow widths", async () => {
    const output = await frame(
      () => (
        <box width={72} flexDirection="column">
          <HomeChrome theme={theme} agent="构建" model="claude-sonnet" directory="~/Arforge-Agent" compact={true} />
        </box>
      ),
      72,
      8,
    )

    expect(output.join("\n")).toContain("ARFORGE")
    expect(output.join("\n")).not.toContain("▐ ◆ ▌")
    expect(output.join("\n")).toContain("● 就绪")
    expect(output.join("\n")).toContain("面向开发工作区的本地优先 AI 智能体")
    expect(output.join("\n")).not.toContain("claude-sonnet")
    expect(output.join("\n")).toContain("工作区 ~/Arforge-Agent · /move 切换")
    expect(homeContentWidth(72)).toBe(68)
    expect(homeContentWidth(160, "auto")).toBe(156)
    expect(homeComposerGap(24, true)).toBe(4)
    expect(homeComposerGap(40, false)).toBe(17)
    expect(agentLabel("build")).toBe("构建")
    expect(promptModeLabel("normal", true)).toBe("自动模式开启")
    expect(promptModeLabel("shell", true)).toBe("命令行模式")
  })

  test("shows transcript identity and activity", async () => {
    const output = await frame(
      () => (
        <box width={96} flexDirection="column">
          <SessionChrome theme={theme} directory="~/Arforge-Agent" agent="构建" model="claude-sonnet" activity="busy" />
        </box>
      ),
      96,
      12,
    )
    const text = output.join("\n")

    expect(text).toContain("█▀▀█ █▀▀█ █▀▀▀")
    expect(text).not.toContain("▐ ◆ ▌")
    expect(text).toContain("● 运行中")
    expect(text).toContain("面向开发工作区的本地优先 AI 智能体 · claude-sonnet · 构建")
    expect(text).toContain("工作区 ~/Arforge-Agent · /move 切换")
  })
})
