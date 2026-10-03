export type OnboardingLocale = "zh" | "zht" | "en"

export function onboardingLocale(locale: string): OnboardingLocale {
  if (locale === "zh") return "zh"
  if (locale === "zht") return "zht"
  return "en"
}

const copy = {
  zh: {
    eyebrow: "首次使用 · 约 1 分钟",
    title: "用三步开始第一个 Arforge 任务",
    description: "你只需说明目标和限制；Arforge 会先理解项目、制定计划，再在需要时向你申请权限。",
    steps: [
      ["选择项目", "在左侧选择已有项目，或添加一个本地文件夹。"],
      ["描述结果", "说清最终要得到什么，以及哪些内容不能改。"],
      ["查看执行", "顶部会显示正在工作、等待授权或已完成；点击可看详细步骤。"],
    ],
    automatic: "自动",
    manual: "人工",
    automaticText: "分析项目、拆解步骤、运行验证和保存执行记录",
    manualText: "提供目标；遇到敏感操作时决定允许或拒绝",
    start: "开始第一个任务",
    projectNeeded: "先在左侧添加或选择项目",
    skip: "暂时跳过",
    promptTitle: "不知道怎么说？选择一个写法",
    promptDescription: "示例只会填入输入框，不会自动发送。你可以继续修改。",
    examples: [
      ["新手", "先阅读这个项目，用简单语言告诉我它能做什么。然后制定一个分步计划，等我确认后再修改。"],
      ["日常开发", "完成我描述的功能，先检查现有实现，再逐步修改并运行相关测试。遇到有风险或不明确的地方先问我。"],
      ["专业审查", "从架构、数据安全、错误恢复和用户体验角度审查当前项目。先给出证据和优先级，再执行可逆修复。"],
    ],
    useExample: "填入此示例",
    closePrompt: "我自己输入",
    settingsTitle: "首次使用引导",
    settingsDescription: "重新显示三步入门说明和任务写法示例；不会修改项目文件。",
    reopen: "重新打开引导",
    advancedAudience: "谁需要这些工具？",
    advancedHelp:
      "普通使用通常无需打开。项目负责人可使用记忆、自动化和团队功能；工程师可使用工作流、诊断与运行时透视。涉及修改数据的操作仍会明确要求人工确认。",
  },
  zht: {
    eyebrow: "首次使用 · 約 1 分鐘",
    title: "用三步開始第一個 Arforge 任務",
    description: "你只需說明目標與限制；Arforge 會先理解專案、制定計畫，再在需要時向你申請權限。",
    steps: [
      ["選擇專案", "在左側選擇現有專案，或新增一個本機資料夾。"],
      ["描述結果", "說清最終要得到什麼，以及哪些內容不能修改。"],
      ["查看執行", "頂部會顯示正在工作、等待授權或已完成；點擊可看詳細步驟。"],
    ],
    automatic: "自動",
    manual: "人工",
    automaticText: "分析專案、拆解步驟、執行驗證並保存執行記錄",
    manualText: "提供目標；遇到敏感操作時決定允許或拒絕",
    start: "開始第一個任務",
    projectNeeded: "先在左側新增或選擇專案",
    skip: "暫時跳過",
    promptTitle: "不知道怎麼說？選擇一種寫法",
    promptDescription: "範例只會填入輸入框，不會自動傳送。你可以繼續修改。",
    examples: [
      ["新手", "先閱讀這個專案，用簡單語言告訴我它能做什麼。然後制定分步計畫，等我確認後再修改。"],
      ["日常開發", "完成我描述的功能，先檢查現有實作，再逐步修改並執行相關測試。有風險或不清楚的地方先問我。"],
      ["專業審查", "從架構、資料安全、錯誤恢復和使用者體驗角度審查目前專案。先提供證據和優先順序，再執行可逆修復。"],
    ],
    useExample: "填入此範例",
    closePrompt: "我自己輸入",
    settingsTitle: "首次使用引導",
    settingsDescription: "重新顯示三步入門說明和任務寫法範例；不會修改專案檔案。",
    reopen: "重新開啟引導",
    advancedAudience: "誰需要這些工具？",
    advancedHelp:
      "一般使用通常無需開啟。專案負責人可使用記憶、自動化和團隊功能；工程師可使用工作流、診斷與執行期透視。涉及修改資料的操作仍會明確要求人工確認。",
  },
  en: {
    eyebrow: "First use · about 1 minute",
    title: "Start your first Arforge task in three steps",
    description:
      "Describe the outcome and constraints. Arforge will inspect the project, make a plan, and ask when permission is needed.",
    steps: [
      ["Choose a project", "Select an existing project on the left, or add a local folder."],
      ["Describe the outcome", "Say what done looks like and what must not change."],
      ["Follow execution", "The top bar shows working, permission, and completion states; select it for details."],
    ],
    automatic: "Automatic",
    manual: "Manual",
    automaticText: "Project inspection, step planning, verification, and execution records",
    manualText: "Provide the goal and approve or reject sensitive actions",
    start: "Start your first task",
    projectNeeded: "Add or select a project on the left first",
    skip: "Skip for now",
    promptTitle: "Not sure what to write? Choose a starting point",
    promptDescription: "An example only fills the composer. It is never sent automatically, and you can edit it first.",
    examples: [
      [
        "Beginner",
        "Read this project first and explain what it does in plain language. Then make a step-by-step plan and wait for my confirmation before editing.",
      ],
      [
        "Everyday development",
        "Implement the feature I describe. Inspect the current implementation first, make incremental changes, and run relevant tests. Ask before risky or ambiguous actions.",
      ],
      [
        "Professional review",
        "Review this project for architecture, data safety, error recovery, and user experience. Show evidence and priorities first, then apply reversible fixes.",
      ],
    ],
    useExample: "Use this example",
    closePrompt: "I'll write my own",
    settingsTitle: "First-use guide",
    settingsDescription:
      "Show the three-step introduction and task examples again. This does not modify project files.",
    reopen: "Open guide again",
    advancedAudience: "Who needs these tools?",
    advancedHelp:
      "Most users can leave these closed. Project leads may use memory, automation, and team features; engineers may use workflows, diagnostics, and runtime insights. Data-changing actions still require explicit human confirmation.",
  },
} as const

export function onboardingCopy(locale: string) {
  return copy[onboardingLocale(locale)]
}
