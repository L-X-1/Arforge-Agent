import { useLanguage } from "@/context/language"
import type { OperationsApi } from "@/utils/server"
import { createScopeRequestGuard, type ScopeRequestToken } from "@/utils/scope-request"
import { Button } from "@arforge-ai/ui/button"
import { useDialog } from "@arforge-ai/ui/context/dialog"
import { useNavigate } from "@solidjs/router"
import { For, Show, createEffect, on } from "solid-js"
import { createStore } from "solid-js/store"
import {
  evolutionActionRequiresReason,
  evolutionActions,
  evolutionEvidenceRefs,
  evolutionRefreshError,
  type EvolutionAction,
} from "./evolution-model"

type LocationInput = { location: { directory: string; workspace?: string } }
type Candidate = Awaited<ReturnType<OperationsApi["agentCapabilities"]["evolutionCandidates"]>>["data"]["items"][number]

const copy = {
  en: {
    title: "Governed Evolution",
    description:
      "Profile-wide, experience-derived strategies remain bounded advice. Evaluation, explicit approval, canary evidence, and rollback are mandatory before broad activation.",
    refresh: "Refresh",
    create: "Create candidate",
    titleField: "Candidate title",
    target: "Strategy target",
    instruction: "Bounded instruction",
    rationale: "Why this change should help",
    evidence: "Evidence references (one per line)",
    candidates: "Candidates",
    opportunities: "Evidence opportunities",
    actualRecall: "Actual memory recall",
    recalls: "Measured samples",
    useful: "Top-1 hit rate",
    feedback: "Mean reciprocal rank",
    stale: "No-result rate",
    conflicts: "Evidence status",
    exposureAudit: "Experiment exposure audit",
    exposureDescription:
      "Every real model turn is bound to its preparation-time candidate or control assignment. Session keys stay private; only their digest is shown.",
    exposureFilter: "Exposure status",
    exposureAll: "All exposures",
    exposurePending: "Pending outcome",
    exposureRecorded: "Outcome recorded",
    exposureTotal: "Total exposures",
    noExposures: "No governed model turns match this filter yet.",
    exposureID: "Exposure ID",
    createdAt: "Prepared",
    cohortDigest: "Private cohort-key digest",
    contextDigest: "Injected-context digest",
    ticketDigest: "Ticket digest",
    receiptDigest: "Receipt digest",
    executionSource: "Verified execution source",
    sourceDescription: "Core verified these durable IDs before the model turn. Message content is not copied here.",
    sourceSession: "Session",
    sourceUserMessage: "User message",
    sourceAssistantMessage: "Assistant message",
    sourceStep: "Turn step",
    openSourceSession: "Open source Session",
    legacySource: "Legacy exposure: no authoritative Session source was retained.",
    assignments: "Preparation-time assignments",
    injected: "Strategy text injected",
    candidateCohort: "Candidate",
    controlCohort: "Control",
    observations: "Recorded observations",
    outcome: "Terminal outcome",
    success: "Succeeded",
    failure: "Failed",
    safetyIncident: "Safety incident reported",
    noSafetyIncident: "No safety incident",
    awaitingOutcome: "The model turn has been prepared but no terminal receipt has arrived yet.",
    legacyOutcome: "Legacy receipt: terminal metadata was not retained, but attribution and count remain verified.",
    archiveRetention: "Recoverable exposure retention",
    archiveDescription:
      "Preview the exact recorded exposures to archive. Pending turns are never removed; evidence is copied, verified, and journaled before active records are deleted.",
    keepRecorded: "Keep newest recorded exposures",
    previewArchive: "Preview archive plan",
    applyArchive: "Archive reviewed records…",
    archiveReason: "Why these records may be archived",
    archiveReasonRequired: "Enter a reason before applying the archive plan.",
    archiveEligible: "Eligible to archive",
    archiveRetained: "Recorded retained",
    archivePlanDigest: "Plan digest",
    archiveNoop: "No recorded exposures currently need archiving.",
    archiveApplied: "The reviewed exposure archive completed and its evidence journal was verified.",
    confirmArchive:
      "Archive the exact reviewed records? This removes them from the active list after verified evidence publication.",
    archiveLibrary: "Verified archive library",
    archiveLibraryDescription:
      "Browse immutable evidence without exposing raw cohort keys. Integrity is rechecked before details, export, or restore are allowed.",
    archiveCount: "Archives",
    invalidArchives: "Invalid archives",
    noArchives: "No exposure archives have been published yet.",
    integrityValid: "Integrity verified",
    integrityInvalid: "Integrity failed",
    archivedRecords: "Archived records",
    publishedAt: "Published",
    completedAt: "Completed",
    missingLive: "Missing from active evidence",
    alreadyLive: "Already active",
    conflictLive: "Conflicting active evidence",
    selectArchive: "Select an archive to inspect its verified evidence and recovery readiness.",
    archiveDetails: "Archive details",
    evidenceItems: "Privacy-safe evidence index",
    restorePreview: "Preview restore",
    restoreRecords: "Restore verified records…",
    restoreReason: "Why these archived records should be restored",
    restoreReasonRequired: "Enter a reason before restoring archived evidence.",
    restoreApplied: "Verified archived evidence was restored without modifying the immutable archive.",
    confirmRestore: "Restore the exact reviewed evidence into the active audit store?",
    restoreBlockedConflict: "Restore is blocked because active files conflict with archived evidence.",
    restoreBlockedCapacity: "Restore is blocked because it would exceed the active exposure capacity.",
    restoreNoop: "Every archived record is already present and byte-identical in the active audit store.",
    archiveExport: "Export sanitized audit JSON",
    archiveExported: "The privacy-safe audit JSON was exported and its digest was verified by the runtime.",
    sanitizedExport: "Raw tickets, cohort keys, and private filesystem paths are excluded from this export.",
    executionTimeline: "Real execution timeline",
    timelineDescription:
      "Persistent, hash-chained runtime events show what actually happened. Temporary UI loading indicators are not treated as execution evidence.",
    chainValid: "Audit chain verified",
    noEvents: "No governed evolution events have been recorded yet.",
    eventActor: "Actor",
    eventSubject: "Subject",
    eventReason: "Reason",
    eventMetadata: "Verified metadata and hashes",
    auditActions: {
      candidate_created: "Candidate created",
      candidate_evaluated: "Candidate evaluated",
      candidate_approved: "Candidate approved",
      candidate_rejected: "Candidate rejected",
      canary_started: "Canary started",
      candidate_promoted: "Candidate promoted",
      candidate_rolled_back: "Candidate rolled back",
      exposure_prepared: "Model turn prepared",
      exposure_outcome_recorded: "Terminal outcome recorded",
      exposure_archive_noop: "Archive not required",
      exposure_archive_plan_accepted: "Archive plan accepted",
      exposure_archive_published: "Verified evidence published",
      exposure_archive_failed: "Archive failed",
      exposure_archive_completed: "Archive completed",
      exposure_archive_recovery_completed: "Interrupted archive recovered",
      exposure_restore_plan_accepted: "Restore plan accepted",
      exposure_restore_completed: "Archive evidence restored",
      exposure_restore_recovery_completed: "Interrupted restore recovered",
      exposure_restore_noop: "Restore not required",
      exposure_restore_failed: "Restore failed",
    },
    noData: "No candidates yet. Create one from reviewed evidence.",
    audit: "Audit integrity",
    constitution: "Constitution Kernel",
    autoProposal: "Automatic proposal threshold",
    proposer: "Proposed by",
    proposerCore: "Automatic proposal from desktop learning",
    proposerLegacy: "Automatic proposal from legacy learning",
    proposerUser: "Created by the user",
    statuses: {
      proposed: "Awaiting review",
      evaluated: "Evaluated",
      approved: "Approved",
      rejected: "Rejected",
      canary: "Canary active",
      promoted: "Promoted",
      rolled_back: "Rolled back",
    },
    protected: "Source code, permissions, privacy, security, identity, and the Constitution cannot evolve here.",
    evaluate: "Evaluate",
    approve: "Approve…",
    reject: "Reject…",
    canary: "Start canary…",
    promote: "Promote…",
    rollback: "Rollback…",
    report: "Canary report",
    reason: "Decision reason",
    traffic: "Canary traffic (%)",
    gatePassed: "Gate passed",
    gateBlocked: "Gate blocked",
    running: "Working…",
    preview: "Context preview",
    previewTask: "Representative task",
    cohort: "Stable cohort key",
    previewButton: "Preview injection",
    propose: "Create from pattern",
    syntheticWarning: "These metrics come from real retrieval events, not the synthetic self-recall smoke test.",
    unavailable:
      "Governed Evolution APIs are not available in this running server. Restart Arforge after updating so the desktop and server use the same version.",
  },
  zh: {
    title: "受控自主进化",
    description:
      "跨工作区的用户级经验策略始终只是受限建议；广泛启用前必须依次经过隔离评测、人工批准、灰度证据和可回滚门禁。",
    refresh: "刷新",
    create: "创建候选",
    titleField: "候选标题",
    target: "策略目标",
    instruction: "受限策略指令",
    rationale: "为什么这项改进可能有效",
    evidence: "证据引用（每行一条）",
    candidates: "进化候选",
    opportunities: "证据机会",
    actualRecall: "真实记忆召回",
    recalls: "已测样本数",
    useful: "首位命中率",
    feedback: "平均倒数排名",
    stale: "无结果率",
    conflicts: "证据状态",
    exposureAudit: "实验曝光审计",
    exposureDescription: "每次真实模型调用都绑定到准备时的候选组或对照组；会话键保持私密，桌面端只显示其摘要。",
    exposureFilter: "曝光状态",
    exposureAll: "全部曝光",
    exposurePending: "等待结果",
    exposureRecorded: "结果已记录",
    exposureTotal: "曝光总数",
    noExposures: "当前筛选条件下暂无受控模型调用。",
    exposureID: "曝光 ID",
    createdAt: "准备时间",
    cohortDigest: "私密分组键摘要",
    contextDigest: "注入上下文摘要",
    ticketDigest: "票据摘要",
    receiptDigest: "回执摘要",
    executionSource: "已验证执行来源",
    sourceDescription: "Core 在模型调用前验证了这些持久 ID；这里不会复制消息正文。",
    sourceSession: "会话",
    sourceUserMessage: "用户消息",
    sourceAssistantMessage: "助手消息",
    sourceStep: "调用步骤",
    openSourceSession: "打开来源会话",
    legacySource: "旧版曝光：当时未保留权威会话来源。",
    assignments: "准备时分组",
    injected: "已注入策略文本",
    candidateCohort: "候选组",
    controlCohort: "对照组",
    observations: "已记录观测",
    outcome: "终态结果",
    success: "成功",
    failure: "失败",
    safetyIncident: "已报告安全事件",
    noSafetyIncident: "无安全事件",
    awaitingOutcome: "模型调用已完成准备，但尚未收到终态回执。",
    legacyOutcome: "旧版回执未保留终态元数据，但归因关系和观测数量仍已验证。",
    archiveRetention: "可恢复曝光保留策略",
    archiveDescription:
      "先预览将被归档的确切已记录曝光。等待结果的调用永不删除；活动记录只会在证据复制、校验和日志落盘后移除。",
    keepRecorded: "保留最新已记录曝光数",
    previewArchive: "预览归档计划",
    applyArchive: "归档已审查记录…",
    archiveReason: "归档这些记录的理由",
    archiveReasonRequired: "执行归档计划前必须填写理由。",
    archiveEligible: "可归档数量",
    archiveRetained: "保留已记录数量",
    archivePlanDigest: "计划摘要",
    archiveNoop: "当前没有需要归档的已记录曝光。",
    archiveApplied: "已完成审查过的曝光归档，并验证了证据日志。",
    confirmArchive: "归档已审查的确切记录？验证证据发布后，它们将从活动列表移除。",
    archiveLibrary: "已验证归档库",
    archiveLibraryDescription: "浏览不可变证据且不暴露原始分组键；查看详情、导出或恢复前都会重新校验完整性。",
    archiveCount: "归档数量",
    invalidArchives: "无效归档",
    noArchives: "尚未发布曝光归档。",
    integrityValid: "完整性已验证",
    integrityInvalid: "完整性验证失败",
    archivedRecords: "已归档记录",
    publishedAt: "发布时间",
    completedAt: "完成时间",
    missingLive: "活动证据中缺失",
    alreadyLive: "已在活动证据中",
    conflictLive: "活动证据冲突",
    selectArchive: "请选择一个归档，检查已验证证据和恢复条件。",
    archiveDetails: "归档详情",
    evidenceItems: "隐私安全证据索引",
    restorePreview: "预览恢复计划",
    restoreRecords: "恢复已验证记录…",
    restoreReason: "为什么需要恢复这些归档记录",
    restoreReasonRequired: "恢复归档证据前必须填写理由。",
    restoreApplied: "已恢复经过验证的归档证据，且未修改不可变归档。",
    confirmRestore: "将已审查的确切证据恢复到活动审计存储？",
    restoreBlockedConflict: "活动文件与归档证据冲突，恢复已被阻止。",
    restoreBlockedCapacity: "恢复后将超过活动曝光容量，操作已被阻止。",
    restoreNoop: "所有归档记录已存在于活动审计存储中，且字节完全一致。",
    archiveExport: "导出脱敏审计 JSON",
    archiveExported: "已导出隐私安全审计 JSON，运行时已验证其摘要。",
    sanitizedExport: "导出内容不包含原始票据、分组键或私有文件系统路径。",
    executionTimeline: "真实执行时间线",
    timelineDescription: "持久化、哈希链接的运行时事件展示真正发生的操作；临时界面加载状态不算执行证据。",
    chainValid: "审计链已验证",
    noEvents: "尚未记录受控进化事件。",
    eventActor: "执行者",
    eventSubject: "对象",
    eventReason: "理由",
    eventMetadata: "已验证元数据与哈希",
    auditActions: {
      candidate_created: "已创建候选",
      candidate_evaluated: "已完成候选评测",
      candidate_approved: "已人工批准候选",
      candidate_rejected: "已拒绝候选",
      canary_started: "已开始灰度",
      candidate_promoted: "已全量晋级候选",
      candidate_rolled_back: "已回滚候选",
      exposure_prepared: "模型调用已准备",
      exposure_outcome_recorded: "终态结果已记录",
      exposure_archive_noop: "无需归档",
      exposure_archive_plan_accepted: "已接受归档计划",
      exposure_archive_published: "已发布并验证归档证据",
      exposure_archive_failed: "归档失败",
      exposure_archive_completed: "归档已完成",
      exposure_archive_recovery_completed: "已恢复中断的归档",
      exposure_restore_plan_accepted: "已接受恢复计划",
      exposure_restore_completed: "已恢复归档证据",
      exposure_restore_recovery_completed: "已恢复中断的恢复任务",
      exposure_restore_noop: "无需恢复",
      exposure_restore_failed: "恢复失败",
    },
    noData: "暂无候选。请从经过审查的证据创建候选。",
    audit: "审计完整性",
    constitution: "宪法内核",
    autoProposal: "自动提议阈值",
    proposer: "提议来源",
    proposerCore: "桌面学习系统自动提议",
    proposerLegacy: "原有学习系统自动提议",
    proposerUser: "用户手动创建",
    statuses: {
      proposed: "等待审查",
      evaluated: "已完成评测",
      approved: "已人工批准",
      rejected: "已拒绝",
      canary: "灰度运行中",
      promoted: "已全量晋级",
      rolled_back: "已回滚",
    },
    protected: "源代码、权限、隐私、安全、身份和宪法规则不能在这里自行进化。",
    evaluate: "隔离评测",
    approve: "人工批准…",
    reject: "拒绝…",
    canary: "开始灰度…",
    promote: "全量晋级…",
    rollback: "回滚…",
    report: "灰度报告",
    reason: "决策理由",
    traffic: "灰度流量（%）",
    gatePassed: "门禁通过",
    gateBlocked: "门禁未通过",
    running: "处理中…",
    preview: "上下文注入预览",
    previewTask: "代表性任务",
    cohort: "稳定分组键",
    previewButton: "预览注入",
    propose: "从模式创建",
    syntheticWarning: "这些指标来自真实检索事件，不是旧版的自召回冒烟测试。",
    unavailable: "当前运行的服务端尚未提供受控进化接口。更新后请重启 Arforge，使桌面端与服务端版本一致。",
  },
  zht: {
    title: "受控自主進化",
    description:
      "跨工作區的使用者級經驗策略始終只是受限建議；廣泛啟用前必須依次經過隔離評測、人工批准、灰度證據和可回滾門禁。",
    refresh: "重新整理",
    create: "建立候選",
    titleField: "候選標題",
    target: "策略目標",
    instruction: "受限策略指令",
    rationale: "為什麼這項改進可能有效",
    evidence: "證據引用（每行一條）",
    candidates: "進化候選",
    opportunities: "證據機會",
    actualRecall: "真實記憶召回",
    recalls: "已測樣本數",
    useful: "首位命中率",
    feedback: "平均倒數排名",
    stale: "無結果率",
    conflicts: "證據狀態",
    exposureAudit: "實驗曝光審計",
    exposureDescription: "每次真實模型呼叫都綁定到準備時的候選組或對照組；工作階段鍵保持私密，桌面端只顯示其摘要。",
    exposureFilter: "曝光狀態",
    exposureAll: "全部曝光",
    exposurePending: "等待結果",
    exposureRecorded: "結果已記錄",
    exposureTotal: "曝光總數",
    noExposures: "目前篩選條件下暫無受控模型呼叫。",
    exposureID: "曝光 ID",
    createdAt: "準備時間",
    cohortDigest: "私密分組鍵摘要",
    contextDigest: "注入內容摘要",
    ticketDigest: "票據摘要",
    receiptDigest: "回執摘要",
    executionSource: "已驗證執行來源",
    sourceDescription: "Core 在模型呼叫前驗證了這些持久 ID；這裡不會複製訊息正文。",
    sourceSession: "Session",
    sourceUserMessage: "使用者訊息",
    sourceAssistantMessage: "助理訊息",
    sourceStep: "呼叫步驟",
    openSourceSession: "開啟來源 Session",
    legacySource: "舊版曝光：當時未保留權威 Session 來源。",
    assignments: "準備時分組",
    injected: "已注入策略文字",
    candidateCohort: "候選組",
    controlCohort: "對照組",
    observations: "已記錄觀測",
    outcome: "終態結果",
    success: "成功",
    failure: "失敗",
    safetyIncident: "已報告安全事件",
    noSafetyIncident: "無安全事件",
    awaitingOutcome: "模型呼叫已完成準備，但尚未收到終態回執。",
    legacyOutcome: "舊版回執未保留終態中繼資料，但歸因關係和觀測數量仍已驗證。",
    archiveRetention: "可恢復曝光保留策略",
    archiveDescription:
      "先預覽將被封存的確切已記錄曝光。等待結果的呼叫永不刪除；活動記錄只會在證據複製、校驗和日誌落盤後移除。",
    keepRecorded: "保留最新已記錄曝光數",
    previewArchive: "預覽封存計畫",
    applyArchive: "封存已審查記錄…",
    archiveReason: "封存這些記錄的理由",
    archiveReasonRequired: "執行封存計畫前必須填寫理由。",
    archiveEligible: "可封存數量",
    archiveRetained: "保留已記錄數量",
    archivePlanDigest: "計畫摘要",
    archiveNoop: "目前沒有需要封存的已記錄曝光。",
    archiveApplied: "已完成審查過的曝光封存，並驗證了證據日誌。",
    confirmArchive: "封存已審查的確切記錄？驗證證據發佈後，它們將從活動清單移除。",
    archiveLibrary: "已驗證封存庫",
    archiveLibraryDescription: "瀏覽不可變證據且不暴露原始分組鍵；查看詳情、匯出或恢復前都會重新校驗完整性。",
    archiveCount: "封存數量",
    invalidArchives: "無效封存",
    noArchives: "尚未發佈曝光封存。",
    integrityValid: "完整性已驗證",
    integrityInvalid: "完整性驗證失敗",
    archivedRecords: "已封存記錄",
    publishedAt: "發佈時間",
    completedAt: "完成時間",
    missingLive: "活動證據中缺失",
    alreadyLive: "已在活動證據中",
    conflictLive: "活動證據衝突",
    selectArchive: "請選擇一個封存，檢查已驗證證據和恢復條件。",
    archiveDetails: "封存詳情",
    evidenceItems: "隱私安全證據索引",
    restorePreview: "預覽恢復計畫",
    restoreRecords: "恢復已驗證記錄…",
    restoreReason: "為什麼需要恢復這些封存記錄",
    restoreReasonRequired: "恢復封存證據前必須填寫理由。",
    restoreApplied: "已恢復經過驗證的封存證據，且未修改不可變封存。",
    confirmRestore: "將已審查的確切證據恢復到活動審計儲存？",
    restoreBlockedConflict: "活動檔案與封存證據衝突，恢復已被阻止。",
    restoreBlockedCapacity: "恢復後將超過活動曝光容量，操作已被阻止。",
    restoreNoop: "所有封存記錄已存在於活動審計儲存中，且位元組完全一致。",
    archiveExport: "匯出脫敏審計 JSON",
    archiveExported: "已匯出隱私安全審計 JSON，執行時已驗證其摘要。",
    sanitizedExport: "匯出內容不包含原始票據、分組鍵或私有檔案系統路徑。",
    executionTimeline: "真實執行時間線",
    timelineDescription: "持久化、雜湊鏈接的執行時事件展示真正發生的操作；臨時介面載入狀態不算執行證據。",
    chainValid: "審計鏈已驗證",
    noEvents: "尚未記錄受控進化事件。",
    eventActor: "執行者",
    eventSubject: "物件",
    eventReason: "理由",
    eventMetadata: "已驗證中繼資料與雜湊",
    auditActions: {
      candidate_created: "已建立候選",
      candidate_evaluated: "已完成候選評測",
      candidate_approved: "已人工批准候選",
      candidate_rejected: "已拒絕候選",
      canary_started: "已開始灰度",
      candidate_promoted: "已全量晉級候選",
      candidate_rolled_back: "已回滾候選",
      exposure_prepared: "模型呼叫已準備",
      exposure_outcome_recorded: "終態結果已記錄",
      exposure_archive_noop: "無需封存",
      exposure_archive_plan_accepted: "已接受封存計畫",
      exposure_archive_published: "已發佈並驗證封存證據",
      exposure_archive_failed: "封存失敗",
      exposure_archive_completed: "封存已完成",
      exposure_archive_recovery_completed: "已恢復中斷的封存",
      exposure_restore_plan_accepted: "已接受恢復計畫",
      exposure_restore_completed: "已恢復封存證據",
      exposure_restore_recovery_completed: "已恢復中斷的恢復任務",
      exposure_restore_noop: "無需恢復",
      exposure_restore_failed: "恢復失敗",
    },
    noData: "暫無候選。請從經過審查的證據建立候選。",
    audit: "審計完整性",
    constitution: "憲法內核",
    autoProposal: "自動提議門檻",
    proposer: "提議來源",
    proposerCore: "桌面學習系統自動提議",
    proposerLegacy: "原有學習系統自動提議",
    proposerUser: "使用者手動建立",
    statuses: {
      proposed: "等待審查",
      evaluated: "已完成評測",
      approved: "已人工批准",
      rejected: "已拒絕",
      canary: "灰度執行中",
      promoted: "已全量晉級",
      rolled_back: "已回滾",
    },
    protected: "原始碼、權限、隱私、安全、身份和憲法規則不能在這裡自行進化。",
    evaluate: "隔離評測",
    approve: "人工批准…",
    reject: "拒絕…",
    canary: "開始灰度…",
    promote: "全量晉級…",
    rollback: "回滾…",
    report: "灰度報告",
    reason: "決策理由",
    traffic: "灰度流量（%）",
    gatePassed: "門禁通過",
    gateBlocked: "門禁未通過",
    running: "處理中…",
    preview: "上下文注入預覽",
    previewTask: "代表性任務",
    cohort: "穩定分組鍵",
    previewButton: "預覽注入",
    propose: "從模式建立",
    syntheticWarning: "這些指標來自真實檢索事件，不是舊版的自召回冒煙測試。",
    unavailable: "目前執行中的服務端尚未提供受控進化介面。更新後請重新啟動 Arforge，使桌面端與服務端版本一致。",
  },
} as const

const percent = (value: number) => `${Math.round(value * 100)}%`
const digestLabel = (value: string) => (value.length > 24 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value)
const sha256Text = async (value: string) => {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}
const downloadText = (filename: string, mediaType: string, content: string) => {
  const url = URL.createObjectURL(new Blob([content], { type: mediaType }))
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  link.hidden = true
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}
export function EvolutionWorkbench(props: {
  api: () => OperationsApi
  location: () => LocationInput
  ready: () => boolean
}) {
  const language = useLanguage()
  const navigate = useNavigate()
  const dialog = useDialog()
  const c = () => copy[language.locale() as keyof typeof copy] ?? copy.en
  const openSourceSession = (sessionID: string) => {
    dialog.close()
    navigate(`/session/${encodeURIComponent(sessionID)}`)
  }
  const statusLabel = (status: Candidate["state"]["status"]) => c().statuses[status]
  const auditActionLabel = (action: string) =>
    c().auditActions[action as keyof (typeof copy)["en"]["auditActions"]] ?? action.replaceAll("_", " ")
  const proposerLabel = (createdBy: string) => {
    const label = createdBy.startsWith("runtime:core-learning")
      ? c().proposerCore
      : createdBy.startsWith("runtime:legacy-learning") || createdBy.startsWith("runtime:pattern-miner")
        ? c().proposerLegacy
        : createdBy.startsWith("user:")
          ? c().proposerUser
          : createdBy
    return label === createdBy ? createdBy : `${label} · ${createdBy}`
  }
  type Status = Awaited<ReturnType<OperationsApi["agentCapabilities"]["evolutionStatus"]>>["data"]
  type Opportunity = Awaited<
    ReturnType<OperationsApi["agentCapabilities"]["evolutionOpportunities"]>
  >["data"]["items"][number]
  type Recall = Awaited<ReturnType<OperationsApi["memories"]["recallQuality"]>>
  type Canary = Awaited<ReturnType<OperationsApi["agentCapabilities"]["evolutionCanaryReport"]>>["data"]
  type ContextPreview = Awaited<ReturnType<OperationsApi["agentCapabilities"]["evolutionContextPreview"]>>["data"]
  type ExposureAudit = Awaited<ReturnType<OperationsApi["agentCapabilities"]["evolutionExposures"]>>["data"]
  type ExposureArchivePlan = Awaited<
    ReturnType<OperationsApi["agentCapabilities"]["evolutionExposureArchivePreview"]>
  >["data"]
  type ExposureArchiveCatalog = Awaited<
    ReturnType<OperationsApi["agentCapabilities"]["evolutionExposureArchives"]>
  >["data"]
  type ExposureArchiveDetail = Awaited<
    ReturnType<OperationsApi["agentCapabilities"]["evolutionExposureArchiveGet"]>
  >["data"]
  type ExposureRestorePlan = Awaited<
    ReturnType<OperationsApi["agentCapabilities"]["evolutionExposureRestorePreview"]>
  >["data"]
  type AuditTimeline = Awaited<ReturnType<OperationsApi["agentCapabilities"]["evolutionAuditEvents"]>>["data"]
  type ExposureFilter = "all" | "pending" | "recorded"
  const [state, setState] = createStore({
    loading: "",
    error: "",
    notice: "",
    status: undefined as Status | undefined,
    candidates: [] as Candidate[],
    opportunities: [] as Opportunity[],
    recall: undefined as Recall | undefined,
    exposures: undefined as ExposureAudit | undefined,
    auditTimeline: undefined as AuditTimeline | undefined,
    exposureFilter: "all" as ExposureFilter,
    archiveKeepRecorded: 1000,
    archivePlan: undefined as ExposureArchivePlan | undefined,
    archiveReason: "",
    archiveCatalog: undefined as ExposureArchiveCatalog | undefined,
    selectedArchiveID: "",
    archiveDetail: undefined as ExposureArchiveDetail | undefined,
    restorePlan: undefined as ExposureRestorePlan | undefined,
    restoreReason: "",
    canary: {} as Record<string, Canary>,
    reasons: {} as Record<string, string>,
    title: "",
    target: "learning.fix" as Candidate["target"],
    instruction: "",
    rationale: "",
    evidence: "",
    trafficPercent: 10,
    previewTask: "",
    cohortKey: "desktop-preview",
    contextPreview: undefined as ContextPreview | undefined,
  })

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
    setState({ loading: "refresh", error: "" })
    try {
      const results = await Promise.allSettled([
        props.api().agentCapabilities.evolutionStatus(requestedLocation),
        props.api().agentCapabilities.evolutionCandidates({ ...requestedLocation, limit: 100 }),
        props.api().agentCapabilities.evolutionOpportunities({ ...requestedLocation, limit: 50 }),
        props.api().memories.recallQuality(requestedLocation),
        props.api().agentCapabilities.evolutionExposures({
          ...requestedLocation,
          ...(state.exposureFilter === "all" ? {} : { status: state.exposureFilter }),
          limit: 100,
        }),
        props.api().agentCapabilities.evolutionAuditEvents({ ...requestedLocation, limit: 100 }),
        props.api().agentCapabilities.evolutionExposureArchives({ ...requestedLocation, limit: 100 }),
      ])
      if (!scopeGuard.isCurrent(request)) return
      const [status, candidates, opportunities, recall, exposures, auditTimeline, archiveCatalog] = results
      if (status.status === "fulfilled") {
        setState("status", status.value.data)
      }
      if (candidates.status === "fulfilled") setState("candidates", [...candidates.value.data.items])
      if (opportunities.status === "fulfilled") setState("opportunities", [...opportunities.value.data.items])
      if (recall.status === "fulfilled") setState("recall", recall.value)
      if (exposures.status === "fulfilled") setState("exposures", exposures.value.data)
      if (auditTimeline.status === "fulfilled") setState("auditTimeline", auditTimeline.value.data)
      if (archiveCatalog.status === "fulfilled") setState("archiveCatalog", archiveCatalog.value.data)
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected")
      if (failures.length)
        setState(
          "error",
          evolutionRefreshError(
            failures.map((failure) => failure.reason),
            c().unavailable,
          ),
        )
    } catch (error) {
      if (scopeGuard.isCurrent(request)) setState("error", evolutionRefreshError([error], c().unavailable))
    } finally {
      if (scopeGuard.isCurrent(request)) setState("loading", "")
    }
  }

  const filterExposures = (filter: ExposureFilter) => {
    setState("exposureFilter", filter)
    if (!props.ready() || state.loading) return
    void run(
      "exposures",
      async (location, request) => {
        const result = await props.api().agentCapabilities.evolutionExposures({
          ...location,
          ...(filter === "all" ? {} : { status: filter }),
          limit: 100,
        })
        if (scopeGuard.isCurrent(request)) setState("exposures", result.data)
      },
      "",
      false,
    )
  }

  const previewExposureArchive = () => {
    const keepRecorded = Math.trunc(state.archiveKeepRecorded)
    if (!Number.isFinite(keepRecorded) || keepRecorded < 0 || keepRecorded > 10_000) return
    void run(
      "archive-preview",
      async (location, request) => {
        const result = await props.api().agentCapabilities.evolutionExposureArchivePreview({
          ...location,
          keepRecorded,
        })
        if (scopeGuard.isCurrent(request)) setState("archivePlan", result.data)
      },
      "",
      false,
    )
  }

  const applyExposureArchive = () => {
    const plan = state.archivePlan
    if (!plan || plan.eligible_count === 0) return
    const reason = state.archiveReason.trim()
    if (!reason) {
      setState("error", c().archiveReasonRequired)
      return
    }
    if (
      !window.confirm(
        `${c().confirmArchive}\n\n${c().archiveEligible}: ${plan.eligible_count}\n${c().archivePlanDigest}: ${digestLabel(plan.plan_digest)}\n${c().eventReason}: ${reason}`,
      )
    )
      return
    void run(
      "archive-apply",
      async (location, request) => {
        await props.api().agentCapabilities.evolutionExposureArchiveApply({
          ...location,
          keepRecorded: plan.keep_recorded,
          expectedPlanDigest: plan.plan_digest,
          reason,
        })
        if (scopeGuard.isCurrent(request)) setState({ archivePlan: undefined, archiveReason: "" })
      },
      c().archiveApplied,
    )
  }

  const selectExposureArchive = (archiveID: string) =>
    void run(
      "archive-detail",
      async (location, request) => {
        const result = await props.api().agentCapabilities.evolutionExposureArchiveGet({
          ...location,
          archiveID,
          limit: 500,
        })
        if (scopeGuard.isCurrent(request)) {
          setState({
            selectedArchiveID: archiveID,
            archiveDetail: result.data,
            restorePlan: undefined,
            restoreReason: "",
          })
        }
      },
      "",
      false,
    )

  const previewExposureRestore = () => {
    const archiveID = state.selectedArchiveID
    if (!archiveID) return
    void run(
      "restore-preview",
      async (location, request) => {
        const result = await props.api().agentCapabilities.evolutionExposureRestorePreview({
          ...location,
          archiveID,
        })
        if (scopeGuard.isCurrent(request)) setState("restorePlan", result.data)
      },
      "",
      false,
    )
  }

  const applyExposureRestore = () => {
    const plan = state.restorePlan
    if (!plan || !plan.can_apply || plan.counts.missing === 0) return
    const reason = state.restoreReason.trim()
    if (!reason) {
      setState("error", c().restoreReasonRequired)
      return
    }
    if (
      !window.confirm(
        `${c().confirmRestore}\n\n${c().missingLive}: ${plan.counts.missing}\n${c().archivePlanDigest}: ${digestLabel(plan.plan_digest)}\n${c().eventReason}: ${reason}`,
      )
    )
      return
    void run(
      "restore-apply",
      async (location, request) => {
        await props.api().agentCapabilities.evolutionExposureRestoreApply({
          ...location,
          archiveID: plan.archive_id,
          expectedPlanDigest: plan.plan_digest,
          reason,
        })
        const detail = await props.api().agentCapabilities.evolutionExposureArchiveGet({
          ...location,
          archiveID: plan.archive_id,
          limit: 500,
        })
        if (scopeGuard.isCurrent(request))
          setState({ archiveDetail: detail.data, restorePlan: undefined, restoreReason: "" })
      },
      c().restoreApplied,
    )
  }

  const exportExposureArchive = () => {
    const archiveID = state.selectedArchiveID
    if (!archiveID) return
    void run(
      "archive-export",
      async (location, request) => {
        const result = await props.api().agentCapabilities.evolutionExposureArchiveExport({
          ...location,
          archiveID,
        })
        const actualDigest = await sha256Text(result.data.content)
        if (actualDigest !== result.data.sha256) throw new Error("Exported audit document digest mismatch")
        if (scopeGuard.isCurrent(request)) downloadText(result.data.filename, result.data.media_type, result.data.content)
      },
      c().archiveExported,
      false,
    )
  }

  const run = async (
    name: string,
    action: (location: LocationInput, request: ScopeRequestToken) => Promise<unknown>,
    notice: string,
    refreshAfter = true,
  ) => {
    if (!props.ready() || state.loading) return
    const request = scopeGuard.capture()
    const requestedLocation = props.location()
    setState({ loading: name, error: "", notice: "" })
    try {
      await action(requestedLocation, request)
      if (notice && scopeGuard.isCurrent(request)) setState("notice", notice)
    } catch (error) {
      if (scopeGuard.isCurrent(request)) setState("error", evolutionRefreshError([error], c().unavailable))
    } finally {
      if (scopeGuard.isCurrent(request)) setState("loading", "")
    }
    if (refreshAfter && scopeGuard.isCurrent(request)) await refresh()
  }

  const createCandidate = () =>
    void run(
      "create",
      async (location, request) => {
        await props.api().agentCapabilities.evolutionCreate({
          ...location,
          title: state.title.trim(),
          target: state.target,
          instruction: state.instruction.trim(),
          rationale: state.rationale.trim(),
          evidenceRefs: evolutionEvidenceRefs(state.evidence),
        })
        if (scopeGuard.isCurrent(request)) setState({ title: "", instruction: "", rationale: "", evidence: "" })
      },
      c().create,
    )

  const transition = (candidate: Candidate, action: EvolutionAction) => {
    const reason = state.reasons[candidate.candidate_id]?.trim() ?? ""
    const destructive = evolutionActionRequiresReason(action)
    const label = {
      evaluate: c().evaluate,
      approve: c().approve,
      reject: c().reject,
      startCanary: c().canary,
      promote: c().promote,
      rollback: c().rollback,
    }[action]
    if (destructive && !reason) {
      setState("error", c().reason)
      return
    }
    if (destructive && !window.confirm(`${label}: ${candidate.title}\n\n${reason}`)) return
    void run(
      `${action}:${candidate.candidate_id}`,
      (location) =>
        props.api().agentCapabilities.evolutionTransition({
          ...location,
          candidateID: candidate.candidate_id,
          action,
          expectedRevision: candidate.state.revision,
          ...(reason ? { reason } : {}),
          ...(action === "startCanary" ? { trafficPercent: state.trafficPercent } : {}),
        }),
      label.replace("…", ""),
    )
  }

  const loadCanary = (candidate: Candidate) =>
    void run(
      `report:${candidate.candidate_id}`,
      async (location, request) => {
        const result = await props.api().agentCapabilities.evolutionCanaryReport({
          ...location,
          candidateID: candidate.candidate_id,
        })
        if (scopeGuard.isCurrent(request)) setState("canary", candidate.candidate_id, result.data)
      },
      c().report,
    )

  const fromPattern = (opportunity: Opportunity) => {
    const match = /^learning-pattern:(\d+)$/.exec(opportunity.source_ref)
    if (!match) return
    void run(
      `pattern:${match[1]}`,
      (location) =>
        props.api().agentCapabilities.evolutionFromPattern({
          ...location,
          patternID: Number(match[1]),
        }),
      c().propose,
    )
  }

  const previewContext = () =>
    void run(
      "preview",
      async (location, request) => {
        const result = await props.api().agentCapabilities.evolutionContextPreview({
          ...location,
          userInput: state.previewTask,
          cohortKey: state.cohortKey.trim(),
        })
        if (scopeGuard.isCurrent(request)) setState("contextPreview", result.data)
      },
      c().preview,
    )

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
            loading: "",
            error: "",
            notice: "",
            status: undefined,
            candidates: [],
            opportunities: [],
            recall: undefined,
            exposures: undefined,
            auditTimeline: undefined,
            archivePlan: undefined,
            archiveReason: "",
            archiveCatalog: undefined,
            selectedArchiveID: "",
            archiveDetail: undefined,
            restorePlan: undefined,
            restoreReason: "",
            canary: {},
            reasons: {},
            contextPreview: undefined,
          })
        }
        void refresh()
      },
    ),
  )

  return (
    <section
      class="flex flex-col gap-4 rounded-lg border border-border-weak-base p-4"
      data-testid="evolution-workbench"
      aria-busy={!!state.loading}
    >
      <header class="flex justify-end">
        <Button size="small" variant="ghost" disabled={!!state.loading} onClick={() => void refresh()}>
          {state.loading === "refresh" ? c().running : c().refresh}
        </Button>
      </header>

      <Show when={state.error}>
        <div role="alert" class="rounded-md border border-border-danger p-3 text-12-regular text-text-danger">
          {state.error}
        </div>
      </Show>
      <Show when={state.notice}>
        <div role="status" aria-live="polite" class="rounded-md border border-border-weak-base p-3 text-12-regular">
          {state.notice}
        </div>
      </Show>

      <div class="grid gap-3 md:grid-cols-4">
        <Metric label={c().candidates} value={state.status?.total ?? "—"} />
        <Metric label={c().audit} value={state.status ? (state.status.audit.valid ? "valid" : "invalid") : "—"} />
        <Metric label={c().constitution} value={state.status?.constitution.version ?? "—"} />
        <Metric
          label={c().autoProposal}
          value={
            state.status
              ? `${state.status.policy.min_auto_proposal_frequency}× · ${percent(state.status.policy.min_auto_proposal_confidence)}`
              : "—"
          }
        />
      </div>
      <p class="rounded-md bg-background-weak p-3 text-11-regular text-text-weak">{c().protected}</p>

      <article
        class="flex flex-col gap-3 rounded-md border border-border-weak-base p-3"
        data-testid="evolution-exposure-audit"
      >
        <header class="flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0 max-w-3xl">
            <h3 class="text-13-medium text-text-strong">{c().exposureAudit}</h3>
            <p class="mt-1 text-11-regular leading-relaxed text-text-weak">{c().exposureDescription}</p>
          </div>
          <label class="min-w-40 text-11-regular text-text-weak">
            {c().exposureFilter}
            <select
              class="mt-1 h-9 w-full rounded-md border border-border-weak-base bg-background-base px-3 text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
              value={state.exposureFilter}
              disabled={!!state.loading}
              onChange={(event) => filterExposures(event.currentTarget.value as ExposureFilter)}
            >
              <option value="all">{c().exposureAll}</option>
              <option value="pending">{c().exposurePending}</option>
              <option value="recorded">{c().exposureRecorded}</option>
            </select>
          </label>
        </header>

        <div class="grid gap-3 sm:grid-cols-3">
          <Metric label={c().exposureTotal} value={state.exposures?.total ?? "—"} />
          <Metric label={c().exposurePending} value={state.exposures?.counts.pending ?? "—"} />
          <Metric label={c().exposureRecorded} value={state.exposures?.counts.recorded ?? "—"} />
        </div>

        <Show when={state.exposures?.truncated}>
          <p role="status" class="rounded-md bg-background-weak p-3 text-11-regular text-text-warning">
            {state.exposures?.count} / {state.exposures?.total}
          </p>
        </Show>
        <Show when={state.exposures && state.exposures.items.length === 0}>
          <p class="text-12-regular text-text-weak">{c().noExposures}</p>
        </Show>

        <div class="grid gap-2">
          <For each={state.exposures?.items ?? []}>
            {(exposure) => (
              <details class="group rounded-md border border-border-weak-base bg-background-weak p-3">
                <summary class="flex min-h-11 cursor-pointer list-none flex-wrap items-center justify-between gap-2 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus">
                  <span class="flex min-w-0 flex-wrap items-center gap-2">
                    <span
                      class={
                        exposure.status === "pending"
                          ? "rounded-full border border-border-weak-base px-2 py-1 text-10-medium text-text-warning"
                          : "rounded-full border border-border-weak-base px-2 py-1 text-10-medium text-text-success"
                      }
                    >
                      {exposure.status === "pending" ? c().exposurePending : c().exposureRecorded}
                    </span>
                    <code class="break-all text-10-regular text-text-strong">{exposure.exposure_id}</code>
                  </span>
                  <time class="text-10-regular text-text-weak" dateTime={exposure.created_at}>
                    {new Date(exposure.created_at).toLocaleString()}
                  </time>
                </summary>

                <div class="mt-3 grid gap-3 border-t border-border-weak-base pt-3">
                  <dl class="grid gap-x-4 gap-y-2 text-10-regular sm:grid-cols-2">
                    <DigestFact label={c().cohortDigest} value={exposure.cohort_key_digest} />
                    <DigestFact label={c().contextDigest} value={exposure.context_digest} />
                    <DigestFact label={c().ticketDigest} value={exposure.ticket_digest} />
                    <Show when={exposure.receipt}>
                      {(receipt) => <DigestFact label={c().receiptDigest} value={receipt().receipt_digest} />}
                    </Show>
                  </dl>

                  <Show
                    when={exposure.source}
                    fallback={<p class="rounded-md bg-background-base p-3 text-11-regular text-text-weak">{c().legacySource}</p>}
                  >
                    {(source) => (
                      <section
                        class="grid gap-3 rounded-md border border-border-weak-base bg-background-base p-3"
                        aria-label={c().executionSource}
                        data-testid="evolution-exposure-source"
                      >
                        <div class="flex flex-wrap items-start justify-between gap-3">
                          <div class="min-w-0">
                            <h4 class="text-11-medium text-text-strong">{c().executionSource}</h4>
                            <p class="mt-1 text-10-regular leading-relaxed text-text-weak">{c().sourceDescription}</p>
                          </div>
                          <Button
                            type="button"
                            size="small"
                            variant="ghost"
                            onClick={() => openSourceSession(source().session_id)}
                          >
                            {c().openSourceSession}
                          </Button>
                        </div>
                        <dl class="grid gap-x-4 gap-y-2 text-10-regular sm:grid-cols-2">
                          <ReferenceFact label={c().sourceSession} value={source().session_id} />
                          <ReferenceFact label={c().sourceUserMessage} value={source().user_message_id} />
                          <ReferenceFact label={c().sourceStep} value={String(source().turn_step)} />
                          <Show when={exposure.receipt?.assistant_message_id}>
                            {(messageID) => <ReferenceFact label={c().sourceAssistantMessage} value={messageID()} />}
                          </Show>
                        </dl>
                      </section>
                    )}
                  </Show>

                  <section aria-label={c().assignments} class="grid gap-2">
                    <h4 class="text-11-medium text-text-strong">{c().assignments}</h4>
                    <For each={exposure.assignments}>
                      {(assignment) => (
                        <div class="flex flex-wrap items-center justify-between gap-2 rounded-md bg-background-base p-2 text-10-regular">
                          <span class="break-all text-text-strong">{assignment.candidate_id}</span>
                          <span class="text-text-weak">
                            {assignment.cohort === "candidate" ? c().candidateCohort : c().controlCohort} ·{" "}
                            <code title={assignment.candidate_digest}>{digestLabel(assignment.candidate_digest)}</code>
                          </span>
                        </div>
                      )}
                    </For>
                    <p class="text-10-regular text-text-weak">
                      {c().injected}:{" "}
                      {exposure.injected_candidate_ids.length ? exposure.injected_candidate_ids.join(", ") : "—"}
                    </p>
                  </section>

                  <Show
                    when={exposure.receipt}
                    fallback={
                      <p class="rounded-md bg-background-base p-3 text-11-regular text-text-warning">
                        {c().awaitingOutcome}
                      </p>
                    }
                  >
                    {(receipt) => (
                      <section class="grid gap-2 rounded-md bg-background-base p-3" aria-label={c().outcome}>
                        <div class="flex flex-wrap items-center justify-between gap-2 text-11-regular">
                          <span class="text-text-strong">
                            {c().observations}: {receipt().observation_count}
                          </span>
                          <time class="text-text-weak" dateTime={receipt().recorded_at}>
                            {new Date(receipt().recorded_at).toLocaleString()}
                          </time>
                        </div>
                        <Show
                          when={receipt().outcome}
                          fallback={<p class="text-11-regular text-text-weak">{c().legacyOutcome}</p>}
                        >
                          {(outcome) => (
                            <div class="grid gap-1 text-11-regular">
                              <p class={outcome().success ? "text-text-success" : "text-text-danger"}>
                                {outcome().success ? c().success : c().failure}
                              </p>
                              <p class={outcome().safety_incident ? "text-text-danger" : "text-text-weak"}>
                                {outcome().safety_incident ? c().safetyIncident : c().noSafetyIncident}
                              </p>
                              <Show when={outcome().stop_reason}>
                                <p class="whitespace-pre-wrap break-words text-text-weak">{outcome().stop_reason}</p>
                              </Show>
                            </div>
                          )}
                        </Show>
                      </section>
                    )}
                  </Show>
                </div>
              </details>
            )}
          </For>
        </div>

        <section class="grid gap-3 rounded-md border border-border-weak-base bg-background-base p-3">
          <div>
            <h4 class="text-12-medium text-text-strong">{c().archiveRetention}</h4>
            <p class="mt-1 text-11-regular leading-relaxed text-text-weak">{c().archiveDescription}</p>
          </div>
          <div class="flex flex-wrap items-end gap-3">
            <label class="min-w-56 text-11-regular text-text-weak">
              {c().keepRecorded}
              <input
                class="mt-1 h-9 w-full rounded-md border border-border-weak-base bg-background-base px-3 text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
                type="number"
                min="0"
                max="10000"
                step="1"
                value={state.archiveKeepRecorded}
                disabled={!!state.loading}
                onInput={(event) => {
                  setState("archiveKeepRecorded", Number(event.currentTarget.value))
                  setState("archivePlan", undefined)
                }}
              />
            </label>
            <Button
              size="small"
              variant="secondary"
              disabled={
                !!state.loading ||
                !Number.isFinite(state.archiveKeepRecorded) ||
                state.archiveKeepRecorded < 0 ||
                state.archiveKeepRecorded > 10_000
              }
              onClick={previewExposureArchive}
            >
              {state.loading === "archive-preview" ? c().running : c().previewArchive}
            </Button>
          </div>
          <Show when={state.archivePlan}>
            {(plan) => (
              <div class="grid gap-3 rounded-md bg-background-weak p-3" data-testid="evolution-archive-plan">
                <div class="grid gap-3 sm:grid-cols-3">
                  <Metric label={c().archiveEligible} value={plan().eligible_count} />
                  <Metric label={c().exposurePending} value={plan().counts.pending} />
                  <Metric label={c().archiveRetained} value={plan().counts.retained_recorded} />
                </div>
                <DigestFact label={c().archivePlanDigest} value={plan().plan_digest} />
                <Show
                  when={plan().eligible_count > 0}
                  fallback={<p class="text-11-regular text-text-success">{c().archiveNoop}</p>}
                >
                  <Field
                    label={c().archiveReason}
                    value={state.archiveReason}
                    onInput={(value) => setState("archiveReason", value)}
                  />
                  <details class="rounded-md border border-border-weak-base p-2 text-10-regular text-text-weak">
                    <summary class="min-h-9 cursor-pointer rounded-sm py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus">
                      {c().archiveEligible}: {plan().eligible_count}
                      {plan().truncated ? ` · ${plan().items.length} shown` : ""}
                    </summary>
                    <ul class="mt-2 grid gap-1 border-t border-border-weak-base pt-2">
                      <For each={plan().items}>
                        {(item) => (
                          <li class="flex flex-wrap justify-between gap-2">
                            <code class="break-all text-text-strong">{item.exposure_id}</code>
                            <time dateTime={item.created_at}>{new Date(item.created_at).toLocaleString()}</time>
                          </li>
                        )}
                      </For>
                    </ul>
                  </details>
                  <Button
                    size="small"
                    variant="primary"
                    disabled={!!state.loading || !state.archiveReason.trim()}
                    onClick={applyExposureArchive}
                  >
                    {state.loading === "archive-apply" ? c().running : c().applyArchive}
                  </Button>
                </Show>
              </div>
            )}
          </Show>
        </section>

        <section
          class="grid gap-3 rounded-md border border-border-weak-base bg-background-base p-3"
          data-testid="evolution-archive-library"
        >
          <div>
            <h4 class="text-12-medium text-text-strong">{c().archiveLibrary}</h4>
            <p class="mt-1 text-11-regular leading-relaxed text-text-weak">{c().archiveLibraryDescription}</p>
          </div>
          <div class="grid gap-3 sm:grid-cols-3">
            <Metric label={c().archiveCount} value={state.archiveCatalog?.total ?? "—"} />
            <Metric label={c().integrityValid} value={state.archiveCatalog?.valid_count ?? "—"} />
            <Metric label={c().invalidArchives} value={state.archiveCatalog?.invalid_count ?? "—"} />
          </div>
          <Show when={state.archiveCatalog && state.archiveCatalog.items.length === 0}>
            <p class="text-11-regular text-text-weak">{c().noArchives}</p>
          </Show>
          <Show when={state.archiveCatalog && state.archiveCatalog.items.length > 0}>
            <div class="grid min-w-0 gap-3 lg:grid-cols-[minmax(220px,0.8fr)_minmax(0,1.6fr)]">
              <div class="grid max-h-96 content-start gap-2 overflow-y-auto" aria-label={c().archiveLibrary}>
                <For each={state.archiveCatalog?.items ?? []}>
                  {(archive) => (
                    <button
                      type="button"
                      class="min-h-11 w-full rounded-md border border-border-weak-base bg-background-weak p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus disabled:cursor-not-allowed disabled:opacity-70"
                      classList={{ "ring-1 ring-border-focus": state.selectedArchiveID === archive.archive_id }}
                      aria-pressed={state.selectedArchiveID === archive.archive_id}
                      disabled={!!state.loading || !archive.integrity.valid}
                      onClick={() => selectExposureArchive(archive.archive_id)}
                    >
                      <span class="flex flex-wrap items-center justify-between gap-2">
                        <code class="break-all text-10-medium text-text-strong">{archive.archive_id}</code>
                        <span
                          class={
                            archive.integrity.valid
                              ? "text-10-medium text-text-success"
                              : "text-10-medium text-text-danger"
                          }
                        >
                          {archive.integrity.valid ? `✓ ${c().integrityValid}` : `× ${c().integrityInvalid}`}
                        </span>
                      </span>
                      <span class="mt-2 grid gap-1 text-10-regular text-text-weak">
                        <span>
                          {c().archivedRecords}: {archive.archived_count}
                        </span>
                        <Show when={archive.published_at}>
                          <time dateTime={archive.published_at}>
                            {c().publishedAt}: {new Date(archive.published_at).toLocaleString()}
                          </time>
                        </Show>
                        <Show when={!archive.integrity.valid}>
                          <span class="text-text-danger">{archive.integrity.issue}</span>
                        </Show>
                      </span>
                    </button>
                  )}
                </For>
              </div>

              <Show
                when={state.archiveDetail}
                fallback={
                  <p class="min-h-24 rounded-md bg-background-weak p-3 text-11-regular text-text-weak">
                    {c().selectArchive}
                  </p>
                }
              >
                {(detail) => (
                  <div class="grid min-w-0 gap-3 rounded-md bg-background-weak p-3" data-testid="archive-detail">
                    <header class="flex flex-wrap items-start justify-between gap-3">
                      <div class="min-w-0">
                        <h5 class="text-11-medium text-text-strong">{c().archiveDetails}</h5>
                        <code class="mt-1 block break-all text-10-regular text-text-weak">{detail().archive_id}</code>
                      </div>
                      <span class="text-10-medium text-text-success">✓ {c().integrityValid}</span>
                    </header>
                    <div class="grid gap-3 sm:grid-cols-3">
                      <Metric label={c().archivedRecords} value={detail().archived_count} />
                      <Metric label={c().missingLive} value={detail().restore.missing} />
                      <Metric label={c().alreadyLive} value={detail().restore.identical} />
                    </div>
                    <dl class="grid gap-x-4 gap-y-2 text-10-regular sm:grid-cols-2">
                      <DigestFact label={c().archivePlanDigest} value={detail().plan_digest} />
                      <DigestFact label="Manifest SHA-256" value={detail().manifest_digest} />
                      <DigestFact label="Completion SHA-256" value={detail().completion_digest} />
                      <DigestFact label="Evidence set SHA-256" value={detail().evidence_set_digest} />
                      <div>
                        <dt class="text-text-weak">{c().publishedAt}</dt>
                        <dd class="mt-1 text-text-strong">
                          <time dateTime={detail().published_at}>
                            {new Date(detail().published_at).toLocaleString()}
                          </time>
                        </dd>
                      </div>
                      <div>
                        <dt class="text-text-weak">{c().completedAt}</dt>
                        <dd class="mt-1 text-text-strong">
                          <time dateTime={detail().completed_at}>
                            {new Date(detail().completed_at).toLocaleString()}
                          </time>
                        </dd>
                      </div>
                    </dl>
                    <p class="rounded-md bg-background-base p-3 text-10-regular text-text-weak">
                      {c().sanitizedExport}
                    </p>
                    <div class="flex flex-wrap gap-2">
                      <Button
                        size="small"
                        variant="secondary"
                        disabled={!!state.loading}
                        onClick={previewExposureRestore}
                      >
                        {state.loading === "restore-preview" ? c().running : c().restorePreview}
                      </Button>
                      <Button size="small" variant="ghost" disabled={!!state.loading} onClick={exportExposureArchive}>
                        {state.loading === "archive-export" ? c().running : c().archiveExport}
                      </Button>
                    </div>

                    <Show when={state.restorePlan}>
                      {(plan) => (
                        <section
                          class="grid gap-3 rounded-md border border-border-weak-base bg-background-base p-3"
                          data-testid="evolution-restore-plan"
                        >
                          <div class="grid gap-3 sm:grid-cols-3">
                            <Metric label={c().missingLive} value={plan().counts.missing} />
                            <Metric label={c().alreadyLive} value={plan().counts.already_present} />
                            <Metric label={c().conflictLive} value={plan().counts.conflicts} />
                          </div>
                          <DigestFact label={c().archivePlanDigest} value={plan().plan_digest} />
                          <Show when={plan().counts.conflicts > 0}>
                            <p role="alert" class="text-11-regular text-text-danger">
                              {c().restoreBlockedConflict}
                            </p>
                          </Show>
                          <Show when={plan().capacity_exceeded}>
                            <p role="alert" class="text-11-regular text-text-danger">
                              {c().restoreBlockedCapacity}
                            </p>
                          </Show>
                          <Show when={plan().can_apply && plan().counts.missing > 0}>
                            <Field
                              label={c().restoreReason}
                              value={state.restoreReason}
                              onInput={(value) => setState("restoreReason", value)}
                            />
                            <Button
                              size="small"
                              variant="primary"
                              disabled={!!state.loading || !state.restoreReason.trim()}
                              onClick={applyExposureRestore}
                            >
                              {state.loading === "restore-apply" ? c().running : c().restoreRecords}
                            </Button>
                          </Show>
                          <Show when={plan().can_apply && plan().counts.missing === 0}>
                            <p class="text-11-regular text-text-success">{c().restoreNoop}</p>
                          </Show>
                        </section>
                      )}
                    </Show>

                    <details class="rounded-md border border-border-weak-base p-2 text-10-regular text-text-weak">
                      <summary class="min-h-9 cursor-pointer rounded-sm py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus">
                        {c().evidenceItems}: {detail().archived_count}
                        {detail().truncated ? ` · ${detail().items.length} shown` : ""}
                      </summary>
                      <ul class="mt-2 grid gap-2 border-t border-border-weak-base pt-2">
                        <For each={detail().items}>
                          {(item) => (
                            <li class="grid gap-1 rounded-md bg-background-base p-2">
                              <span class="flex flex-wrap items-center justify-between gap-2">
                                <code class="break-all text-text-strong">{item.exposure_id}</code>
                                <span class={item.live_status === "conflict" ? "text-text-danger" : "text-text-weak"}>
                                  {item.live_status === "missing"
                                    ? c().missingLive
                                    : item.live_status === "identical"
                                      ? c().alreadyLive
                                      : c().conflictLive}
                                </span>
                              </span>
                              <span>
                                {c().ticketDigest}: <code>{digestLabel(item.ticket_digest)}</code>
                              </span>
                              <span>
                                {c().receiptDigest}: <code>{digestLabel(item.receipt_digest)}</code>
                              </span>
                              <Show when={item.source}>
                                {(source) => (
                                  <span class="mt-1 flex flex-wrap items-center justify-between gap-2 border-t border-border-weak-base pt-2">
                                    <span>
                                      {c().sourceSession}: <code class="break-all">{source().session_id}</code> ·{" "}
                                      {c().sourceStep} {source().turn_step}
                                    </span>
                                    <Button
                                      type="button"
                                      size="small"
                                      variant="ghost"
                                      onClick={() => openSourceSession(source().session_id)}
                                    >
                                      {c().openSourceSession}
                                    </Button>
                                  </span>
                                )}
                              </Show>
                            </li>
                          )}
                        </For>
                      </ul>
                    </details>
                  </div>
                )}
              </Show>
            </div>
          </Show>
        </section>
      </article>

      <article
        class="flex flex-col gap-3 rounded-md border border-border-weak-base p-3"
        data-testid="evolution-execution-timeline"
      >
        <header class="flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0 max-w-3xl">
            <h3 class="text-13-medium text-text-strong">{c().executionTimeline}</h3>
            <p class="mt-1 text-11-regular leading-relaxed text-text-weak">{c().timelineDescription}</p>
          </div>
          <Show when={state.auditTimeline?.valid}>
            <span class="rounded-full border border-border-weak-base px-2 py-1 text-10-medium text-text-success">
              ✓ {c().chainValid} · {state.auditTimeline?.total ?? 0}
            </span>
          </Show>
        </header>
        <Show when={state.auditTimeline && state.auditTimeline.items.length === 0}>
          <p class="text-12-regular text-text-weak">{c().noEvents}</p>
        </Show>
        <ol class="grid gap-2">
          <For each={state.auditTimeline?.items ?? []}>
            {(event) => (
              <li>
                <details class="rounded-md border border-border-weak-base bg-background-weak p-3">
                  <summary class="flex min-h-11 cursor-pointer list-none flex-wrap items-center justify-between gap-2 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus">
                    <span class="min-w-0">
                      <span class="text-11-medium capitalize text-text-strong">{auditActionLabel(event.action)}</span>
                      <code class="ml-2 text-10-regular text-text-weak">#{event.sequence}</code>
                    </span>
                    <time class="text-10-regular text-text-weak" dateTime={event.recorded_at}>
                      {new Date(event.recorded_at).toLocaleString()}
                    </time>
                  </summary>
                  <dl class="mt-3 grid gap-2 border-t border-border-weak-base pt-3 text-10-regular sm:grid-cols-2">
                    <DigestFact label={c().eventActor} value={event.actor} />
                    <DigestFact
                      label={c().eventSubject}
                      value={`${event.subject_kind} · ${event.subject_id || "system"}`}
                    />
                    <Show when={event.reason}>
                      <div class="sm:col-span-2">
                        <dt class="text-text-weak">{c().eventReason}</dt>
                        <dd class="mt-1 whitespace-pre-wrap break-words text-text-strong">{event.reason}</dd>
                      </div>
                    </Show>
                  </dl>
                  <details class="mt-3 rounded-md bg-background-base p-2 text-10-regular text-text-weak">
                    <summary class="min-h-9 cursor-pointer rounded-sm py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus">
                      {c().eventMetadata}
                    </summary>
                    <pre class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all border-t border-border-weak-base pt-2">
                      {JSON.stringify(
                        {
                          metadata: event.metadata,
                          previous_hash: event.previous_hash,
                          record_hash: event.record_hash,
                        },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                </details>
              </li>
            )}
          </For>
        </ol>
        <Show when={state.auditTimeline?.truncated}>
          <p role="status" class="rounded-md bg-background-weak p-3 text-11-regular text-text-warning">
            {state.auditTimeline?.count} / {state.auditTimeline?.total}
          </p>
        </Show>
      </article>

      <article class="flex flex-col gap-3 rounded-md border border-border-weak-base p-3">
        <h3 class="text-13-medium text-text-strong">{c().actualRecall}</h3>
        <p class="text-11-regular text-text-weak">{c().syntheticWarning}</p>
        <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <Metric label={c().recalls} value={state.recall?.sampleSize ?? "—"} />
          <Metric label={c().useful} value={state.recall ? percent(state.recall.top1Rate) : "—"} />
          <Metric label={c().feedback} value={state.recall ? state.recall.meanReciprocalRank.toFixed(3) : "—"} />
          <Metric label={c().stale} value={state.recall ? percent(state.recall.noResultRate) : "—"} />
          <Metric label={c().conflicts} value={state.recall?.status ?? "—"} />
        </div>
      </article>

      <details class="rounded-md border border-border-weak-base p-3">
        <summary class="cursor-pointer text-13-medium text-text-strong">{c().create}</summary>
        <div class="mt-3 grid gap-3">
          <Field label={c().titleField} value={state.title} onInput={(value) => setState("title", value)} />
          <label class="text-11-regular text-text-weak">
            {c().target}
            <select
              class="mt-1 h-9 w-full rounded-md border border-border-weak-base bg-background-base px-3 text-text-strong"
              value={state.target}
              onChange={(event) => setState("target", event.currentTarget.value as Candidate["target"])}
            >
              <option value="learning.failure">learning.failure</option>
              <option value="learning.fix">learning.fix</option>
              <option value="learning.preference">learning.preference</option>
              <option value="routing.advice">routing.advice</option>
              <option value="tool.advice">tool.advice</option>
            </select>
          </label>
          <Area label={c().instruction} value={state.instruction} onInput={(value) => setState("instruction", value)} />
          <Area label={c().rationale} value={state.rationale} onInput={(value) => setState("rationale", value)} />
          <Area label={c().evidence} value={state.evidence} onInput={(value) => setState("evidence", value)} />
          <Button
            size="small"
            variant="secondary"
            disabled={
              !!state.loading ||
              !state.title.trim() ||
              !state.instruction.trim() ||
              !state.rationale.trim() ||
              !state.evidence.trim()
            }
            onClick={createCandidate}
          >
            {state.loading === "create" ? c().running : c().create}
          </Button>
        </div>
      </details>

      <article class="flex flex-col gap-3 rounded-md border border-border-weak-base p-3">
        <h3 class="text-13-medium text-text-strong">{c().opportunities}</h3>
        <For each={state.opportunities}>
          {(item) => (
            <div class="flex flex-wrap items-center justify-between gap-3 rounded-md bg-background-weak p-3">
              <div class="min-w-0 text-11-regular">
                <div class="text-text-strong">{item.source_ref}</div>
                <div class="mt-1 text-text-weak">
                  {item.kind} · {item.category}
                </div>
              </div>
              <Show when={item.proposal_available && item.source_ref.startsWith("learning-pattern:")}>
                <Button size="small" variant="ghost" disabled={!!state.loading} onClick={() => fromPattern(item)}>
                  {c().propose}
                </Button>
              </Show>
            </div>
          )}
        </For>
      </article>

      <article class="flex flex-col gap-3 rounded-md border border-border-weak-base p-3">
        <h3 class="text-13-medium text-text-strong">{c().candidates}</h3>
        <Show when={state.candidates.length === 0}>
          <p class="text-12-regular text-text-weak">{c().noData}</p>
        </Show>
        <For each={state.candidates}>
          {(candidate) => {
            const report = () => state.canary[candidate.candidate_id]
            const actions = () =>
              evolutionActions(
                candidate.state.status,
                candidate.evaluation?.gate_passed ?? false,
                report()?.gate_passed ?? false,
              )
            return (
              <section class="flex flex-col gap-3 rounded-md bg-background-weak p-3">
                <header class="flex flex-wrap items-start justify-between gap-3">
                  <div class="min-w-0">
                    <h4 class="text-12-medium text-text-strong">{candidate.title}</h4>
                    <p class="mt-1 break-all text-10-regular text-text-weak">
                      {candidate.candidate_id} · {candidate.target} · rev {candidate.state.revision}
                    </p>
                  </div>
                  <span class="rounded-full border border-border-weak-base px-2 py-1 text-10-medium text-text-strong">
                    {statusLabel(candidate.state.status)}
                  </span>
                </header>
                <p class="text-11-regular text-text-strong">{candidate.instruction}</p>
                <dl class="grid gap-1 text-10-regular text-text-weak">
                  <div>
                    <dt class="inline text-text-strong">{c().proposer}: </dt>
                    <dd class="inline">{proposerLabel(candidate.created_by)}</dd>
                  </div>
                  <div>
                    <dt class="inline text-text-strong">{c().rationale}: </dt>
                    <dd class="inline">{candidate.rationale}</dd>
                  </div>
                  <div>
                    <dt class="inline text-text-strong">{c().evidence}: </dt>
                    <dd class="inline break-all">{candidate.evidence_refs.join(", ")}</dd>
                  </div>
                </dl>
                <Show when={candidate.evaluation}>
                  {(evaluation) => (
                    <div class="rounded-md border border-border-weak-base p-2 text-11-regular">
                      <div class={evaluation().gate_passed ? "text-text-success" : "text-text-danger"}>
                        {evaluation().gate_passed ? c().gatePassed : c().gateBlocked}
                      </div>
                      <ul class="mt-2 grid gap-1 text-text-weak">
                        <For each={evaluation().cases}>
                          {(item) => (
                            <li>
                              {item.passed ? "✓" : "×"} {item.case_id}: {item.detail}
                            </li>
                          )}
                        </For>
                      </ul>
                    </div>
                  )}
                </Show>
                <Show when={actions().some(evolutionActionRequiresReason)}>
                  <Field
                    label={c().reason}
                    value={state.reasons[candidate.candidate_id] ?? ""}
                    onInput={(value) => setState("reasons", candidate.candidate_id, value)}
                  />
                </Show>
                <Show when={candidate.state.status === "approved"}>
                  <label class="text-11-regular text-text-weak">
                    {c().traffic}
                    <input
                      class="mt-1 h-9 w-32 rounded-md border border-border-weak-base bg-background-base px-3 text-text-strong"
                      type="number"
                      min="1"
                      max="100"
                      value={state.trafficPercent}
                      onInput={(event) => setState("trafficPercent", Number(event.currentTarget.value))}
                    />
                  </label>
                </Show>
                <div class="flex flex-wrap gap-2">
                  <Show when={actions().includes("evaluate")}>
                    <Button
                      size="small"
                      variant="secondary"
                      disabled={!!state.loading}
                      onClick={() => transition(candidate, "evaluate")}
                    >
                      {state.loading === `evaluate:${candidate.candidate_id}` ? c().running : c().evaluate}
                    </Button>
                  </Show>
                  <Show when={actions().includes("approve")}>
                    <Button
                      size="small"
                      variant="primary"
                      disabled={!!state.loading}
                      onClick={() => transition(candidate, "approve")}
                    >
                      {state.loading === `approve:${candidate.candidate_id}` ? c().running : c().approve}
                    </Button>
                  </Show>
                  <Show when={actions().includes("reject")}>
                    <Button
                      size="small"
                      variant="ghost"
                      disabled={!!state.loading}
                      onClick={() => transition(candidate, "reject")}
                    >
                      {state.loading === `reject:${candidate.candidate_id}` ? c().running : c().reject}
                    </Button>
                  </Show>
                  <Show when={actions().includes("startCanary")}>
                    <Button
                      size="small"
                      variant="primary"
                      disabled={!!state.loading}
                      onClick={() => transition(candidate, "startCanary")}
                    >
                      {state.loading === `startCanary:${candidate.candidate_id}` ? c().running : c().canary}
                    </Button>
                  </Show>
                  <Show when={candidate.state.status === "canary"}>
                    <Button
                      size="small"
                      variant="secondary"
                      disabled={!!state.loading}
                      onClick={() => loadCanary(candidate)}
                    >
                      {state.loading === `report:${candidate.candidate_id}` ? c().running : c().report}
                    </Button>
                    <Show when={actions().includes("promote")}>
                      <Button
                        size="small"
                        variant="primary"
                        disabled={!!state.loading}
                        onClick={() => transition(candidate, "promote")}
                      >
                        {state.loading === `promote:${candidate.candidate_id}` ? c().running : c().promote}
                      </Button>
                    </Show>
                  </Show>
                  <Show when={actions().includes("rollback")}>
                    <Button
                      size="small"
                      variant="ghost"
                      disabled={!!state.loading}
                      onClick={() => transition(candidate, "rollback")}
                    >
                      {state.loading === `rollback:${candidate.candidate_id}` ? c().running : c().rollback}
                    </Button>
                  </Show>
                </div>
                <Show when={report()}>
                  {(value) => (
                    <div class="grid gap-2">
                      <div
                        class="rounded-md border border-border-weak-base bg-background-base p-3 text-11-regular text-text-weak"
                        role="status"
                      >
                        <div class="text-12-medium text-text-strong">
                          {value().gate_passed ? c().gatePassed : c().gateBlocked}
                        </div>
                        <ul class="mt-2 grid gap-1">
                          <For each={Object.entries(value().checks)}>
                            {([check, passed]) => (
                              <li>
                                {passed ? "✓" : "×"} {check}
                              </li>
                            )}
                          </For>
                        </ul>
                      </div>
                      <div class="grid gap-2 sm:grid-cols-3">
                        <Metric
                          label="candidate"
                          value={`${value().candidate_observations} · ${percent(value().candidate_success_rate)}`}
                        />
                        <Metric
                          label="control"
                          value={`${value().control_observations} · ${percent(value().control_success_rate)}`}
                        />
                        <Metric label="delta" value={percent(value().success_rate_delta)} />
                      </div>
                    </div>
                  )}
                </Show>
              </section>
            )
          }}
        </For>
      </article>

      <details class="rounded-md border border-border-weak-base p-3">
        <summary class="cursor-pointer text-13-medium text-text-strong">{c().preview}</summary>
        <div class="mt-3 grid gap-3">
          <Area label={c().previewTask} value={state.previewTask} onInput={(value) => setState("previewTask", value)} />
          <Field label={c().cohort} value={state.cohortKey} onInput={(value) => setState("cohortKey", value)} />
          <Button
            size="small"
            variant="secondary"
            disabled={!!state.loading || !state.cohortKey.trim()}
            onClick={previewContext}
          >
            {c().previewButton}
          </Button>
          <Show when={state.contextPreview}>
            {(value) => (
              <pre class="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-background-stronger p-3 text-10-regular text-text-weak">
                {JSON.stringify(value(), null, 2)}
              </pre>
            )}
          </Show>
        </div>
      </details>
    </section>
  )
}

function Field(props: { label: string; value: string; onInput: (value: string) => void }) {
  return (
    <label class="text-11-regular text-text-weak">
      {props.label}
      <input
        class="mt-1 h-9 w-full rounded-md border border-border-weak-base bg-background-base px-3 text-text-strong"
        value={props.value}
        onInput={(event) => props.onInput(event.currentTarget.value)}
      />
    </label>
  )
}

function Area(props: { label: string; value: string; onInput: (value: string) => void }) {
  return (
    <label class="text-11-regular text-text-weak">
      {props.label}
      <textarea
        class="mt-1 min-h-20 w-full rounded-md border border-border-weak-base bg-background-base p-3 text-text-strong"
        value={props.value}
        onInput={(event) => props.onInput(event.currentTarget.value)}
      />
    </label>
  )
}

function Metric(props: { label: string; value: string | number }) {
  return (
    <div class="rounded-md bg-background-weak p-3">
      <div class="text-10-regular text-text-weak">{props.label}</div>
      <div class="mt-1 text-14-medium text-text-strong">{props.value}</div>
    </div>
  )
}

function DigestFact(props: { label: string; value: string }) {
  return (
    <div class="min-w-0">
      <dt class="text-text-weak">{props.label}</dt>
      <dd class="mt-1 break-all text-text-strong">
        <code title={props.value}>{digestLabel(props.value)}</code>
      </dd>
    </div>
  )
}

function ReferenceFact(props: { label: string; value: string }) {
  return (
    <div class="min-w-0">
      <dt class="text-text-weak">{props.label}</dt>
      <dd class="mt-1 break-all text-text-strong">
        <code>{props.value}</code>
      </dd>
    </div>
  )
}
