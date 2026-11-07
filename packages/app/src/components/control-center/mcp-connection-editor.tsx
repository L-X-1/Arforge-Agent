import { Index, Show, createEffect, createUniqueId, on, onCleanup, onMount } from "solid-js"
import { ButtonV2 } from "@arforge-ai/ui/v2/button-v2"
import { SelectV2 } from "@arforge-ai/ui/v2/select-v2"
import { TextField } from "@arforge-ai/ui/text-field"
import { useLanguage } from "@/context/language"
import {
  createMcpConnectionState,
  type ConfigMcpMap,
  type McpConnectionDraft,
  type McpEntry,
  type McpFormError,
} from "./mcp-connection-state"
import "./control-center.css"

export type { ConfigMcpMap, McpEntry } from "./mcp-connection-state"

export type McpConnectionEditorProps = {
  /** Undefined creates a new connection. Existing names cannot be renamed. */
  name?: string
  /** Includes the captured backend/workspace owner generation, not just its URL. */
  scope: string
  ready: boolean
  load: (name?: string) => Promise<ConfigMcpMap>
  save: (name: string, value: McpEntry) => Promise<void>
  onClose: () => void
  onSaved?: () => void
}

/** Mount beside ManagementCollection so catalog polling cannot replace a live draft. */
export function McpConnectionEditor(props: McpConnectionEditorProps) {
  const language = useLanguage()
  const id = createUniqueId()
  const focusOrigin =
    typeof document !== "undefined" && document.activeElement instanceof HTMLButtonElement
      ? document.activeElement
      : undefined
  const focusScope = props.scope
  let panel!: HTMLDetailsElement
  let heading!: HTMLElement
  const t = (en: string, zh: string) => (language.locale().startsWith("zh") ? zh : en)
  const controller = createMcpConnectionState({
    source: () => ({ name: props.name, scope: props.scope, ready: props.ready }),
    callbacks: () => ({ load: props.load, save: props.save, onSaved: props.onSaved }),
  })
  const state = controller.state
  createEffect(
    on(
      () => [props.scope, props.name, props.ready] as const,
      () => {
        void controller.open()
      },
    ),
  )
  onCleanup(() => controller.dispose())
  onMount(() => {
    const management = panel.closest('[data-testid="mcp-management"]')
    if (!focusOrigin?.isConnected || !management?.contains(focusOrigin) || props.scope !== focusScope || !props.ready)
      return
    const document = panel.ownerDocument
    // Synchronous mount only: never defer focus until the configuration GET resolves.
    // Disabling the opener during insertion may have returned focus to the body.
    if (document.activeElement !== focusOrigin && !(focusOrigin.disabled && document.activeElement === document.body))
      return
    panel.scrollIntoView?.({ block: "nearest", behavior: "auto" })
    heading.focus({ preventScroll: true })
  })

  const errorText = (error?: McpFormError) => {
    switch (error) {
      case "name":
        return t(
          "Enter a server name without line breaks, NUL or reserved object keys (__proto__, constructor, prototype).",
          "请输入服务名称，不可包含换行、空字符或保留对象键名（__proto__、constructor、prototype）。",
        )
      case "duplicate-name":
        return t("This server name already exists. Choose a different name.", "该服务名称已存在，请换一个名称。")
      case "command":
        return t(
          'Enter a JSON array of strings, for example ["node", "server.js"]. The executable cannot be blank.',
          '请输入字符串 JSON 数组，例如 ["node", "server.js"]；可执行程序不能为空。',
        )
      case "paths":
        return t(
          'Use a JSON array of nonempty paths, for example ["../dependencies"].',
          '请输入非空路径的 JSON 数组，例如 ["../dependencies"]。',
        )
      case "environment":
        return t(
          "Variable names must be unique and cannot contain =, NUL or line breaks.",
          "变量名不可重复，也不能包含 =、空字符或换行。",
        )
      case "headers":
        return t(
          "Use unique HTTP header names and values without line breaks.",
          "请使用不重复的 HTTP 请求头名称，值不可包含换行。",
        )
      case "url":
        return t(
          "Enter a complete HTTP(S) URL. Put credentials in the masked fields below.",
          "请输入完整的 HTTP(S) 地址；凭据请填写在下方的遮罩字段中。",
        )
      case "positive-integer":
        return t(
          "Enter a positive whole number of milliseconds, or leave blank to inherit.",
          "请输入正整数毫秒数，或留空沿用已有配置。",
        )
      case "port":
        return t(
          "Enter a callback port from 1 to 65535, or leave blank for the default.",
          "回调端口须为 1 至 65535，留空使用默认值。",
        )
      case "redirect":
        return t(
          "Enter a complete HTTP(S) callback URL, or leave blank for the default.",
          "请输入完整的 HTTP(S) 回调地址，或留空使用默认值。",
        )
      case "incomplete":
        return t(
          "Complete the connection fields, or keep a toggle-only override with an explicit enabled state.",
          "请补全连接配置，或在仅启停覆盖项中选择明确的启停状态。",
        )
      default:
        return undefined
    }
  }

  function Form(form: { owner: number }) {
    // A new form lifetime is created only for a source/item change or explicit load retry.
    const owner = form.owner
    const close = props.onClose
    const formScope = props.scope
    const formName = props.name
    const edit = (patch: Partial<McpConnectionDraft>) => controller.edit(owner, patch)
    const inputDisabled = () =>
      !controller.live(owner) || !state.loaded || state.unsupportedName || state.entryState === "missing"
    type TextKey = Exclude<keyof McpConnectionDraft, "environment" | "headers" | "type" | "enabled" | "oauth">

    function Field(field: {
      name: TextKey
      label: string
      description?: string
      multiline?: boolean
      secret?: boolean
      numeric?: boolean
      readOnly?: boolean
      placeholder?: string
    }) {
      return (
        <TextField
          id={`${id}-${field.name}`}
          name={field.secret ? undefined : `mcp-${field.name}`}
          presentation="workspace"
          class="min-w-0 w-full"
          label={field.label}
          description={field.description}
          placeholder={field.placeholder}
          value={state.draft[field.name]}
          multiline={field.multiline}
          type={field.secret ? "password" : "text"}
          inputMode={field.numeric ? "numeric" : undefined}
          autocomplete="off"
          spellcheck={false}
          readOnly={field.readOnly}
          disabled={inputDisabled()}
          validationState={state.errors[field.name] ? "invalid" : undefined}
          error={errorText(state.errors[field.name])}
          onChange={(value) => edit({ [field.name]: value })}
        />
      )
    }

    function Choice<T extends string>(choice: {
      name: "type" | "oauth" | "enabled"
      label: string
      options: T[]
      current: T
      labelFor: (value: T) => string
      change: (value: T) => void
    }) {
      let field!: HTMLDivElement
      createEffect(
        on(
          () => choice.current,
          () =>
            queueMicrotask(() => {
              if (!controller.live(owner) || !field?.isConnected) return
              // SelectV2's trigger includes the value ID; also name it with this field's visible label.
              const trigger = field.querySelector('[data-component="select-v2"]')
              const label = `${id}-${choice.name}-label`
              const labels = new Set([label, ...(trigger?.getAttribute("aria-labelledby")?.split(" ") ?? [])])
              trigger?.setAttribute("aria-labelledby", [...labels].filter(Boolean).join(" "))
            }),
        ),
      )
      return (
        <div ref={field} class="grid min-w-0 gap-1.5">
          <span id={`${id}-${choice.name}-label`} class="text-12-medium text-text-strong">
            {choice.label}
          </span>
          <SelectV2
            id={`${id}-${choice.name}`}
            aria-labelledby={`${id}-${choice.name}-label`}
            options={choice.options}
            current={choice.current}
            label={choice.labelFor}
            disabled={inputDisabled()}
            invalid={!!state.errors[choice.name]}
            onSelect={(value) => {
              // Saving a new connection changes the available transport options.
              // Select may re-emit the current value while reconciling them.
              // That is not a new edit and must not clear the save acknowledgement.
              if (value && value !== choice.current && controller.live(owner)) choice.change(value)
            }}
          />
          <Show when={state.errors[choice.name]}>
            <p class="text-11-regular text-text-danger" role="alert">
              {errorText(state.errors[choice.name])}
            </p>
          </Show>
        </div>
      )
    }

    function Rows(rowProps: { name: "environment" | "headers"; label: string }) {
      const values = () => state.draft[rowProps.name]
      const setRow = (index: number, key: "key" | "value", value: string) => {
        edit({
          [rowProps.name]: values().map((row, position) =>
            position === index ? { ...row, [key]: value } : { ...row },
          ),
        })
      }
      return (
        <fieldset class="grid min-w-0 gap-3">
          <legend class="mb-2 text-12-medium text-text-strong">{rowProps.label}</legend>
          <p class="text-11-regular text-text-weak">
            {t(
              "Values are masked. Unchanged values are kept; an empty named value remains empty.",
              "值默认遮罩显示；未修改的值会保留，有名称的空值仍保存为空字符串。",
            )}
          </p>
          <Index each={values()}>
            {(row, index) => (
              <div
                class="grid min-w-0 items-end gap-2"
                style={{ "grid-template-columns": "repeat(auto-fit, minmax(min(100%, 160px), 1fr))" }}
              >
                <TextField
                  id={`${id}-${rowProps.name}-${index}-key`}
                  presentation="workspace"
                  class="min-w-0 w-full"
                  label={`${t("Name", "名称")} ${index + 1}`}
                  value={row().key}
                  autocomplete="off"
                  spellcheck={false}
                  disabled={inputDisabled()}
                  onChange={(value) => setRow(index, "key", value)}
                />
                <TextField
                  id={`${id}-${rowProps.name}-${index}-value`}
                  presentation="workspace"
                  class="min-w-0 w-full"
                  label={`${t("Value", "值")} ${index + 1}`}
                  value={row().value}
                  type="password"
                  autocomplete="off"
                  spellcheck={false}
                  disabled={inputDisabled()}
                  onChange={(value) => setRow(index, "value", value)}
                />
                <ButtonV2
                  type="button"
                  variant="ghost"
                  disabled={inputDisabled()}
                  aria-label={`${t("Remove row", "移除此行")} ${index + 1}`}
                  onClick={() =>
                    edit({
                      [rowProps.name]: values()
                        .filter((_, position) => position !== index)
                        .map((row) => ({ ...row })),
                    })
                  }
                >
                  {t("Remove row", "移除此行")}
                </ButtonV2>
              </div>
            )}
          </Index>
          <Show when={state.errors[rowProps.name]}>
            <p class="text-11-regular text-text-danger" role="alert">
              {errorText(state.errors[rowProps.name])}
            </p>
          </Show>
          <ButtonV2
            type="button"
            variant="outline"
            class="justify-self-start"
            disabled={inputDisabled()}
            onClick={() => edit({ [rowProps.name]: [...values().map((row) => ({ ...row })), { key: "", value: "" }] })}
          >
            {t("Add row", "添加一行")}
          </ButtonV2>
        </fieldset>
      )
    }

    return (
      <form
        class="grid min-w-0 gap-5"
        data-mcp-connection-form
        autocomplete="off"
        noValidate
        aria-busy={state.loading || state.busy}
        onSubmit={(event) => {
          event.preventDefault()
          void controller.submit(owner)
        }}
      >
        <Show when={!props.ready || state.loading}>
          <p role="status" class="text-12-regular text-text-weak">
            {t("Loading workspace configuration…", "正在读取工作区配置…")}
          </p>
        </Show>
        <Show when={state.error}>
          <div role="alert" class="grid gap-2 text-12-regular text-text-danger">
            <p>
              {state.error === "load"
                ? t(
                    "Configuration could not be loaded. Check this workspace connection and retry.",
                    "配置读取失败，请检查当前工作区连接后重试。",
                  )
                : t(
                    "Save failed. Your input is retained. Check the connection and configuration permissions, then retry.",
                    "保存失败，输入已保留。请检查连接及配置权限后重试。",
                  )}
            </p>
          </div>
        </Show>
        <Show when={state.entryState === "missing"}>
          <p role="alert" class="text-12-regular text-text-weak">
            {t(
              "This server has no configuration in the current workspace. Refresh, or close and choose Add server to create a new connection.",
              "当前工作区中没有此服务的配置。请重新读取，或关闭后选择“添加服务”创建连接。",
            )}
          </p>
        </Show>
        <Show when={state.unsupportedName}>
          <p role="status" class="text-12-regular text-text-weak">
            {t(
              "This existing name is unsupported in the editor. Its configuration is read-only; maintain it at its original configuration source.",
              "此已有名称不受编辑器支持。配置保持只读，请在原配置来源中维护此条目。",
            )}
          </p>
        </Show>
        <Show when={!state.unsupportedName && (state.entryState === "override" || state.entryState === "incomplete")}>
          <p role="status" class="text-12-regular text-text-weak">
            {state.entryState === "override"
              ? t(
                  "This entry only overrides startup enablement; it is not a complete connection definition. Keep the override or select a transport and complete its fields.",
                  "此条目仅覆盖启动启停状态，并非完整连接定义。可保留启停覆盖，或选择连接类型并补全配置。",
                )
              : t(
                  "The existing connection definition is incomplete. Complete the required fields before saving.",
                  "现有连接配置不完整，请补全必填字段后保存。",
                )}
          </p>
        </Show>
        <Show when={state.loaded && state.entryState !== "missing"}>
          <fieldset class="grid min-w-0 gap-3" disabled={inputDisabled()}>
            <legend class="mb-3 text-14-medium text-text-strong">{t("Connection", "连接配置")}</legend>
            <Field
              name="name"
              label={t("Server name", "服务名称")}
              readOnly={state.lockedName !== undefined || state.busy}
              description={
                state.lockedName !== undefined
                  ? t("Existing server names stay unchanged.", "已配置的服务名称不可修改。")
                  : undefined
              }
            />
            <Choice<McpConnectionDraft["type"]>
              name="type"
              label={t("Connection type", "连接类型")}
              options={
                state.entryState === "override" || state.draft.type === "override"
                  ? ["override", "local", "remote"]
                  : ["local", "remote"]
              }
              current={state.draft.type}
              labelFor={(value) =>
                value === "local"
                  ? t("Local process", "本地进程")
                  : value === "remote"
                    ? t("Remote HTTP", "远程 HTTP")
                    : t("Startup override only", "仅启动启停覆盖")
              }
              change={(type) => edit({ type })}
            />
            <Show when={state.draft.type === "local"}>
              <Field
                name="command"
                label={t("Command and arguments (JSON array)", "命令与参数（JSON 数组）")}
                multiline
                placeholder={'["node", "server.js"]'}
                description={t(
                  "The first item is the executable. Arguments keep their exact spacing and order.",
                  "首项为可执行程序；各参数的空格及顺序会完整保留。",
                )}
              />
              <Field
                name="cwd"
                label={t("Working directory", "工作目录")}
                description={t(
                  "Optional. Relative paths resolve from the workspace.",
                  "可选；相对路径以当前工作区为基准。",
                )}
              />
              <Field
                name="readOnlyPaths"
                label={t("Additional read-only paths (JSON array)", "附加只读路径（JSON 数组）")}
                multiline
                placeholder={'["../dependencies"]'}
                description={t(
                  "Optional. Path changes require local approval and do not grant write access.",
                  "可选；路径变更需要本地批准，不会授予写入权限。",
                )}
              />
              <Rows name="environment" label={t("Environment variables", "环境变量")} />
            </Show>
            <Show when={state.draft.type === "remote"}>
              <Field name="url" label={t("Server URL", "服务地址")} placeholder="https://example.com/mcp" />
              <Rows name="headers" label={t("Request headers", "请求头")} />
            </Show>
          </fieldset>
          <Show when={state.draft.type === "remote"}>
            <fieldset class="grid min-w-0 gap-3" disabled={inputDisabled()}>
              <legend class="mb-3 text-14-medium text-text-strong">{t("OAuth authorization", "OAuth 授权配置")}</legend>
              <Choice<McpConnectionDraft["oauth"]>
                name="oauth"
                label={t("OAuth mode", "OAuth 模式")}
                options={["auto", "disabled", "configured"]}
                current={state.draft.oauth}
                labelFor={(value) =>
                  value === "auto"
                    ? t("Automatic discovery", "自动发现")
                    : value === "disabled"
                      ? t("Disabled", "关闭")
                      : t("Configured client", "配置客户端")
                }
                change={(oauth) => edit({ oauth })}
              />
              <p class="text-11-regular text-text-weak">
                {t(
                  "Configure authorization here; use the existing Authorize action to complete sign-in.",
                  "此处设置授权参数；使用已有授权操作完成登录。",
                )}
              </p>
              <Show when={state.draft.oauth === "configured"}>
                <Field
                  name="clientId"
                  label={t("Client ID", "客户端 ID")}
                  description={t(
                    "Optional. Leave blank for dynamic client registration.",
                    "可选；留空尝试动态客户端注册。",
                  )}
                />
                <Field name="clientSecret" label={t("Client secret", "客户端密钥")} secret />
                <Field name="oauthScope" label={t("Requested scopes", "请求的授权范围")} />
                <Field
                  name="callbackPort"
                  label={t("Callback port", "回调端口")}
                  numeric
                  placeholder="19876"
                  description={t(
                    "Optional. An explicit redirect URI takes precedence over this port.",
                    "可选；填写回调地址时，以回调地址为准。",
                  )}
                />
                <Field
                  name="redirectUri"
                  label={t("Redirect URI", "回调地址")}
                  placeholder="http://127.0.0.1:19876/mcp/oauth/callback"
                />
              </Show>
            </fieldset>
          </Show>
          <fieldset class="grid min-w-0 gap-3" disabled={inputDisabled()}>
            <legend class="mb-3 text-14-medium text-text-strong">{t("Startup and timeouts", "启动与超时")}</legend>
            <Choice<McpConnectionDraft["enabled"]>
              name="enabled"
              label={t("Enable on startup", "启动时启用")}
              options={["inherit", "enabled", "disabled"]}
              current={state.draft.enabled}
              labelFor={(value) =>
                value === "inherit"
                  ? t("Inherit existing configuration", "沿用已有配置")
                  : value === "enabled"
                    ? t("Enabled", "启用")
                    : t("Disabled", "禁用")
              }
              change={(enabled) => edit({ enabled })}
            />
            <Show when={state.draft.type !== "override"}>
              <div
                class="grid min-w-0 gap-3"
                style={{ "grid-template-columns": "repeat(auto-fit, minmax(min(100%, 220px), 1fr))" }}
              >
                <Field
                  name="startup"
                  label={t("Startup timeout (ms)", "启动超时（毫秒）")}
                  numeric
                  description={t(
                    "Blank keeps the inherited setting; fallback is 30000 ms.",
                    "留空沿用已有配置；未配置时默认 30000 毫秒。",
                  )}
                />
                <Field
                  name="request"
                  label={t("Request timeout (ms)", "请求超时（毫秒）")}
                  numeric
                  description={t(
                    "Blank keeps the inherited setting; fallback is 30000 ms.",
                    "留空沿用已有配置；未配置时默认 30000 毫秒。",
                  )}
                />
              </div>
            </Show>
          </fieldset>
        </Show>
        <Show when={state.notice}>
          <p role="status" class="text-12-regular text-text-weak">
            {state.notice === "saved-with-edits"
              ? t(
                  "The submitted version was saved. Your newer edits are still here and have not been saved.",
                  "已保存刚才提交的版本；之后的新修改仍保留在表单中，尚未保存。",
                )
              : t("Configuration saved.", "配置已保存。")}
          </p>
        </Show>
        <div class="flex min-w-0 flex-wrap gap-2">
          <ButtonV2
            type="submit"
            variant={state.busy ? "loading" : "contrast"}
            disabled={inputDisabled() || state.busy}
          >
            {state.busy ? t("Saving…", "正在保存…") : t("Save configuration", "保存配置")}
          </ButtonV2>
          <Show when={state.error === "load" || state.entryState === "missing"}>
            <ButtonV2
              type="button"
              variant="outline"
              disabled={!props.ready || state.loading}
              onClick={() => {
                if (controller.live(owner)) void controller.open()
              }}
            >
              {t("Retry loading", "重新读取")}
            </ButtonV2>
          </Show>
          <ButtonV2
            type="button"
            variant="ghost"
            onClick={() => {
              if (
                controller.live(owner) ||
                (!props.ready && state.owner === owner && props.scope === formScope && props.name === formName)
              )
                close()
            }}
          >
            {t("Close", "关闭")}
          </ButtonV2>
        </div>
      </form>
    )
  }

  return (
    <details ref={panel} class="arforge-management-detail" open data-mcp-connection-editor>
      <summary ref={heading} tabIndex={0} class="arforge-management-detail-heading">
        <span>
          {state.lockedName === undefined
            ? t("Add MCP server", "添加 MCP 服务")
            : t("Edit MCP connection", "编辑 MCP 连接")}
        </span>
        <span class="arforge-management-detail-toggle">{t("Expand / collapse", "展开 / 收起")}</span>
      </summary>
      <div class="arforge-management-detail-body">
        <Show when={state.owner} keyed>
          {(owner) => <Form owner={owner} />}
        </Show>
      </div>
    </details>
  )
}
