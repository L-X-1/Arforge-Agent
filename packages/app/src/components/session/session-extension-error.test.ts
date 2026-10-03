import { describe, expect, test } from "bun:test"
import { sessionExtensionPublicError } from "./session-extension-error"

describe("Session extension public errors", () => {
  test("localizes a nested plugin security rejection without exposing structured transport data", () => {
    const error = new Error(
      JSON.stringify({
        kind: "agent-management-invalid-plugin-manifest",
        data: { message: "undeclared egress access; undeclared secret access in plugin manifest" },
      }),
    )
    expect(sessionExtensionPublicError(error, "Fallback", "zh")).toBe(
      "插件内容未通过安全检查：检测到未声明的联网或密钥访问。操作已停止，受管插件未被修改。",
    )
  })

  test("keeps an actionable backend message in English", () => {
    expect(sessionExtensionPublicError(new Error("plugin recovery entry was not found"), "Fallback", "en")).toBe(
      "plugin recovery entry was not found",
    )
  })

  test("localizes the runtime scanner wording used by a tampered recovery", () => {
    const message =
      "plugin code appears to access a secret without a declared secret name, plugin code appears to perform network egress without a declared egress scope"
    expect(sessionExtensionPublicError(new Error(message), "Fallback", "zh")).toContain("操作已停止")
  })

  test("projects raw model failures into an actionable workflow message", () => {
    expect(
      sessionExtensionPublicError(
        new Error("ProviderModelNotFoundError: Model not found: unselected/unselected"),
        "Fallback",
        "zh",
      ),
    ).toBe("尚未配置可用模型。请在设置中选择提供商和模型后重试。")
  })

  test("uses the fallback for an opaque error", () => {
    expect(sessionExtensionPublicError({ internal: "not-public" }, "Refresh and try again", "zh")).toBe(
      "Refresh and try again",
    )
  })
})
