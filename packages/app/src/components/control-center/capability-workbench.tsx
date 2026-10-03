import { Button } from "@arforge-ai/ui/button"
import { TextField } from "@arforge-ai/ui/text-field"
import { For, Show, createEffect, on } from "solid-js"
import { createStore } from "solid-js/store"
import { publicErrorMessage } from "@/utils/public-error"
import type { OperationsApi } from "@/utils/server"
import { createScopeRequestGuard, type ScopeRequestToken } from "@/utils/scope-request"
import { conflictDisposition } from "./memory-conflict-model"
import { useLanguage, type Locale } from "@/context/language"
import {
  diagnosisModeHint,
  diagnosisModeLabel,
  diagnosisSeverityLabel,
  diagnosisStatusLabel,
  type DiagnosisMode,
  type DiagnosisSeverity,
} from "./diagnostics-presentation"

type LocationInput = {
  location: {
    directory: string
    workspace?: string
  }
}

const copy = {
  en: {
    diagnostics: "Diagnostics workbench",
    diagnosticsHelp: "Explicit read-only checks. No model call, file mutation, or release approval is performed.",
    multimodal: "Multimodal",
    mode: "Check mode",
    modeError: "Error / document",
    modeFrontend: "Frontend HTML / Vue",
    modeJavaScript: "JavaScript",
    modeHelp: "Choose the check that matches the file. Every mode is local and read-only.",
    file: "Image or document path",
    extracted: "Extracted error text (optional)",
    run: "Run diagnosis",
    cancelDiagnosis: "Cancel check",
    diagnosisCancelled: "Check cancelled. No file was changed.",
    diagnosisResult: "Diagnosis result",
    diagnosisPath: "Path",
    diagnosisSource: "Source",
    diagnosisChecks: "Checks",
    diagnosisSignals: "signals",
    diagnosisIssues: "Findings",
    diagnosisSuggestions: "Next steps",
    diagnosisNoIssues: "No findings were reported by this deterministic check.",
    diagnosisRaw: "Raw evidence (advanced)",
    diagnosisLocalOnly: "Local only",
    yes: "yes",
    no: "no",
    diagnosisModelCalls: "Model calls",
    diagnosisNotChecked: "External references are listed but not fetched.",
    assetPreviewTitle: "External asset localization preview",
    assetPreviewHint:
      "Read-only discovery shows the exact request fingerprint; no network request, file write, or approval is performed.",
    assetPreviewReady: "Ready for a later explicit approval",
    assetPreviewNone: "No external assets need localization",
    assetPreviewBlocked: "Preview unavailable",
    assetPreviewDigest: "Discovery fingerprint",
    assetPreviewScope: "External requests",
    assetPreviewReferences: "References",
    assetPreviewNoExecution:
      "This is only a preview. Fetching and writing remain closed until the same ActionGateway approval path is available.",
    repo: "Repo Scale",
    repoPath: "Repository path (relative to the current workspace)",
    repoPathHelp: "Use a project subdirectory instead of scanning a broad user-home folder.",
    repoQuery: "Optional search query",
    scan: "Scan repository",
    quality: "Quality",
    files: "Changed files (one per line)",
    patch: "Patch text (optional)",
    assess: "Assess quality",
    running: "Running…",
    memoryLearning: "Memory and Learning governance",
    createMemory: "Create Memory",
    content: "Memory content",
    tags: "Tags (comma-separated)",
    importance: "Importance (0–5)",
    create: "Create",
    status: "Status",
    total: "Total",
    important: "Important",
    quarantined: "Quarantined",
    recallInspector: "Memory recall inspector",
    recallInspectorHelp:
      "Run the same local hybrid ranker used during Session preparation and inspect every selected candidate. This preview does not claim that a model turn consumed the result.",
    recallQuery: "Question or task to test",
    inspectRecall: "Inspect recall",
    recallNotRun: "Enter a realistic question to inspect the hidden retrieval path.",
    recallNoHits: "No active memory matched this query.",
    recallPipeline: "Retrieval process",
    recallNormalize: "1. Normalize query",
    recallScope: "2. Filter local scope",
    recallRank: "3. Hybrid rank",
    recallSelect: "4. Select context candidates",
    recallAlgorithm: "Ranker",
    recallLocal: "Local only",
    recallCandidates: "Selected candidates",
    recallScore: "Combined score",
    recallLexical: "Lexical",
    recallVector: "Vector",
    recallTerms: "Matched terms",
    recallSource: "Source / scope",
    recallEvidenceCaveat:
      "Inspection evidence: this proves what the ranker returns now. Source-bound Session evidence is required to prove what a particular model turn actually received.",
    actualRecallEvidence: "Actual Session recall evidence",
    actualRecallEvidenceHelp:
      "Immutable events written after context-size checks and immediately before the provider call. They contain IDs, scores, and digests—not message or memory content.",
    contextFusionEvidence: "Actual context assembly evidence",
    contextFusionEvidenceHelp:
      "One immutable provider-bound event proves which TypeScript memory, learning, and governed-evolution contributions were assembled for the same model turn. Unavailable components are shown as degraded instead of being reported as success.",
    fusionNoEvidence: "This Session has no recorded context assembly yet.",
    fusionHealthy: "All runtime contributions prepared",
    fusionDegraded: "Provider call continued with a degraded contribution",
    fusionMemory: "Memory",
    fusionLearning: "Learning",
    fusionEvolution: "Governed Evolution",
    fusionRuntime: "Runtime",
    fusionCandidates: "Candidates",
    fusionActiveCandidates: "Active candidates",
    fusionInjectedCandidates: "Injected candidates",
    fusionBridge: "Assembly protocol",
    combinedDigest: "Combined context digest",
    recallNoSession: "Open Settings from a Session to inspect its actual recall evidence.",
    recallNoEvidence: "This Session has no recorded memory-context preparation yet.",
    recallPrepared: "Prepared for provider call",
    recallUnavailable: "Recall engine unavailable",
    sourceSession: "Session",
    sourceUserMessage: "User message",
    sourceTurnStep: "Turn step",
    injectedBytes: "Injected bytes",
    queryDigest: "Query digest",
    contextDigest: "Context digest",
    preview: "Preview governance",
    apply: "Confirm and quarantine candidates…",
    restore: "Restore source",
    recentMemories: "Recent memories",
    correctMemory: "Correct",
    correctionReason: "Why is this correction needed?",
    saveCorrection: "Save correction",
    cancel: "Cancel",
    history: "Correction history",
    corrected: "Memory corrected with an auditable successor.",
    correctionUndone: "Memory correction undone.",
    warningUndoCorrection: "Undo this correction and restore the superseded memory?",
    sourceUser: "User-authored",
    sourceCorrected: "User-corrected",
    sourceImported: "Imported",
    sourceAuto: "Automatically learned",
    sourceModel: "Model-proposed",
    sourceQuarantined: "Quarantined",
    correctionActive: "Reversible",
    correctionUndoneStatus: "Undone",
    conflictGovernance: "Memory conflict review",
    conflictHelp: "Deterministic checks only. Similarity and model judgment never quarantine a memory automatically.",
    pendingConflicts: "Pending conflicts",
    scanConflicts: "Scan conflicts",
    conflictHistory: "Decision history",
    conflictOpenOnly: "Pending only",
    conflictScanSummary: "Scanned {scanned}; detected {detected}; added {added} new candidate(s).",
    conflictKey: "Claim key",
    explicitBasis: "Explicit fact-key tag",
    patternBasis: "Deterministic property pattern",
    reviewConflict: "Review",
    decisionReason: "Evidence or reason for this decision",
    keepLeft: "Keep left memory",
    keepRight: "Keep right memory",
    dismissConflict: "Not a conflict",
    conflictResolved: "Conflict resolved; the other memory was quarantined.",
    conflictDismissed: "Conflict dismissed without changing either memory.",
    conflictResolutionUndone: "Conflict resolution undone; both memories are active again.",
    warningResolveConflict: "Keep the selected memory and quarantine the other one? This remains reversible.",
    warningDismissConflict: "Record that these exact memory values are not a conflict?",
    warningUndoConflict: "Undo this conflict resolution and reactivate the quarantined memory?",
    chosenMemory: "Kept",
    retiredMemory: "Quarantined",
    conflictPending: "Pending review",
    conflictResolvedStatus: "Resolved",
    conflictDismissedStatus: "Not a conflict",
    conflictUndoneStatus: "Resolution undone",
    noConflicts: "No pending deterministic conflicts.",
    learningCaveat: "At least three injected and three baseline turns are required; uplift is held at zero until then.",
    learning: "Learning",
    turns: "Turns",
    successRate: "Success rate",
    patterns: "Patterns",
    undo: "Undo…",
    feedback: "Feedback governance",
    average: "Average rating",
    delete: "Delete…",
    refresh: "Refresh",
    noData: "No data.",
    warningApply: "Apply the previewed governance action? Candidates will be quarantined and remain reversible.",
    warningRestore: "Restore this Memory to its original source?",
    warningUndo:
      "Undo this Learning outcome? Linked patterns will be decremented or deleted when their frequency reaches zero.",
    warningFeedback:
      "Delete this feedback? If it created a Learning outcome, the linked outcome and pattern contribution are also undone.",
    localOnly: "Stored locally",
  },
  zh: {
    diagnostics: "诊断工作台",
    diagnosticsHelp: "仅在明确点击后执行只读检查；不会调用模型、修改文件或生成发布批准。",
    multimodal: "Multimodal",
    mode: "检查模式",
    modeError: "错误 / 文档",
    modeFrontend: "前端 HTML / Vue",
    modeJavaScript: "JavaScript",
    modeHelp: "选择与文件匹配的检查。所有模式均在本机只读执行。",
    file: "图片或文档路径",
    extracted: "已提取的错误文本（可选）",
    run: "运行诊断",
    cancelDiagnosis: "取消检查",
    diagnosisCancelled: "检查已取消，未修改任何文件。",
    diagnosisResult: "诊断结果",
    diagnosisPath: "路径",
    diagnosisSource: "来源",
    diagnosisChecks: "检查项",
    diagnosisSignals: "条信号",
    diagnosisIssues: "发现项",
    diagnosisSuggestions: "下一步",
    diagnosisNoIssues: "本次确定性检查没有报告发现项。",
    diagnosisRaw: "原始证据（高级）",
    diagnosisLocalOnly: "仅本机",
    yes: "是",
    no: "否",
    diagnosisModelCalls: "模型调用",
    diagnosisNotChecked: "外部引用仅列出，不会联网获取。",
    assetPreviewTitle: "外部资源本地化预览",
    assetPreviewHint: "只读发现会显示精确请求指纹；不会联网、写入文件或产生审批。",
    assetPreviewReady: "可等待后续明确审批",
    assetPreviewNone: "没有需要本地化的外部资源",
    assetPreviewBlocked: "预览不可用",
    assetPreviewDigest: "发现指纹",
    assetPreviewScope: "外部请求",
    assetPreviewReferences: "引用",
    assetPreviewNoExecution: "这只是预览。只有同一 ActionGateway 审批路径可用后，才会开放获取与写入。",
    repo: "Repo Scale",
    repoPath: "仓库路径（相对于当前工作区）",
    repoPathHelp: "当前范围较大时请填写项目子目录，避免扫描整个用户主目录。",
    repoQuery: "搜索关键词（可选）",
    scan: "扫描仓库",
    quality: "Quality",
    files: "变更文件（每行一个）",
    patch: "Patch 文本（可选）",
    assess: "评估质量",
    running: "正在运行…",
    memoryLearning: "Memory 与 Learning 治理",
    createMemory: "新建 Memory",
    content: "记忆内容",
    tags: "标签（逗号分隔）",
    importance: "重要性（0–5）",
    create: "创建",
    status: "状态",
    total: "总数",
    important: "重要",
    quarantined: "已隔离",
    recallInspector: "记忆召回检查器",
    recallInspectorHelp:
      "使用 Session 准备阶段相同的本地混合排序器，并展示每个入选候选；该预览不会声称某次模型调用已经使用了结果。",
    recallQuery: "用于测试的问题或任务",
    inspectRecall: "检查召回过程",
    recallNotRun: "输入一个真实问题，检查原本隐藏的检索链路。",
    recallNoHits: "当前查询没有命中任何有效记忆。",
    recallPipeline: "检索过程",
    recallNormalize: "1. 规范化查询",
    recallScope: "2. 过滤本地作用域",
    recallRank: "3. 混合排序",
    recallSelect: "4. 选择上下文候选",
    recallAlgorithm: "排序器",
    recallLocal: "仅本机",
    recallCandidates: "入选候选",
    recallScore: "综合分数",
    recallLexical: "词法分数",
    recallVector: "向量分数",
    recallTerms: "命中词",
    recallSource: "来源 / 作用域",
    recallEvidenceCaveat:
      "检查证据：这里只证明排序器当前返回了什么。要证明某次模型调用实际收到了什么，还需要绑定来源会话的执行证据。",
    actualRecallEvidence: "真实 Session 召回证据",
    actualRecallEvidenceHelp:
      "上下文容量检查通过后、调用模型提供商前立即写入的不可变事件；仅保存 ID、分数和摘要，不复制消息或记忆正文。",
    contextFusionEvidence: "真实上下文组装证据",
    contextFusionEvidenceHelp:
      "一条绑定模型调用的不可变事件，证明 TypeScript 记忆、学习和受控进化为同一次模型调用实际组装了哪些内容；不可用组件会明确标记为降级，不会伪装成功。",
    fusionNoEvidence: "该 Session 尚无上下文组装记录。",
    fusionHealthy: "全部运行时贡献均已准备",
    fusionDegraded: "模型调用在部分贡献降级后继续",
    fusionMemory: "记忆",
    fusionLearning: "学习",
    fusionEvolution: "受控进化",
    fusionRuntime: "运行时",
    fusionCandidates: "候选数",
    fusionActiveCandidates: "活动候选数",
    fusionInjectedCandidates: "已注入候选数",
    fusionBridge: "组装协议",
    combinedDigest: "融合上下文摘要",
    recallNoSession: "请从一个会话内打开设置，以查看该会话的真实召回证据。",
    recallNoEvidence: "当前会话尚无已记录的记忆上下文准备事件。",
    recallPrepared: "已为模型调用准备",
    recallUnavailable: "召回引擎不可用",
    sourceSession: "会话",
    sourceUserMessage: "用户消息",
    sourceTurnStep: "调用步骤",
    injectedBytes: "注入字节数",
    queryDigest: "查询摘要",
    contextDigest: "上下文摘要",
    preview: "预览治理",
    apply: "确认并隔离候选项…",
    restore: "恢复来源",
    recentMemories: "最近记忆",
    correctMemory: "纠正",
    correctionReason: "为什么需要这次纠正？",
    saveCorrection: "保存纠正",
    cancel: "取消",
    history: "纠错历史",
    corrected: "已创建可审计的纠正后继。",
    correctionUndone: "已撤销记忆纠正。",
    warningUndoCorrection: "撤销这次纠正并恢复被替代的记忆？",
    sourceUser: "用户创建",
    sourceCorrected: "用户已纠正",
    sourceImported: "已导入",
    sourceAuto: "自动学习",
    sourceModel: "模型提议",
    sourceQuarantined: "已隔离",
    correctionActive: "可撤销",
    correctionUndoneStatus: "已撤销",
    conflictGovernance: "记忆冲突裁决",
    conflictHelp: "仅使用可解释的确定性规则；不会根据相似度或模型判断自动隔离记忆。",
    pendingConflicts: "待裁决冲突",
    scanConflicts: "扫描冲突",
    conflictHistory: "裁决历史",
    conflictOpenOnly: "仅看待处理",
    conflictScanSummary: "已扫描 {scanned} 条，发现 {detected} 组，新增 {added} 个候选。",
    conflictKey: "事实键",
    explicitBasis: "显式 fact-key 标签",
    patternBasis: "确定性属性句式",
    reviewConflict: "开始裁决",
    decisionReason: "本次选择的证据或理由",
    keepLeft: "保留左侧记忆",
    keepRight: "保留右侧记忆",
    dismissConflict: "并非冲突",
    conflictResolved: "冲突已裁决；另一条记忆已隔离。",
    conflictDismissed: "已记录为非冲突，两条记忆均未修改。",
    conflictResolutionUndone: "已撤销冲突裁决，两条记忆均重新激活。",
    warningResolveConflict: "保留所选记忆并隔离另一条？此操作仍可撤销。",
    warningDismissConflict: "将这组精确内容记录为并非冲突？",
    warningUndoConflict: "撤销这次冲突裁决并重新激活已隔离的记忆？",
    chosenMemory: "已保留",
    retiredMemory: "已隔离",
    conflictPending: "待裁决",
    conflictResolvedStatus: "已裁决",
    conflictDismissedStatus: "并非冲突",
    conflictUndoneStatus: "裁决已撤销",
    noConflicts: "没有待处理的确定性冲突。",
    learningCaveat: "至少需要 3 条注入样本和 3 条基线样本；达到要求前，提升率按 0 计算。",
    learning: "Learning",
    turns: "记录数",
    successRate: "成功率",
    patterns: "模式",
    undo: "撤销…",
    feedback: "Feedback 治理",
    average: "平均评分",
    delete: "删除…",
    refresh: "刷新",
    noData: "暂无数据。",
    warningApply: "应用已预览的治理操作？候选项会被隔离，但仍可恢复。",
    warningRestore: "将这条 Memory 恢复到治理前的原始来源？",
    warningUndo: "撤销这条 Learning 记录？关联模式会递减，频次降为零时会一并删除。",
    warningFeedback: "删除这条 Feedback？若它创建了 Learning 记录，关联记录及模式贡献也会撤销。",
    localOnly: "仅存储在本机",
  },
  zht: {
    diagnostics: "診斷工作台",
    diagnosticsHelp: "僅在明確點擊後執行唯讀檢查；不會呼叫模型、修改檔案或產生發佈批准。",
    multimodal: "Multimodal",
    mode: "檢查模式",
    modeError: "錯誤 / 文件",
    modeFrontend: "前端 HTML / Vue",
    modeJavaScript: "JavaScript",
    modeHelp: "選擇與文件匹配的檢查。所有模式均在本機唯讀執行。",
    file: "圖片或文件路徑",
    extracted: "已擷取的錯誤文字（可選）",
    run: "執行診斷",
    cancelDiagnosis: "取消檢查",
    diagnosisCancelled: "檢查已取消，未修改任何檔案。",
    diagnosisResult: "診斷結果",
    diagnosisPath: "路徑",
    diagnosisSource: "來源",
    diagnosisChecks: "檢查項",
    diagnosisSignals: "個訊號",
    diagnosisIssues: "發現項",
    diagnosisSuggestions: "下一步",
    diagnosisNoIssues: "本次確定性檢查沒有報告發現項。",
    diagnosisRaw: "原始證據（進階）",
    diagnosisLocalOnly: "僅本機",
    yes: "是",
    no: "否",
    diagnosisModelCalls: "模型呼叫",
    diagnosisNotChecked: "外部引用僅列出，不會聯網取得。",
    assetPreviewTitle: "外部資源本地化預覽",
    assetPreviewHint: "唯讀發現會顯示精確請求指紋；不會聯網、寫入檔案或產生審批。",
    assetPreviewReady: "可等待後續明確審批",
    assetPreviewNone: "沒有需要本地化的外部資源",
    assetPreviewBlocked: "預覽不可用",
    assetPreviewDigest: "發現指紋",
    assetPreviewScope: "外部請求",
    assetPreviewReferences: "引用",
    assetPreviewNoExecution: "這只是預覽。只有同一 ActionGateway 審批路徑可用後，才會開放取得與寫入。",
    repo: "Repo Scale",
    repoPath: "儲存庫路徑（相對於目前工作區）",
    repoPathHelp: "目前範圍較大時請填寫專案子目錄，避免掃描整個使用者主目錄。",
    repoQuery: "搜尋關鍵字（可選）",
    scan: "掃描儲存庫",
    quality: "Quality",
    files: "變更檔案（每行一個）",
    patch: "Patch 文字（可選）",
    assess: "評估品質",
    running: "正在執行…",
    memoryLearning: "Memory 與 Learning 治理",
    createMemory: "新增 Memory",
    content: "記憶內容",
    tags: "標籤（逗號分隔）",
    importance: "重要性（0–5）",
    create: "建立",
    status: "狀態",
    total: "總數",
    important: "重要",
    quarantined: "已隔離",
    recallInspector: "記憶召回檢查器",
    recallInspectorHelp:
      "使用 Session 準備階段相同的本機混合排序器，並展示每個入選候選；此預覽不會聲稱某次模型呼叫已使用結果。",
    recallQuery: "用於測試的問題或任務",
    inspectRecall: "檢查召回過程",
    recallNotRun: "輸入一個真實問題，檢查原本隱藏的檢索鏈路。",
    recallNoHits: "目前查詢沒有命中任何有效記憶。",
    recallPipeline: "檢索過程",
    recallNormalize: "1. 規範化查詢",
    recallScope: "2. 過濾本機範圍",
    recallRank: "3. 混合排序",
    recallSelect: "4. 選擇上下文候選",
    recallAlgorithm: "排序器",
    recallLocal: "僅本機",
    recallCandidates: "入選候選",
    recallScore: "綜合分數",
    recallLexical: "詞法分數",
    recallVector: "向量分數",
    recallTerms: "命中詞",
    recallSource: "來源 / 範圍",
    recallEvidenceCaveat:
      "檢查證據：這裡只證明排序器目前回傳了什麼。要證明某次模型呼叫實際收到什麼，還需要綁定來源 Session 的執行證據。",
    actualRecallEvidence: "真實 Session 召回證據",
    actualRecallEvidenceHelp:
      "上下文容量檢查通過後、呼叫模型提供商前立即寫入的不可變事件；僅儲存 ID、分數和摘要，不複製訊息或記憶正文。",
    contextFusionEvidence: "真實上下文組裝證據",
    contextFusionEvidenceHelp:
      "一條綁定模型呼叫的不可變事件，證明 TypeScript 記憶、學習與受控進化為同一次模型呼叫實際組裝了哪些內容；不可用元件會明確標記為降級，不會偽裝成功。",
    fusionNoEvidence: "此 Session 尚無上下文組裝記錄。",
    fusionHealthy: "全部執行時貢獻均已準備",
    fusionDegraded: "模型呼叫在部分貢獻降級後繼續",
    fusionMemory: "記憶",
    fusionLearning: "學習",
    fusionEvolution: "受控進化",
    fusionRuntime: "執行時",
    fusionCandidates: "候選數",
    fusionActiveCandidates: "活動候選數",
    fusionInjectedCandidates: "已注入候選數",
    fusionBridge: "組裝協定",
    combinedDigest: "融合上下文摘要",
    recallNoSession: "請從一個 Session 內開啟設定，以查看該 Session 的真實召回證據。",
    recallNoEvidence: "目前 Session 尚無已記錄的記憶上下文準備事件。",
    recallPrepared: "已為模型呼叫準備",
    recallUnavailable: "召回引擎不可用",
    sourceSession: "Session",
    sourceUserMessage: "使用者訊息",
    sourceTurnStep: "呼叫步驟",
    injectedBytes: "注入位元組數",
    queryDigest: "查詢摘要",
    contextDigest: "上下文摘要",
    preview: "預覽治理",
    apply: "確認並隔離候選項…",
    restore: "恢復來源",
    recentMemories: "最近記憶",
    correctMemory: "糾正",
    correctionReason: "為什麼需要這次糾正？",
    saveCorrection: "儲存糾正",
    cancel: "取消",
    history: "糾錯歷史",
    corrected: "已建立可稽核的糾正後繼。",
    correctionUndone: "已撤銷記憶糾正。",
    warningUndoCorrection: "撤銷這次糾正並恢復被替代的記憶？",
    sourceUser: "使用者建立",
    sourceCorrected: "使用者已糾正",
    sourceImported: "已匯入",
    sourceAuto: "自動學習",
    sourceModel: "模型提議",
    sourceQuarantined: "已隔離",
    correctionActive: "可撤銷",
    correctionUndoneStatus: "已撤銷",
    conflictGovernance: "記憶衝突裁決",
    conflictHelp: "僅使用可解釋的確定性規則；不會依相似度或模型判斷自動隔離記憶。",
    pendingConflicts: "待裁決衝突",
    scanConflicts: "掃描衝突",
    conflictHistory: "裁決歷史",
    conflictOpenOnly: "僅看待處理",
    conflictScanSummary: "已掃描 {scanned} 筆，發現 {detected} 組，新增 {added} 個候選。",
    conflictKey: "事實鍵",
    explicitBasis: "明確 fact-key 標籤",
    patternBasis: "確定性屬性句式",
    reviewConflict: "開始裁決",
    decisionReason: "本次選擇的證據或理由",
    keepLeft: "保留左側記憶",
    keepRight: "保留右側記憶",
    dismissConflict: "並非衝突",
    conflictResolved: "衝突已裁決；另一筆記憶已隔離。",
    conflictDismissed: "已記錄為非衝突，兩筆記憶均未修改。",
    conflictResolutionUndone: "已撤銷衝突裁決，兩筆記憶均重新啟用。",
    warningResolveConflict: "保留所選記憶並隔離另一筆？此操作仍可撤銷。",
    warningDismissConflict: "將這組精確內容記錄為並非衝突？",
    warningUndoConflict: "撤銷這次衝突裁決並重新啟用已隔離的記憶？",
    chosenMemory: "已保留",
    retiredMemory: "已隔離",
    conflictPending: "待裁決",
    conflictResolvedStatus: "已裁決",
    conflictDismissedStatus: "並非衝突",
    conflictUndoneStatus: "裁決已撤銷",
    noConflicts: "沒有待處理的確定性衝突。",
    learningCaveat: "至少需要 3 筆注入樣本和 3 筆基線樣本；達到要求前，提升率按 0 計算。",
    learning: "Learning",
    turns: "記錄數",
    successRate: "成功率",
    patterns: "模式",
    undo: "撤銷…",
    feedback: "Feedback 治理",
    average: "平均評分",
    delete: "刪除…",
    refresh: "重新整理",
    noData: "暫無資料。",
    warningApply: "套用已預覽的治理操作？候選項會被隔離，但仍可恢復。",
    warningRestore: "將這條 Memory 恢復到治理前的原始來源？",
    warningUndo: "撤銷這條 Learning 記錄？關聯模式會遞減，頻次降為零時會一併刪除。",
    warningFeedback: "刪除這條 Feedback？若它建立了 Learning 記錄，關聯記錄及模式貢獻也會撤銷。",
    localOnly: "僅儲存在本機",
  },
} as const

type Copy = { readonly [Key in keyof (typeof copy)["en"]]: string }
const useCopy = () => {
  const language = useLanguage()
  return () => copy[language.locale() as keyof typeof copy] ?? copy.en
}

function Result(props: { value: unknown }) {
  return (
    <pre class="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-background-stronger p-3 text-11-regular text-text-weak">
      {JSON.stringify(props.value, null, 2)}
    </pre>
  )
}

type DiagnosisResult = Awaited<ReturnType<OperationsApi["diagnostics"]["diagnose"]>>

function DiagnosisResultView(props: { value: DiagnosisResult; locale: Locale; copy: Copy }) {
  const result = props.value
  const frontend = result.frontend
  const issues = frontend?.issues ?? []
  const mode = result.mode as DiagnosisMode
  return (
    <section
      class="flex flex-col gap-3 rounded-md border border-border-weak-base bg-background-base p-3"
      data-testid="diagnostics-result"
      aria-live="polite"
    >
      <header class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 class="text-13-medium text-text-strong">{props.copy.diagnosisResult}</h4>
          <p class="text-11-regular text-text-weak">{diagnosisModeLabel(mode, props.locale)}</p>
        </div>
        <span
          class={
            result.success
              ? "rounded-full bg-icon-success-base px-2 py-1 text-11-medium text-text-on-success"
              : "rounded-full bg-icon-warning-base px-2 py-1 text-11-medium text-text-on-warning"
          }
          data-testid="diagnostics-status"
        >
          {diagnosisStatusLabel(result.success, props.locale)}
        </span>
      </header>
      <dl class="grid grid-cols-2 gap-x-3 gap-y-2 text-11-regular text-text-weak">
        <div>
          <dt class="text-text-subtle">{props.copy.diagnosisPath}</dt>
          <dd class="break-all">{result.path}</dd>
        </div>
        <div>
          <dt class="text-text-subtle">{props.copy.diagnosisSource}</dt>
          <dd>{result.source.type}</dd>
        </div>
        <div>
          <dt class="text-text-subtle">{props.copy.diagnosisChecks}</dt>
          <dd>
            {frontend
              ? `${issues.length} ${props.copy.diagnosisIssues}`
              : `${result.summary.signals} ${props.copy.diagnosisSignals}`}
          </dd>
        </div>
        <div>
          <dt class="text-text-subtle">{props.copy.diagnosisLocalOnly}</dt>
          <dd>{result.localOnly ? props.copy.yes : props.copy.no}</dd>
        </div>
        <div>
          <dt class="text-text-subtle">{props.copy.diagnosisModelCalls}</dt>
          <dd>{result.modelCalls}</dd>
        </div>
      </dl>
      <Show when={result.source.error}>{(error) => <p class="text-11-regular text-text-danger">{error()}</p>}</Show>
      <Show when={frontend}>
        <div class="flex flex-col gap-2" data-testid="diagnostics-findings">
          <h5 class="text-12-medium text-text-strong">
            {props.copy.diagnosisIssues} ({issues.length})
          </h5>
          <Show
            when={issues.length > 0}
            fallback={<p class="text-11-regular text-text-weak">{props.copy.diagnosisNoIssues}</p>}
          >
            <ul class="flex flex-col gap-1">
              <For each={issues.slice(0, 20)}>
                {(issue) => (
                  <li class="text-11-regular text-text-weak">
                    <span class="text-text-strong">
                      {diagnosisSeverityLabel(issue.severity as DiagnosisSeverity, props.locale)}:
                    </span>{" "}
                    {issue.message}
                    <Show when={issue.line !== undefined}> · {issue.line}</Show>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <Show when={frontend?.externalAssets.length}>
            <p class="text-11-regular text-text-weak">{props.copy.diagnosisNotChecked}</p>
          </Show>
          <Show when={frontend?.assetLocalizationPreview}>
            {(preview) => (
              <article
                class="flex flex-col gap-2 rounded-md border border-border-weak-base bg-background-stronger p-2"
                data-testid="asset-localization-preview"
              >
                <div>
                  <h5 class="text-12-medium text-text-strong">{props.copy.assetPreviewTitle}</h5>
                  <p class="text-11-regular text-text-weak">{props.copy.assetPreviewHint}</p>
                </div>
                <dl class="grid grid-cols-2 gap-x-3 gap-y-1 text-11-regular text-text-weak">
                  <div>
                    <dt class="text-text-subtle">{props.copy.status}</dt>
                    <dd>
                      {preview().status === "ready"
                        ? props.copy.assetPreviewReady
                        : preview().status === "none"
                          ? props.copy.assetPreviewNone
                          : props.copy.assetPreviewBlocked}
                    </dd>
                  </div>
                  <div>
                    <dt class="text-text-subtle">{props.copy.assetPreviewScope}</dt>
                    <dd>{preview().networkScopeCount}</dd>
                  </div>
                  <div>
                    <dt class="text-text-subtle">{props.copy.assetPreviewReferences}</dt>
                    <dd>{preview().references.length}</dd>
                  </div>
                  <div>
                    <dt class="text-text-subtle">{props.copy.diagnosisPath}</dt>
                    <dd class="break-all">{preview().htmlResource}</dd>
                  </div>
                </dl>
                <Show when={preview().discoveryDigest}>
                  {(digest) => (
                    <p class="break-all text-11-regular text-text-weak">
                      <span class="text-text-subtle">{props.copy.assetPreviewDigest}: </span>
                      <span title={digest()}>{digest()}</span>
                    </p>
                  )}
                </Show>
                <Show when={preview().references.length > 0}>
                  <ul class="flex flex-col gap-1 text-11-regular text-text-weak">
                    <For each={preview().references.slice(0, 8)}>
                      {(reference) => (
                        <li class="break-all">
                          {reference.kind}: {reference.url}
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
                <Show when={preview().reason}>
                  {(reason) => <p class="text-11-regular text-text-weak">{reason()}</p>}
                </Show>
                <p class="text-11-regular text-text-subtle">{props.copy.assetPreviewNoExecution}</p>
              </article>
            )}
          </Show>
        </div>
      </Show>
      <Show when={result.suggestions.length > 0}>
        <div class="text-11-regular text-text-weak">
          <p class="text-text-subtle">{props.copy.diagnosisSuggestions}</p>
          <ul class="list-disc pl-4">
            <For each={result.suggestions.slice(0, 5)}>{(suggestion) => <li>{suggestion}</li>}</For>
          </ul>
        </div>
      </Show>
      <details>
        <summary class="cursor-pointer text-11-medium text-text-weak">{props.copy.diagnosisRaw}</summary>
        <div class="mt-2">
          <Result value={result} />
        </div>
      </details>
    </section>
  )
}

export function DiagnosticsWorkbench(props: {
  api: () => OperationsApi
  location: () => LocationInput
  ready: () => boolean
}) {
  const c = useCopy()
  type Repo = Awaited<ReturnType<OperationsApi["agentCapabilities"]["repoScale"]>>["data"]
  type Quality = Awaited<ReturnType<OperationsApi["agentCapabilities"]["qualityAssess"]>>["data"]
  const language = useLanguage()
  const locale = () => language.locale() as Locale
  const [state, setState] = createStore({
    loading: "",
    error: "",
    notice: "",
    repoPath: ".",
    filename: "",
    extractedText: "",
    diagnosisMode: "error" as DiagnosisMode,
    repoQuery: "",
    qualityFiles: "",
    patchText: "",
    diagnosis: undefined as DiagnosisResult | undefined,
    repo: undefined as Repo | undefined,
    quality: undefined as Quality | undefined,
  })
  let activeController: AbortController | undefined
  const locationScopeKey = () => {
    const value = props.location().location
    return value.directory + "\u0000" + (value.workspace ?? "")
  }
  const scopeGuard = createScopeRequestGuard(locationScopeKey)
  const run = async (
    kind: string,
    action: (location: LocationInput, request: ScopeRequestToken, signal: AbortSignal) => Promise<void>,
  ) => {
    if (!props.ready() || state.loading) return
    const request = scopeGuard.capture()
    const requestedLocation = props.location()
    const controller = new AbortController()
    activeController = controller
    setState({ loading: kind, error: "", notice: "" })
    try {
      await action(requestedLocation, request, controller.signal)
    } catch (error) {
      if (scopeGuard.isCurrent(request)) {
        if (controller.signal.aborted) setState({ error: "", notice: c().diagnosisCancelled })
        else setState("error", publicErrorMessage(error))
      }
    } finally {
      if (activeController === controller) activeController = undefined
      if (scopeGuard.isCurrent(request)) setState("loading", "")
    }
  }
  const cancelActive = () => activeController?.abort()
  let previousScopeKey: string | undefined
  createEffect(
    on(
      () => (props.ready() ? "ready" : "not-ready") + "\u0000" + locationScopeKey(),
      (scopeKey) => {
        scopeGuard.current()
        const scopeChanged = previousScopeKey !== undefined && previousScopeKey !== scopeKey
        previousScopeKey = scopeKey
        if (!props.ready() || !scopeChanged) return
        activeController?.abort()
        activeController = undefined
        setState({ loading: "", error: "", notice: "", diagnosis: undefined, repo: undefined, quality: undefined })
      },
    ),
  )
  return (
    <section
      class="flex flex-col gap-4 rounded-lg border border-border-weak-base p-4"
      data-testid="diagnostics-workbench"
      aria-busy={!!state.loading}
    >
      <header>
        <h2 class="text-14-medium text-text-strong">{c().diagnostics}</h2>
        <p class="mt-1 text-12-regular text-text-weak">{c().diagnosticsHelp}</p>
      </header>
      <Show when={state.error}>
        <div role="alert" class="rounded-md border border-border-danger p-3 text-12-regular text-text-danger">
          {state.error}
        </div>
      </Show>
      <Show when={state.notice}>
        <div role="status" class="rounded-md border border-border-weak-base p-3 text-12-regular text-text-weak">
          {state.notice}
        </div>
      </Show>
      <div class="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <article class="flex flex-col gap-3 rounded-md border border-border-weak-base p-3">
          <h3 class="text-13-medium text-text-strong">{c().multimodal}</h3>
          <label class="flex flex-col gap-1 text-11-regular text-text-weak">
            <span>{c().mode}</span>
            <select
              class="rounded-md border border-border-weak-base bg-background-base p-2 text-12-regular text-text-strong"
              aria-label={c().mode}
              data-testid="diagnostics-mode"
              value={state.diagnosisMode}
              disabled={!!state.loading}
              onChange={(event) => setState("diagnosisMode", event.currentTarget.value as DiagnosisMode)}
            >
              <option value="error">{c().modeError}</option>
              <option value="frontend">{c().modeFrontend}</option>
              <option value="javascript">{c().modeJavaScript}</option>
            </select>
          </label>
          <p class="text-11-regular text-text-weak" data-testid="diagnostics-mode-help">
            {c().modeHelp} {diagnosisModeHint(state.diagnosisMode, locale())}
          </p>
          <TextField label={c().file} value={state.filename} onChange={(value) => setState("filename", value)} />
          <textarea
            class="min-h-24 rounded-md border border-border-weak-base bg-background-base p-3 text-12-regular"
            aria-label={c().extracted}
            placeholder={c().extracted}
            value={state.extractedText}
            onInput={(event) => setState("extractedText", event.currentTarget.value)}
          />
          <div class="flex flex-wrap gap-2">
            <Button
              size="small"
              variant="secondary"
              disabled={!state.filename.trim() || !!state.loading}
              onClick={() =>
                void run("diagnosis", async (location, request, signal) => {
                  const result = await props.api().diagnostics.diagnose(
                    {
                      ...location,
                      filename: state.filename.trim(),
                      ...(state.extractedText ? { extractedText: state.extractedText } : {}),
                      limit: 20,
                      mode: state.diagnosisMode,
                    },
                    { signal },
                  )
                  if (scopeGuard.isCurrent(request)) setState("diagnosis", result)
                })
              }
            >
              {state.loading === "diagnosis" ? c().running : c().run}
            </Button>
            <Show when={state.loading === "diagnosis"}>
              <Button size="small" variant="ghost" onClick={cancelActive} data-testid="diagnostics-cancel">
                {c().cancelDiagnosis}
              </Button>
            </Show>
          </div>
          <Show when={state.diagnosis}>
            {(value) => <DiagnosisResultView value={value()} locale={locale()} copy={c()} />}
          </Show>
        </article>
        <article class="flex flex-col gap-3 rounded-md border border-border-weak-base p-3">
          <h3 class="text-13-medium text-text-strong">{c().repo}</h3>
          <TextField label={c().repoPath} value={state.repoPath} onChange={(value) => setState("repoPath", value)} />
          <p class="text-11-regular text-text-weak">{c().repoPathHelp}</p>
          <TextField label={c().repoQuery} value={state.repoQuery} onChange={(value) => setState("repoQuery", value)} />
          <Button
            size="small"
            variant="secondary"
            disabled={!!state.loading}
            onClick={() =>
              void run("repo", async (location, request, signal) => {
                const result = await props.api().agentCapabilities.repoScale(
                  {
                    ...location,
                    path: state.repoPath.trim() || ".",
                    ...(state.repoQuery.trim() ? { query: state.repoQuery.trim() } : {}),
                    maxFiles: 5_000,
                    limit: 30,
                  },
                  { signal },
                )
                if (scopeGuard.isCurrent(request)) setState("repo", result.data)
              })
            }
          >
            {state.loading === "repo" ? c().running : c().scan}
          </Button>
          <Show when={state.repo}>{(value) => <Result value={value()} />}</Show>
        </article>
        <article class="flex flex-col gap-3 rounded-md border border-border-weak-base p-3">
          <h3 class="text-13-medium text-text-strong">{c().quality}</h3>
          <textarea
            class="min-h-20 rounded-md border border-border-weak-base bg-background-base p-3 text-12-regular"
            aria-label={c().files}
            placeholder={c().files}
            value={state.qualityFiles}
            onInput={(event) => setState("qualityFiles", event.currentTarget.value)}
          />
          <textarea
            class="min-h-24 rounded-md border border-border-weak-base bg-background-base p-3 text-12-regular"
            aria-label={c().patch}
            placeholder={c().patch}
            value={state.patchText}
            onInput={(event) => setState("patchText", event.currentTarget.value)}
          />
          <Button
            size="small"
            variant="secondary"
            disabled={!!state.loading}
            onClick={() =>
              void run("quality", async (location, request, signal) => {
                const files = state.qualityFiles
                  .split(/\r?\n/)
                  .map((value) => value.trim())
                  .filter(Boolean)
                const result = await props.api().agentCapabilities.qualityAssess(
                  {
                    ...location,
                    ...(files.length ? { files } : {}),
                    ...(state.patchText ? { patchText: state.patchText } : {}),
                  },
                  { signal },
                )
                if (scopeGuard.isCurrent(request)) setState("quality", result.data)
              })
            }
          >
            {state.loading === "quality" ? c().running : c().assess}
          </Button>
          <Show when={state.quality}>{(value) => <Result value={value()} />}</Show>
        </article>
      </div>
    </section>
  )
}

export function MemoryLearningGovernance(props: {
  api: () => OperationsApi
  location: () => LocationInput
  ready: () => boolean
  sessionID?: string
}) {
  const c = useCopy()
  type MemoryStatus = Awaited<ReturnType<OperationsApi["memories"]["status"]>>
  type SemanticResults = Awaited<ReturnType<OperationsApi["memories"]["semantic"]>>
  type Governance = Awaited<ReturnType<OperationsApi["memories"]["governancePreview"]>>
  type CorrectionHistory = Awaited<ReturnType<OperationsApi["memories"]["correctionHistory"]>>
  type ConflictPage = Awaited<ReturnType<OperationsApi["memories"]["conflictList"]>>
  type Learning = Awaited<ReturnType<OperationsApi["learning"]["status"]>>
  type FeedbackPage = Awaited<ReturnType<OperationsApi["feedback"]["list"]>>
  type FeedbackSummary = Awaited<ReturnType<OperationsApi["feedback"]["summary"]>>
  type SessionHistory = Awaited<ReturnType<OperationsApi["sessions"]["history"]>>
  type RecallEvidence = Extract<SessionHistory["data"][number], { type: "session.next.memory.context.prepared" }>
  type FusionEvidence = Extract<SessionHistory["data"][number], { type: "session.next.context.fusion.prepared" }>
  const [state, setState] = createStore({
    loading: false,
    error: "",
    notice: "",
    content: "",
    tags: "",
    importance: 3,
    recallQuery: "",
    recallExecuted: false,
    recallResult: undefined as SemanticResults | undefined,
    recallEvidence: [] as RecallEvidence[],
    fusionEvidence: [] as FusionEvidence[],
    correctingID: "",
    correctionContent: "",
    correctionReason: "",
    historyMemoryID: "",
    correctionHistory: undefined as CorrectionHistory | undefined,
    reviewingConflictID: "",
    conflictReason: "",
    showConflictHistory: false,
    conflictScanNotice: "",
    conflicts: undefined as ConflictPage | undefined,
    memory: undefined as MemoryStatus | undefined,
    governance: undefined as Governance | undefined,
    learning: undefined as Learning | undefined,
    feedback: undefined as FeedbackPage | undefined,
    feedbackSummary: undefined as FeedbackSummary | undefined,
  })
  const sourceLabel = (source: NonNullable<MemoryStatus>["recent"][number]["source"]) => {
    if (source === "user") return c().sourceUser
    if (source === "user-corrected") return c().sourceCorrected
    if (source === "imported") return c().sourceImported
    if (source === "auto") return c().sourceAuto
    if (source === "model") return c().sourceModel
    return c().sourceQuarantined
  }
  const correctionStatusLabel = (status: "active" | "undone") =>
    status === "active" ? c().correctionActive : c().correctionUndoneStatus
  const conflictStatusLabel = (status: "pending" | "resolved" | "dismissed" | "undone") => {
    if (status === "resolved") return c().conflictResolvedStatus
    if (status === "dismissed") return c().conflictDismissedStatus
    if (status === "undone") return c().conflictUndoneStatus
    return c().conflictPending
  }
  const conflictBasisLabel = (basis: "explicit-tag" | "deterministic-pattern-v1") =>
    basis === "explicit-tag" ? c().explicitBasis : c().patternBasis
  const formatConflictScanNotice = (value: { scanned: number; detected: number; newCandidates: number }) =>
    c()
      .conflictScanSummary.replace("{scanned}", String(value.scanned))
      .replace("{detected}", String(value.detected))
      .replace("{added}", String(value.newCandidates))
  const locationScopeKey = () => {
    const value = props.location().location
    return value.directory + "\u0000" + (value.workspace ?? "")
  }
  const scopeGuard = createScopeRequestGuard(locationScopeKey)
  let previousScopeKey: string | undefined
  const refresh = async () => {
    if (!props.ready() || state.loading) return
    const request = scopeGuard.capture()
    const requestedLocation = props.location()
    setState({ loading: true, error: "", notice: "" })
    try {
      const [memory, conflicts, learning, feedback, feedbackSummary, history] = await Promise.all([
        props.api().memories.status(requestedLocation),
        props.api().memories.conflictList({
          ...requestedLocation,
          ...(state.showConflictHistory ? { includeClosed: "true" as const } : {}),
          limit: 100,
        }),
        props.api().learning.status(requestedLocation),
        props.api().feedback.list({ ...requestedLocation, limit: 50 }),
        props.api().feedback.summary(requestedLocation),
        props.sessionID
          ? props.api().sessions.history({
              sessionID: props.sessionID as Parameters<OperationsApi["sessions"]["history"]>[0]["sessionID"],
              limit: 100,
            })
          : Promise.resolve(undefined),
      ])
      if (scopeGuard.isCurrent(request)) {
        setState({
          memory,
          conflicts,
          learning,
          feedback,
          feedbackSummary,
          recallEvidence: (history?.data.filter((event) => event.type === "session.next.memory.context.prepared") ??
            []) as RecallEvidence[],
          fusionEvidence: (history?.data.filter((event) => event.type === "session.next.context.fusion.prepared") ??
            []) as FusionEvidence[],
        })
      }
    } catch (error) {
      if (scopeGuard.isCurrent(request)) setState("error", publicErrorMessage(error))
    } finally {
      if (scopeGuard.isCurrent(request)) setState("loading", false)
    }
  }
  const mutate = async (
    action: (location: LocationInput, request: ScopeRequestToken) => Promise<unknown>,
    notice: string,
  ) => {
    if (!props.ready() || state.loading) return
    const request = scopeGuard.capture()
    const requestedLocation = props.location()
    setState({ loading: true, error: "", notice: "" })
    try {
      await action(requestedLocation, request)
      if (scopeGuard.isCurrent(request)) setState("notice", notice)
    } catch (error) {
      if (scopeGuard.isCurrent(request)) setState("error", publicErrorMessage(error))
    } finally {
      if (scopeGuard.isCurrent(request)) setState("loading", false)
    }
    if (scopeGuard.isCurrent(request)) await refresh()
  }
  createEffect(
    on(
      () => (props.ready() ? "ready" : "not-ready") + "\u0000" + locationScopeKey(),
      (scopeKey) => {
        scopeGuard.current()
        const scopeChanged = previousScopeKey !== undefined && previousScopeKey !== scopeKey
        previousScopeKey = scopeKey
        if (!props.ready()) return
        if (scopeChanged) {
          setState({
            loading: false,
            error: "",
            notice: "",
            recallExecuted: false,
            recallResult: undefined,
            recallEvidence: [],
            fusionEvidence: [],
            conflicts: undefined,
            memory: undefined,
            governance: undefined,
            learning: undefined,
            feedback: undefined,
            feedbackSummary: undefined,
            correctionHistory: undefined,
            historyMemoryID: "",
            correctingID: "",
            reviewingConflictID: "",
            conflictReason: "",
            conflictScanNotice: "",
          })
        }
        void refresh()
      },
    ),
  )
  const createMemory = () =>
    void mutate(async (location, request) => {
      await props.api().memories.create({
        ...location,
        content: state.content.trim(),
        tags: state.tags
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
        importance: state.importance,
        source: "user",
        scope: "workspace",
      })
      if (scopeGuard.isCurrent(request)) setState({ content: "", tags: "" })
    }, c().createMemory)
  const preview = async () => {
    if (!props.ready() || state.loading) return
    const request = scopeGuard.capture()
    const requestedLocation = props.location()
    setState({ loading: true, error: "", notice: "" })
    try {
      const governance = await props.api().memories.governancePreview({ ...requestedLocation, sampleLimit: 100 })
      if (scopeGuard.isCurrent(request)) setState("governance", governance)
    } catch (error) {
      if (scopeGuard.isCurrent(request)) setState("error", publicErrorMessage(error))
    } finally {
      if (scopeGuard.isCurrent(request)) setState("loading", false)
    }
  }
  const inspectRecall = async () => {
    const query = state.recallQuery.trim()
    if (!props.ready() || !query || state.loading) return
    const request = scopeGuard.capture()
    const requestedLocation = props.location()
    setState({ loading: true, error: "", notice: "", recallExecuted: false, recallResult: undefined })
    try {
      const recallResult = await props.api().memories.semantic({
        ...requestedLocation,
        query,
        topK: 5,
        includeGlobal: "true",
        indexLimit: 1_000,
      })
      if (scopeGuard.isCurrent(request)) setState({ recallResult, recallExecuted: true })
    } catch (error) {
      if (scopeGuard.isCurrent(request)) setState("error", publicErrorMessage(error))
    } finally {
      if (scopeGuard.isCurrent(request)) setState("loading", false)
    }
  }
  const apply = () => {
    if (!state.governance || !window.confirm(c().warningApply)) return
    void mutate((location) => props.api().memories.governanceApply(location), c().apply)
  }
  const restore = (item: NonNullable<MemoryStatus>["recent"][number]) => {
    const source =
      item.source === "quarantined:model" ? "model" : item.source === "quarantined:auto" ? "auto" : undefined
    if (!source || !window.confirm(c().warningRestore)) return
    void mutate((location) => props.api().memories.update({ ...location, memoryID: item.id, source }), c().restore)
  }
  const beginCorrection = (item: NonNullable<MemoryStatus>["recent"][number]) => {
    setState({
      correctingID: item.id,
      correctionContent: item.content,
      correctionReason: "",
      historyMemoryID: "",
      correctionHistory: undefined,
      error: "",
    })
  }
  const cancelCorrection = () => setState({ correctingID: "", correctionContent: "", correctionReason: "" })
  const saveCorrection = () => {
    const item = state.memory?.recent.find((memory) => memory.id === state.correctingID)
    if (!item || !state.correctionContent.trim() || !state.correctionReason.trim()) return
    void mutate(async (location, request) => {
      await props.api().memories.correct({
        ...location,
        memoryID: item.id,
        content: state.correctionContent.trim(),
        reason: state.correctionReason.trim(),
        expectedUpdatedAt: item.time.updated,
      })
      if (scopeGuard.isCurrent(request)) cancelCorrection()
    }, c().corrected)
  }
  const loadCorrectionHistory = async (memoryID: string) => {
    if (!props.ready() || state.loading) return
    if (state.historyMemoryID === memoryID && state.correctionHistory) {
      setState({ historyMemoryID: "", correctionHistory: undefined })
      return
    }
    const request = scopeGuard.capture()
    const requestedLocation = props.location()
    setState({ loading: true, error: "", notice: "" })
    try {
      const correctionHistory = await props.api().memories.correctionHistory({ ...requestedLocation, memoryID })
      if (!scopeGuard.isCurrent(request)) return
      setState({
        historyMemoryID: memoryID,
        correctionHistory,
      })
    } catch (error) {
      if (scopeGuard.isCurrent(request)) setState("error", publicErrorMessage(error))
    } finally {
      if (scopeGuard.isCurrent(request)) setState("loading", false)
    }
  }
  const undoCorrection = (correctionID: string, successorMemoryID: string) => {
    if (!window.confirm(c().warningUndoCorrection)) return
    void mutate(async (location, request) => {
      const successor = await props.api().memories.get({ ...location, memoryID: successorMemoryID })
      await props.api().memories.undoCorrection({
        ...location,
        correctionID,
        expectedSuccessorUpdatedAt: successor.time.updated,
      })
      if (scopeGuard.isCurrent(request)) setState({ historyMemoryID: "", correctionHistory: undefined })
    }, c().correctionUndone)
  }
  const scanConflicts = async () => {
    if (!props.ready() || state.loading) return
    const request = scopeGuard.capture()
    const requestedLocation = props.location()
    setState({ loading: true, error: "", notice: "", conflictScanNotice: "" })
    try {
      const conflicts = await props.api().memories.conflictScan({
        ...requestedLocation,
        scanLimit: 1_000,
        resultLimit: 100,
      })
      const memory = await props.api().memories.status(requestedLocation)
      if (!scopeGuard.isCurrent(request)) return
      setState({
        conflicts,
        memory,
        showConflictHistory: false,
        conflictScanNotice: formatConflictScanNotice(conflicts),
      })
    } catch (error) {
      if (scopeGuard.isCurrent(request)) setState("error", publicErrorMessage(error))
    } finally {
      if (scopeGuard.isCurrent(request)) setState("loading", false)
    }
  }
  const toggleConflictHistory = async () => {
    if (!props.ready() || state.loading) return
    const includeClosed = !state.showConflictHistory
    const request = scopeGuard.capture()
    const requestedLocation = props.location()
    setState({ loading: true, error: "", notice: "" })
    try {
      const conflicts = await props.api().memories.conflictList({
        ...requestedLocation,
        ...(includeClosed ? { includeClosed: "true" as const } : {}),
        limit: 100,
      })
      if (scopeGuard.isCurrent(request)) setState({ conflicts, showConflictHistory: includeClosed })
    } catch (error) {
      if (scopeGuard.isCurrent(request)) setState("error", publicErrorMessage(error))
    } finally {
      if (scopeGuard.isCurrent(request)) setState("loading", false)
    }
  }
  const beginConflictReview = (conflictID: string) =>
    setState({ reviewingConflictID: conflictID, conflictReason: "", error: "" })
  const cancelConflictReview = () => setState({ reviewingConflictID: "", conflictReason: "" })
  const resolveConflict = (item: NonNullable<ConflictPage>["items"][number], chosenMemoryID: string) => {
    if (!state.conflictReason.trim() || !window.confirm(c().warningResolveConflict)) return
    void mutate(async (location, request) => {
      await props.api().memories.resolveConflict({
        ...location,
        conflictID: item.conflict.id,
        chosenMemoryID,
        reason: state.conflictReason.trim(),
        expectedLeftUpdatedAt: item.left.time.updated,
        expectedRightUpdatedAt: item.right.time.updated,
      })
      if (scopeGuard.isCurrent(request)) cancelConflictReview()
    }, c().conflictResolved)
  }
  const dismissConflict = (item: NonNullable<ConflictPage>["items"][number]) => {
    if (!state.conflictReason.trim() || !window.confirm(c().warningDismissConflict)) return
    void mutate(async (location, request) => {
      await props.api().memories.dismissConflict({
        ...location,
        conflictID: item.conflict.id,
        reason: state.conflictReason.trim(),
        expectedLeftUpdatedAt: item.left.time.updated,
        expectedRightUpdatedAt: item.right.time.updated,
      })
      if (scopeGuard.isCurrent(request)) cancelConflictReview()
    }, c().conflictDismissed)
  }
  const undoConflict = (item: NonNullable<ConflictPage>["items"][number]) => {
    if (!window.confirm(c().warningUndoConflict)) return
    void mutate(
      (location) =>
        props.api().memories.undoConflict({
          ...location,
          conflictID: item.conflict.id,
          expectedLeftUpdatedAt: item.left.time.updated,
          expectedRightUpdatedAt: item.right.time.updated,
        }),
      c().conflictResolutionUndone,
    )
  }
  const undo = (outcomeID: NonNullable<Learning>["recent"][number]["id"]) => {
    if (!window.confirm(c().warningUndo)) return
    void mutate((location) => props.api().learning.undo({ ...location, outcomeID }), c().undo)
  }
  const removeFeedback = (feedbackID: NonNullable<FeedbackPage>["items"][number]["id"]) => {
    if (!window.confirm(c().warningFeedback)) return
    void mutate((location) => props.api().feedback.delete({ ...location, feedbackID }), c().delete)
  }
  return (
    <section
      class="flex flex-col gap-4 rounded-lg border border-border-weak-base p-4"
      data-testid="memory-learning-governance"
      aria-busy={state.loading}
    >
      <header class="flex items-center justify-between gap-3">
        <div>
          <h2 class="text-14-medium text-text-strong">{c().memoryLearning}</h2>
          <p class="mt-1 text-11-regular text-text-weak">{c().localOnly}</p>
        </div>
        <Button size="small" variant="ghost" disabled={state.loading} onClick={() => void refresh()}>
          {c().refresh}
        </Button>
      </header>
      <Show when={state.error}>
        <div role="alert" class="rounded-md border border-border-danger p-3 text-12-regular text-text-danger">
          {state.error}
        </div>
      </Show>
      <Show when={state.notice}>
        <div role="status" class="rounded-md border border-border-weak-base p-3 text-12-regular text-text-weak">
          {state.notice}
        </div>
      </Show>
      <div class="grid gap-3 md:grid-cols-4">
        <Metric label={c().total} value={state.memory?.total ?? "—"} />
        <Metric label={c().important} value={state.memory?.important ?? "—"} />
        <Metric label={c().quarantined} value={state.memory?.quarantined ?? "—"} />
        <Metric label={c().pendingConflicts} value={state.memory?.pendingConflicts ?? "—"} />
      </div>
      <article class="grid gap-3 rounded-md border border-border-weak-base p-3 md:grid-cols-[1fr_220px_auto]">
        <textarea
          class="min-h-24 rounded-md border border-border-weak-base bg-background-base p-3 text-12-regular"
          aria-label={c().content}
          placeholder={c().content}
          value={state.content}
          onInput={(event) => setState("content", event.currentTarget.value)}
        />
        <div class="flex flex-col gap-3">
          <TextField label={c().tags} value={state.tags} onChange={(value) => setState("tags", value)} />
          <label class="text-11-regular text-text-weak">
            {c().importance}
            <input
              class="mt-1 h-9 w-full rounded-md border border-border-weak-base bg-background-base px-3"
              type="number"
              min="0"
              max="5"
              value={state.importance}
              onInput={(event) => setState("importance", Number(event.currentTarget.value))}
            />
          </label>
        </div>
        <Button
          size="small"
          variant="secondary"
          disabled={state.loading || !state.content.trim()}
          onClick={createMemory}
        >
          {c().create}
        </Button>
      </article>
      <article
        class="flex flex-col gap-3 rounded-md border border-border-weak-base p-3"
        data-testid="context-fusion-evidence"
      >
        <header>
          <h3 class="text-13-medium text-text-strong">{c().contextFusionEvidence}</h3>
          <p class="mt-1 max-w-3xl text-11-regular leading-relaxed text-text-weak">{c().contextFusionEvidenceHelp}</p>
        </header>
        <Show when={props.sessionID} fallback={<p class="text-11-regular text-text-weak">{c().recallNoSession}</p>}>
          <Show
            when={state.fusionEvidence.length > 0}
            fallback={<p class="text-11-regular text-text-weak">{c().fusionNoEvidence}</p>}
          >
            <ol class="grid gap-2">
              <For each={state.fusionEvidence.toReversed()}>
                {(event) => (
                  <li
                    class="grid gap-3 rounded-md border bg-background-weak p-3"
                    classList={{
                      "border-border-danger": event.data.degraded,
                      "border-border-weak-base": !event.data.degraded,
                    }}
                  >
                    <div class="flex flex-wrap items-start justify-between gap-2">
                      <span
                        class="text-11-medium"
                        classList={{
                          "text-text-danger": event.data.degraded,
                          "text-text-strong": !event.data.degraded,
                        }}
                      >
                        {event.data.degraded ? c().fusionDegraded : c().fusionHealthy}
                      </span>
                      <time
                        class="text-10-regular text-text-weak"
                        dateTime={new Date(event.data.timestamp).toISOString()}
                      >
                        {new Date(event.data.timestamp).toLocaleString()}
                      </time>
                    </div>
                    <dl class="grid gap-x-4 gap-y-2 text-10-regular sm:grid-cols-2">
                      <RecallFact label={c().sourceSession} value={event.data.sessionID} />
                      <RecallFact label={c().sourceUserMessage} value={event.data.userMessageID} />
                      <RecallFact label={c().sourceTurnStep} value={String(event.data.turnStep)} />
                      <RecallFact label={c().injectedBytes} value={String(event.data.totalInjectedBytes)} />
                      <RecallFact
                        label={c().fusionBridge}
                        value={event.data.assemblyProtocol ?? event.data.bridgeProtocol ?? "unknown"}
                      />
                      <RecallFact label={c().combinedDigest} value={event.data.combinedContextDigest} />
                    </dl>
                    <div class="grid gap-2 lg:grid-cols-3">
                      <FusionContribution
                        title={c().fusionMemory}
                        runtime={event.data.memory.runtime}
                        status={event.data.memory.status === "prepared" ? c().recallPrepared : c().recallUnavailable}
                        bytes={event.data.memory.injectedBytes}
                        digest={event.data.memory.contextDigest}
                        detail={`${c().fusionCandidates}: ${event.data.memory.candidateCount}`}
                        degraded={event.data.memory.status === "unavailable"}
                      />
                      <FusionContribution
                        title={c().fusionLearning}
                        runtime={event.data.learning.runtime}
                        status={event.data.learning.status === "prepared" ? c().recallPrepared : c().recallUnavailable}
                        bytes={event.data.learning.injectedBytes}
                        digest={event.data.learning.contextDigest}
                        degraded={event.data.learning.status === "unavailable"}
                      />
                      <FusionContribution
                        title={c().fusionEvolution}
                        runtime={event.data.evolution.runtime}
                        status={event.data.evolution.status === "prepared" ? c().recallPrepared : c().recallUnavailable}
                        bytes={event.data.evolution.injectedBytes}
                        digest={event.data.evolution.contextDigest}
                        detail={`${c().fusionActiveCandidates}: ${event.data.evolution.activeCandidateCount} · ${c().fusionInjectedCandidates}: ${event.data.evolution.injectedCandidateCount}`}
                        degraded={event.data.evolution.status === "unavailable"}
                      />
                    </div>
                  </li>
                )}
              </For>
            </ol>
          </Show>
        </Show>
      </article>
      <article
        class="flex flex-col gap-3 rounded-md border border-border-weak-base p-3"
        data-testid="memory-recall-evidence"
      >
        <header>
          <h3 class="text-13-medium text-text-strong">{c().actualRecallEvidence}</h3>
          <p class="mt-1 max-w-3xl text-11-regular leading-relaxed text-text-weak">{c().actualRecallEvidenceHelp}</p>
        </header>
        <Show when={props.sessionID} fallback={<p class="text-11-regular text-text-weak">{c().recallNoSession}</p>}>
          <Show
            when={state.recallEvidence.length > 0}
            fallback={<p class="text-11-regular text-text-weak">{c().recallNoEvidence}</p>}
          >
            <ol class="grid gap-2">
              <For each={state.recallEvidence.toReversed()}>
                {(event) => (
                  <li class="grid gap-3 rounded-md bg-background-weak p-3">
                    <div class="flex flex-wrap items-start justify-between gap-2">
                      <span class="text-11-medium text-text-strong">
                        {event.data.status === "prepared" ? c().recallPrepared : c().recallUnavailable}
                      </span>
                      <time
                        class="text-10-regular text-text-weak"
                        dateTime={new Date(event.data.timestamp).toISOString()}
                      >
                        {new Date(event.data.timestamp).toLocaleString()}
                      </time>
                    </div>
                    <dl class="grid gap-x-4 gap-y-2 text-10-regular sm:grid-cols-2">
                      <RecallFact label={c().sourceSession} value={event.data.sessionID} />
                      <RecallFact label={c().sourceUserMessage} value={event.data.userMessageID} />
                      <RecallFact label={c().sourceTurnStep} value={String(event.data.turnStep)} />
                      <RecallFact label={c().injectedBytes} value={String(event.data.injectedBytes)} />
                      <RecallFact label={c().queryDigest} value={event.data.queryDigest} />
                      <RecallFact label={c().contextDigest} value={event.data.contextDigest} />
                    </dl>
                    <Show when={event.data.candidates.length > 0}>
                      <ol class="grid gap-1 border-t border-border-weak-base pt-2">
                        <For each={event.data.candidates}>
                          {(candidate) => (
                            <li class="flex flex-wrap items-center justify-between gap-2 text-10-regular">
                              <span class="text-text-strong">
                                #{candidate.rank} · <code class="break-all">{candidate.memoryID}</code>
                              </span>
                              <span class="text-text-weak">
                                {c().recallScore} {candidate.score.toFixed(3)} · {c().recallLexical}{" "}
                                {candidate.lexicalScore.toFixed(3)} · {c().recallVector}{" "}
                                {candidate.vectorScore.toFixed(3)}
                              </span>
                            </li>
                          )}
                        </For>
                      </ol>
                    </Show>
                  </li>
                )}
              </For>
            </ol>
          </Show>
        </Show>
      </article>
      <article
        class="flex flex-col gap-3 rounded-md border border-border-weak-base p-3"
        data-testid="memory-recall-inspector"
      >
        <header>
          <h3 class="text-13-medium text-text-strong">{c().recallInspector}</h3>
          <p class="mt-1 max-w-3xl text-11-regular leading-relaxed text-text-weak">{c().recallInspectorHelp}</p>
        </header>
        <div class="grid items-end gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
          <TextField
            label={c().recallQuery}
            value={state.recallQuery}
            onChange={(value) => setState("recallQuery", value)}
          />
          <Button
            size="small"
            variant="secondary"
            disabled={state.loading || !state.recallQuery.trim()}
            onClick={() => void inspectRecall()}
          >
            {state.loading ? c().running : c().inspectRecall}
          </Button>
        </div>
        <Show
          when={state.recallResult}
          fallback={
            <p class="text-11-regular text-text-weak">{state.recallExecuted ? c().recallNoHits : c().recallNotRun}</p>
          }
        >
          {(result) => (
            <div class="grid gap-3" data-testid="memory-recall-result">
              <section aria-label={c().recallPipeline} class="grid gap-2 sm:grid-cols-2">
                <RecallStep label={c().recallNormalize} value={state.recallQuery.trim()} />
                <RecallStep label={c().recallScope} value={`${c().recallLocal}: ${result().localOnly ? "✓" : "—"}`} />
                <RecallStep label={c().recallRank} value={`${c().recallAlgorithm}: ${result().algorithm}`} />
                <RecallStep label={c().recallSelect} value={`${c().recallCandidates}: ${result().count}`} />
              </section>
              <p class="rounded-md bg-background-weak p-3 text-11-regular leading-relaxed text-text-weak">
                {c().recallEvidenceCaveat}
              </p>
              <Show
                when={result().items.length > 0}
                fallback={<p class="text-11-regular text-text-weak">{c().recallNoHits}</p>}
              >
                <ol class="grid gap-2">
                  <For each={result().items}>
                    {(hit, index) => (
                      <li class="grid gap-2 rounded-md bg-background-weak p-3" data-memory-id={hit.memory.id}>
                        <div class="flex flex-wrap items-start justify-between gap-2">
                          <div class="min-w-0">
                            <div class="text-11-medium text-text-strong">
                              #{index() + 1} · <code class="break-all">{hit.memory.id}</code>
                            </div>
                            <p class="mt-1 text-11-regular leading-relaxed text-text-strong">{hit.memory.content}</p>
                          </div>
                          <span class="rounded-full border border-border-weak-base px-2 py-1 text-10-medium text-text-strong">
                            {c().recallScore}: {hit.score.toFixed(3)}
                          </span>
                        </div>
                        <dl class="grid gap-x-4 gap-y-2 text-10-regular sm:grid-cols-3">
                          <RecallFact label={c().recallLexical} value={hit.lexicalScore.toFixed(3)} />
                          <RecallFact label={c().recallVector} value={hit.vectorScore.toFixed(3)} />
                          <RecallFact
                            label={c().recallTerms}
                            value={hit.matchedTerms.length ? [...new Set(hit.matchedTerms)].join(", ") : "—"}
                          />
                          <RecallFact
                            label={c().recallSource}
                            value={`${sourceLabel(hit.memory.source)} / ${hit.memory.scope}`}
                          />
                        </dl>
                      </li>
                    )}
                  </For>
                </ol>
              </Show>
            </div>
          )}
        </Show>
      </article>
      <article
        class="flex flex-col gap-3 rounded-md border border-border-weak-base p-3"
        data-testid="memory-conflict-governance"
      >
        <header class="flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0">
            <h3 class="text-13-medium text-text-strong">{c().conflictGovernance}</h3>
            <p class="mt-1 max-w-3xl text-11-regular text-text-weak">{c().conflictHelp}</p>
          </div>
          <div class="flex shrink-0 flex-wrap gap-2">
            <Button size="small" variant="secondary" disabled={state.loading} onClick={() => void scanConflicts()}>
              {state.loading ? c().running : c().scanConflicts}
            </Button>
            <Button size="small" variant="ghost" disabled={state.loading} onClick={() => void toggleConflictHistory()}>
              {state.showConflictHistory ? c().conflictOpenOnly : c().conflictHistory}
            </Button>
          </div>
        </header>
        <Show when={state.conflictScanNotice}>
          <p role="status" aria-live="polite" class="text-11-regular text-text-weak">
            {state.conflictScanNotice}
          </p>
        </Show>
        <Show
          when={(state.conflicts?.items.length ?? 0) > 0}
          fallback={<p class="text-11-regular text-text-weak">{c().noConflicts}</p>}
        >
          <div class="flex flex-col gap-3">
            <For each={state.conflicts?.items ?? []}>
              {(item) => {
                const titleID = `memory-conflict-${item.conflict.id}`
                const canReview = () => item.conflict.status === "pending" || item.conflict.status === "undone"
                return (
                  <section
                    class="flex flex-col gap-3 rounded-md bg-background-weak p-3"
                    aria-labelledby={titleID}
                    data-conflict-id={item.conflict.id}
                    data-conflict-status={item.conflict.status}
                  >
                    <div class="flex flex-wrap items-start justify-between gap-2">
                      <div class="min-w-0">
                        <h4 id={titleID} class="text-12-medium text-text-strong">
                          {c().conflictKey}: {item.conflict.conflictKey}
                        </h4>
                        <p class="mt-1 text-10-regular text-text-weak">
                          {conflictBasisLabel(item.conflict.basis)} · {conflictStatusLabel(item.conflict.status)} ·{" "}
                          {item.conflict.id}
                        </p>
                      </div>
                      <Show when={canReview() && state.reviewingConflictID !== item.conflict.id}>
                        <Button
                          size="small"
                          variant="secondary"
                          disabled={state.loading}
                          onClick={() => beginConflictReview(item.conflict.id)}
                        >
                          {c().reviewConflict}
                        </Button>
                      </Show>
                      <Show when={item.conflict.status === "resolved"}>
                        <Button
                          size="small"
                          variant="ghost"
                          disabled={state.loading}
                          onClick={() => undoConflict(item)}
                        >
                          {c().undo}
                        </Button>
                      </Show>
                    </div>
                    <div class="grid gap-3 md:grid-cols-2">
                      <ConflictMemory
                        side="left"
                        item={item.left}
                        source={sourceLabel(item.left.source)}
                        disposition={
                          conflictDisposition(item.conflict, item.left.id) === "chosen"
                            ? c().chosenMemory
                            : conflictDisposition(item.conflict, item.left.id) === "retired"
                              ? c().retiredMemory
                              : undefined
                        }
                      />
                      <ConflictMemory
                        side="right"
                        item={item.right}
                        source={sourceLabel(item.right.source)}
                        disposition={
                          conflictDisposition(item.conflict, item.right.id) === "chosen"
                            ? c().chosenMemory
                            : conflictDisposition(item.conflict, item.right.id) === "retired"
                              ? c().retiredMemory
                              : undefined
                        }
                      />
                    </div>
                    <Show when={item.conflict.decisionReason}>
                      {(reason) => <p class="text-11-regular text-text-weak">{reason()}</p>}
                    </Show>
                    <Show when={canReview() && state.reviewingConflictID === item.conflict.id}>
                      <div class="flex flex-col gap-3 rounded-md border border-border-weak-base bg-background-base p-3">
                        <TextField
                          label={c().decisionReason}
                          value={state.conflictReason}
                          onChange={(value) => setState("conflictReason", value)}
                        />
                        <div class="flex flex-wrap justify-end gap-2">
                          <Button size="small" variant="ghost" disabled={state.loading} onClick={cancelConflictReview}>
                            {c().cancel}
                          </Button>
                          <Button
                            size="small"
                            variant="ghost"
                            disabled={state.loading || !state.conflictReason.trim()}
                            onClick={() => dismissConflict(item)}
                          >
                            {c().dismissConflict}
                          </Button>
                          <Button
                            size="small"
                            variant="secondary"
                            disabled={state.loading || !state.conflictReason.trim()}
                            onClick={() => resolveConflict(item, item.left.id)}
                          >
                            {c().keepLeft}
                          </Button>
                          <Button
                            size="small"
                            variant="secondary"
                            disabled={state.loading || !state.conflictReason.trim()}
                            onClick={() => resolveConflict(item, item.right.id)}
                          >
                            {c().keepRight}
                          </Button>
                        </div>
                      </div>
                    </Show>
                  </section>
                )
              }}
            </For>
          </div>
        </Show>
      </article>
      <article class="flex flex-col gap-3 rounded-md border border-border-weak-base p-3">
        <div class="flex flex-wrap items-center gap-2">
          <Button size="small" variant="secondary" disabled={state.loading} onClick={() => void preview()}>
            {c().preview}
          </Button>
          <Show when={state.governance}>
            {(value) => (
              <>
                <span class="text-11-regular text-text-weak">
                  {value().candidateCount}/{value().scanned}
                </span>
                <Button
                  size="small"
                  variant="primary"
                  disabled={state.loading || value().candidateCount === 0}
                  onClick={apply}
                >
                  {c().apply}
                </Button>
              </>
            )}
          </Show>
        </div>
        <Show when={state.governance}>
          {(value) => (
            <div class="flex max-h-64 flex-col gap-2 overflow-auto">
              <For each={value().candidates}>
                {(item) => (
                  <div class="rounded-md bg-background-weak p-3 text-11-regular">
                    <div class="text-text-strong">{item.contentPreview}</div>
                    <div class="mt-1 text-text-weak">
                      {item.reason} · {item.source} · {item.id}
                    </div>
                  </div>
                )}
              </For>
            </div>
          )}
        </Show>
        <h3 class="text-13-medium text-text-strong">{c().recentMemories}</h3>
        <For each={state.memory?.recent ?? []}>
          {(item) => (
            <div class="flex flex-col gap-3 rounded-md bg-background-weak p-3" data-memory-id={item.id}>
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <div class="text-11-regular text-text-strong">{item.content}</div>
                  <div class="mt-1 text-10-regular text-text-weak">
                    {sourceLabel(item.source)} · {item.type} · {item.id}
                  </div>
                </div>
                <div class="flex shrink-0 flex-wrap justify-end gap-1">
                  <Button
                    size="small"
                    variant="ghost"
                    disabled={state.loading}
                    onClick={() => void loadCorrectionHistory(item.id)}
                  >
                    {c().history}
                  </Button>
                  <Show
                    when={!item.source.startsWith("quarantined")}
                    fallback={
                      <Button
                        size="small"
                        variant="ghost"
                        disabled={item.source === "quarantined" || state.loading}
                        onClick={() => restore(item)}
                      >
                        {c().restore}
                      </Button>
                    }
                  >
                    <Button
                      size="small"
                      variant="secondary"
                      disabled={state.loading}
                      onClick={() => beginCorrection(item)}
                    >
                      {c().correctMemory}
                    </Button>
                  </Show>
                </div>
              </div>
              <Show when={state.correctingID === item.id}>
                <div class="flex flex-col gap-2 rounded-md border border-border-weak-base bg-background-base p-3">
                  <textarea
                    class="min-h-20 rounded-md border border-border-weak-base bg-background-base p-3 text-12-regular"
                    aria-label={c().content}
                    value={state.correctionContent}
                    onInput={(event) => setState("correctionContent", event.currentTarget.value)}
                  />
                  <TextField
                    label={c().correctionReason}
                    value={state.correctionReason}
                    onChange={(value) => setState("correctionReason", value)}
                  />
                  <div class="flex justify-end gap-2">
                    <Button size="small" variant="ghost" onClick={cancelCorrection}>
                      {c().cancel}
                    </Button>
                    <Button
                      size="small"
                      variant="primary"
                      disabled={
                        state.loading ||
                        !state.correctionContent.trim() ||
                        !state.correctionReason.trim() ||
                        state.correctionContent.trim() === item.content
                      }
                      onClick={saveCorrection}
                    >
                      {c().saveCorrection}
                    </Button>
                  </div>
                </div>
              </Show>
              <Show when={state.historyMemoryID === item.id && state.correctionHistory}>
                <div class="flex flex-col gap-2 rounded-md border border-border-weak-base bg-background-base p-3">
                  <Show when={(state.correctionHistory?.count ?? 0) > 0} fallback={<p>{c().noData}</p>}>
                    <For each={state.correctionHistory?.items ?? []}>
                      {(correction) => (
                        <div class="flex items-start justify-between gap-3 text-11-regular">
                          <div class="min-w-0">
                            <div class="text-text-strong">{correction.reason}</div>
                            <div class="mt-1 text-text-weak">
                              {correctionStatusLabel(correction.status)} · {correction.id}
                            </div>
                          </div>
                          <Button
                            size="small"
                            variant="ghost"
                            disabled={state.loading || correction.status !== "active"}
                            onClick={() => undoCorrection(correction.id, correction.successorMemoryID)}
                          >
                            {c().undo}
                          </Button>
                        </div>
                      )}
                    </For>
                  </Show>
                </div>
              </Show>
            </div>
          )}
        </For>
      </article>
      <article class="flex flex-col gap-3 rounded-md border border-border-weak-base p-3">
        <h3 class="text-13-medium text-text-strong">{c().learning}</h3>
        <div class="grid gap-3 md:grid-cols-3">
          <Metric label={c().turns} value={state.learning?.totalTurns ?? "—"} />
          <Metric
            label={c().successRate}
            value={state.learning ? `${Math.round(state.learning.successRate * 100)}%` : "—"}
          />
          <Metric label={c().patterns} value={state.learning?.patternCount ?? "—"} />
        </div>
        <Show when={state.learning?.impact.caveat}>
          <p class="text-11-regular text-text-weak">{c().learningCaveat}</p>
        </Show>
        <For each={state.learning?.recent ?? []}>
          {(item) => (
            <div class="flex items-start justify-between gap-3 rounded-md bg-background-weak p-3">
              <div class="min-w-0 text-11-regular">
                <div class="text-text-strong">{item.userInput}</div>
                <div class="mt-1 text-text-weak">
                  {item.success ? "success" : item.errorType || "failed"} · {item.route}
                </div>
              </div>
              <Button size="small" variant="ghost" onClick={() => undo(item.id)}>
                {c().undo}
              </Button>
            </div>
          )}
        </For>
      </article>
      <article class="flex flex-col gap-3 rounded-md border border-border-weak-base p-3">
        <h3 class="text-13-medium text-text-strong">{c().feedback}</h3>
        <div class="grid gap-3 md:grid-cols-2">
          <Metric label={c().total} value={state.feedbackSummary?.total ?? "—"} />
          <Metric label={c().average} value={state.feedbackSummary?.averageRating?.toFixed(1) ?? "—"} />
        </div>
        <For each={state.feedback?.items ?? []}>
          {(item) => (
            <div class="flex items-start justify-between gap-3 rounded-md bg-background-weak p-3">
              <div class="min-w-0 text-11-regular">
                <div class="text-text-strong">{item.message}</div>
                <div class="mt-1 text-text-weak">
                  {item.category} · {item.rating}/5
                </div>
              </div>
              <Button size="small" variant="ghost" onClick={() => removeFeedback(item.id)}>
                {c().delete}
              </Button>
            </div>
          )}
        </For>
      </article>
    </section>
  )
}

function Metric(props: { label: string; value: string | number }) {
  return (
    <div class="rounded-md bg-background-weak p-3">
      <div class="text-10-regular text-text-weak">{props.label}</div>
      <div class="mt-1 text-16-medium text-text-strong">{props.value}</div>
    </div>
  )
}

function FusionContribution(props: {
  title: string
  runtime: string
  status: string
  bytes: number
  digest: string
  detail?: string
  degraded: boolean
}) {
  return (
    <section
      class="grid min-w-0 gap-2 rounded-md border p-3"
      classList={{
        "border-border-danger": props.degraded,
        "border-border-weak-base": !props.degraded,
      }}
    >
      <div class="flex flex-wrap items-start justify-between gap-2">
        <h4 class="text-11-medium text-text-strong">{props.title}</h4>
        <span
          class="text-10-medium"
          classList={{ "text-text-danger": props.degraded, "text-text-weak": !props.degraded }}
        >
          {props.status}
        </span>
      </div>
      <code class="break-all text-10-regular text-text-strong">{props.runtime}</code>
      <p class="text-10-regular text-text-weak">
        {props.bytes} bytes{props.detail ? ` · ${props.detail}` : ""}
      </p>
      <code class="break-all text-10-regular text-text-weak">{props.digest}</code>
    </section>
  )
}

function RecallStep(props: { label: string; value: string }) {
  return (
    <div class="min-w-0 rounded-md bg-background-weak p-3">
      <div class="text-10-medium text-text-strong">{props.label}</div>
      <div class="mt-1 break-words text-10-regular text-text-weak">{props.value}</div>
    </div>
  )
}

function RecallFact(props: { label: string; value: string }) {
  return (
    <div class="min-w-0">
      <dt class="text-text-weak">{props.label}</dt>
      <dd class="mt-1 break-words text-text-strong">{props.value}</dd>
    </div>
  )
}

function ConflictMemory(props: {
  side: "left" | "right"
  item: { readonly id: string; readonly content: string; readonly type: string }
  source: string
  disposition?: string
}) {
  return (
    <div
      class="min-w-0 rounded-md border border-border-weak-base bg-background-base p-3"
      data-conflict-side={props.side}
      data-memory-id={props.item.id}
    >
      <div class="whitespace-pre-wrap text-12-regular text-text-strong">{props.item.content}</div>
      <div class="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-10-regular text-text-weak">
        <span>{props.source}</span>
        <span aria-hidden="true">·</span>
        <span>{props.item.type}</span>
        <Show when={props.disposition}>
          {(value) => (
            <>
              <span aria-hidden="true">·</span>
              <span class="text-text-strong">{value()}</span>
            </>
          )}
        </Show>
      </div>
    </div>
  )
}

export const capabilityWorkbenchLocales: readonly Locale[] = [
  "en",
  "zh",
  "zht",
  "ko",
  "de",
  "es",
  "fr",
  "da",
  "ja",
  "pl",
  "ru",
  "uk",
  "ar",
  "no",
  "br",
  "th",
  "bs",
  "tr",
]
