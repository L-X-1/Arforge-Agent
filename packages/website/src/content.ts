export const locales = ["zh-CN", "en"] as const
export type Locale = (typeof locales)[number]
export type PublicPage = "product" | "download" | "docs" | "changelog" | "privacy" | "terms"

export const publicPages: PublicPage[] = ["product", "download", "docs", "changelog", "privacy", "terms"]

export const siteCopy = {
  "zh-CN": {
    language: "简体中文",
    skip: "跳到主要内容",
    nav: { product: "产品", docs: "文档", download: "下载", changelog: "更新日志", login: "登录", console: "控制台" },
    beta: "免费公开测试版",
    downloadWindows: "查看 Windows 版",
    openConsole: "进入 Web 控制台",
    howItWorks: "了解工作方式",
    footerNote: "本地优先的 AI 开发智能体。模型服务费用由你选择的提供商收取。",
    legal: { privacy: "隐私政策", terms: "服务条款" },
    home: {
      title: "把开发目标，推进到可验证的交付。",
      description: "Arforge 是面向开发工作区的本地优先 AI 智能体。它理解项目、制定计划、调用工具、持续记忆，并在你的设备上完成和验证开发任务。",
      evidenceLabel: "任务生命周期",
      evidenceTitle: "每一步都留下可以检查的证据。",
      evidenceDescription: "计划、工具调用、文件变更和验证结果沿同一条任务线推进。你随时可以检查、调整或停止。",
      stages: [
        ["01", "理解", "读取项目结构、约束和已有实现。"],
        ["02", "计划", "把目标拆成可验证的步骤和风险门槛。"],
        ["03", "执行", "在授权范围内调用工具并持续汇报。"],
        ["04", "验证", "用测试、构建和新鲜证据确认结果。"],
      ],
      capabilitiesTitle: "围绕真实工作区，而不是一轮聊天。",
      capabilities: [
        ["工作区理解", "把代码、文档、规范和项目记忆放在同一个上下文里。"],
        ["工具与审批", "命令、文件和外部连接遵循明确权限，不把危险操作藏在后台。"],
        ["持续记忆", "跨任务保留经过整理的项目事实，减少重复解释。"],
        ["多智能体协作", "把边界明确的工作并行拆分，同时保留统一验收。"],
        ["Desktop + CLI", "在图形界面和终端之间选择适合当前工作的入口。"],
        ["可验证交付", "完成意味着通过验收，而不是只生成一段看起来合理的代码。"],
      ],
      localTitle: "代码在你的设备上运行。控制权也一样。",
      localDescription: "首发版本不会把任意用户代码放到共享云主机执行。Web 控制台负责账户、设备和会话连接；文件、命令与工具仍在你拥有的 Arforge 设备上执行，并继续遵循设备端审批。",
      byokTitle: "模型由你选择，密钥由你掌控。",
      byokDescription: "连接你自己的 API Key 或 OAuth 账户。Arforge 测试版免费，但模型提供商可能根据用量收费。",
      finalTitle: "从下一个开发目标开始。",
    },
    product: {
      eyebrow: "产品",
      title: "从工作区事实出发，直到结果通过验证。",
      intro: "Arforge 把理解、规划、执行和验收放进一条持续任务线，让开发工作可以被检查、接管和复现。",
      relationshipTitle: "三个入口，一套工作流",
      relationship: [
        ["Desktop", "完整的本地工作区、任务流和权限控制。"],
        ["CLI", "适合终端原生工作、脚本和自动化。"],
        ["Web 控制台", "管理账户、设备与远程会话；任务仍在你的设备执行。"],
      ],
      safetyTitle: "能力越强，边界越要清楚。",
      safety: ["敏感操作需要明确授权。", "远程连接可随时撤销。", "不会用共享 ECS 执行任意用户代码。", "BYOK 凭据不会出现在页面、日志或分析事件中。"],
    },
    download: {
      eyebrow: "下载",
      title: "Windows 公开版正在完成发布门槛。",
      intro: "安装包只有在代码签名、安装升级验收和 SHA-256 校验全部通过后才会在这里开放。",
      status: "发布验证中",
      unavailable: "尚未开放公开下载",
      requirementsTitle: "计划支持",
      requirements: ["Windows 10 22H2 或 Windows 11", "x64 架构", "建议至少 8 GB 内存", "模型连接需要网络；本地任务数据留在设备上"],
      platforms: [["Windows", "发布验证中"], ["macOS", "即将推出"], ["Linux", "即将推出"]],
      integrityTitle: "下载完整性",
      integrity: "正式版本会同时显示版本号、文件大小、发布日期、签名状态和 SHA-256。页面不会回退到未签名的内部构建。",
    },
    docs: {
      eyebrow: "文档",
      title: "把第一次运行配置清楚。",
      intro: "首发文档覆盖安装、模型连接、工作区权限和远程设备边界。产品仍在公开测试阶段，接口可能随更新调整。",
      sections: [
        ["01", "安装", "从已签名的 Windows 安装包开始，核对页面提供的 SHA-256。"],
        ["02", "连接模型", "在设置中使用自己的 API Key 或 OAuth。不要把密钥粘贴到任务提示中。"],
        ["03", "打开工作区", "选择你拥有权限的项目目录，先检查项目规范和权限范围。"],
        ["04", "开始任务", "写清目标和验收方式；Arforge 会先读取事实并形成计划。"],
        ["05", "远程连接", "Web 控制台只连接已配对设备，设备离线时不会静默执行排队操作。"],
      ],
    },
    changelog: {
      eyebrow: "更新日志",
      title: "公开版本事实，只记录已经交付的变化。",
      intro: "官网发布通道建立后，这里将与 Windows 签名清单使用同一版本事实源。",
      empty: "首个公开测试版尚未发布。内部 Alpha 和未签名构建不会出现在公开更新日志中。",
    },
    privacy: {
      eyebrow: "隐私政策",
      title: "隐私边界先于发布。",
      intro: "以下是产品实现对应的发布草案。正式开放注册前仍需由网站所有者完成法律审阅和确认。",
      sections: [
        ["我们处理什么", "账户邮箱、验证状态、会话安全信息，以及你主动配对的设备元数据。"],
        ["我们不用于网站分析的内容", "提示词、源代码、API Key、终端输出和文件内容不会作为官网分析数据收集。"],
        ["本地执行", "首发版本中的代码和命令在你的设备或自有服务器上执行。Web 服务用于账户、设备和连接控制。"],
        ["第三方服务", "邮件通过 Resend 发送；生产基础设施计划部署在阿里云新加坡区域；模型数据处理取决于你选择的模型提供商。"],
        ["你的选择", "你可以退出会话、撤销设备并请求删除账户数据。具体保留期会在正式发布前写入最终政策。"],
      ],
    },
    terms: {
      eyebrow: "服务条款",
      title: "公开测试版使用条款草案。",
      intro: "本页不是最终法律文本。开放注册和公开下载前，网站所有者必须确认适用主体、管辖法律和联系信息。",
      sections: [
        ["测试版状态", "功能可能变化或中断。Arforge 不承诺无人监督运行、绝对正确或保证交付。"],
        ["你的责任", "你应只对有权访问的代码、设备和服务使用 Arforge，并审查高风险操作。"],
        ["第三方模型", "Arforge 测试版本身免费；你选择的模型提供商可能单独收费并适用其条款。"],
        ["禁止行为", "不得尝试跨账户、跨租户或跨设备访问，不得绕过权限与安全门槛。"],
        ["发布前待确认", "服务主体、联系地址、责任限制、争议解决与终止条款。"],
      ],
    },
  },
  en: {
    language: "English",
    skip: "Skip to main content",
    nav: { product: "Product", docs: "Docs", download: "Download", changelog: "Changelog", login: "Sign in", console: "Console" },
    beta: "Free public beta",
    downloadWindows: "View Windows release",
    openConsole: "Open Web console",
    howItWorks: "See how it works",
    footerNote: "A local-first AI development agent. Model usage is billed by the provider you choose.",
    legal: { privacy: "Privacy", terms: "Terms" },
    home: {
      title: "Carry development goals through to verified delivery.",
      description: "Arforge is a local-first AI agent for development workspaces. It understands the project, builds a plan, uses tools, retains durable context, and completes and verifies work on your device.",
      evidenceLabel: "Task lifecycle",
      evidenceTitle: "Every step leaves evidence you can inspect.",
      evidenceDescription: "Plans, tool calls, file changes, and verification results move along one task line. You can review, redirect, or stop at any point.",
      stages: [["01", "Understand", "Read the project structure, constraints, and existing implementation."], ["02", "Plan", "Turn the goal into verifiable steps and release gates."], ["03", "Execute", "Use tools within explicit permissions and report progress."], ["04", "Verify", "Confirm the result with tests, builds, and fresh evidence."]],
      capabilitiesTitle: "Built around a real workspace, not a single chat turn.",
      capabilities: [["Workspace context", "Keep code, docs, project rules, and durable memory in one working context."], ["Tools and approvals", "Commands, files, and external connections follow explicit permissions."], ["Durable memory", "Carry curated project facts across tasks without repeating the same briefing."], ["Multi-agent work", "Split bounded work in parallel while preserving a single acceptance bar."], ["Desktop + CLI", "Use the interface that fits the work in front of you."], ["Verified delivery", "Done means passing the agreed checks, not merely producing plausible code."]],
      localTitle: "Your code runs on your device. Control stays there too.",
      localDescription: "The first public release does not execute arbitrary user code on shared cloud hosts. The Web console manages accounts, devices, and session connections; files, commands, and tools run on an Arforge device you control and still follow its approvals.",
      byokTitle: "Choose the model. Keep control of the credential.",
      byokDescription: "Connect your own API key or OAuth account. The Arforge beta is free, while model providers may charge for usage.",
      finalTitle: "Start with the next development goal.",
    },
    product: {
      eyebrow: "Product", title: "Start from workspace facts. Finish with verified results.", intro: "Arforge keeps understanding, planning, execution, and acceptance in one continuous task line that can be inspected, redirected, and reproduced.", relationshipTitle: "Three surfaces, one workflow", relationship: [["Desktop", "The full local workspace, task stream, and permission controls."], ["CLI", "Terminal-native work, scripting, and automation."], ["Web console", "Account, device, and remote-session control while work continues on your device."]], safetyTitle: "More capability demands clearer boundaries.", safety: ["Sensitive actions require explicit approval.", "Remote connections can be revoked at any time.", "Shared ECS hosts do not execute arbitrary user code.", "BYOK credentials never belong in pages, logs, or analytics events."],
    },
    download: {
      eyebrow: "Download", title: "The public Windows build is completing its release gates.", intro: "The installer appears here only after code signing, install and upgrade acceptance, and SHA-256 verification have all passed.", status: "Release verification", unavailable: "Public download not yet available", requirementsTitle: "Planned support", requirements: ["Windows 10 22H2 or Windows 11", "x64 architecture", "8 GB RAM or more recommended", "Model connections require a network; local task data stays on the device"], platforms: [["Windows", "Release verification"], ["macOS", "Coming soon"], ["Linux", "Coming soon"]], integrityTitle: "Download integrity", integrity: "A public release will show its version, size, date, signing status, and SHA-256. This page never falls back to an unsigned internal build.",
    },
    docs: {
      eyebrow: "Docs", title: "Make the first run unambiguous.", intro: "Initial documentation covers installation, model connections, workspace permissions, and remote-device boundaries. The product remains in public beta and interfaces may evolve.", sections: [["01", "Install", "Begin with the signed Windows installer and compare its SHA-256 with this site."], ["02", "Connect a model", "Use your own API key or OAuth in Settings. Never paste a key into a task prompt."], ["03", "Open a workspace", "Choose a project you are allowed to access, then review its rules and permission scope."], ["04", "Start a task", "State the goal and acceptance checks. Arforge reads project facts before forming a plan."], ["05", "Connect remotely", "The Web console connects only to paired devices and never silently runs queued work after an offline period."]],
    },
    changelog: { eyebrow: "Changelog", title: "Public release facts, limited to what actually shipped.", intro: "Once the public channel opens, this page and the signed Windows manifest will use the same version source of truth.", empty: "The first public beta has not shipped. Internal alpha and unsigned builds are excluded from the public changelog." },
    privacy: { eyebrow: "Privacy", title: "Privacy boundaries come before launch.", intro: "This release draft reflects the intended implementation. The site owner must complete legal review before public registration opens.", sections: [["What we process", "Account email, verification state, security-related session data, and metadata for devices you pair."], ["What website analytics excludes", "Prompts, source code, API keys, terminal output, and file contents are not collected as website analytics."], ["Local execution", "Code and commands run on your device or owned server in the first release. Web services handle accounts, devices, and connection control."], ["Third parties", "Resend delivers email; production infrastructure is planned for Alibaba Cloud Singapore; model processing depends on the provider you connect."], ["Your choices", "You can end sessions, revoke devices, and request account deletion. Final retention periods will appear in the approved policy."]]},
    terms: { eyebrow: "Terms", title: "Public beta terms — release draft.", intro: "This is not final legal text. The site owner must confirm the service entity, governing law, and contact information before registration and downloads open.", sections: [["Beta status", "Features may change or be interrupted. Arforge does not promise unattended operation, perfect accuracy, or guaranteed delivery."], ["Your responsibility", "Use Arforge only with code, devices, and services you are authorised to access, and review high-risk actions."], ["Third-party models", "The Arforge beta is free; model providers may charge separately under their own terms."], ["Prohibited use", "Do not attempt cross-account, cross-tenant, or cross-device access or bypass permissions and safety gates."], ["Required before launch", "Service entity, contact address, liability limits, dispute resolution, and termination terms."]]},
  },
} as const

export function isLocale(value: string | undefined): value is Locale {
  return value === "zh-CN" || value === "en"
}

export function alternateLocale(locale: Locale): Locale {
  return locale === "zh-CN" ? "en" : "zh-CN"
}
