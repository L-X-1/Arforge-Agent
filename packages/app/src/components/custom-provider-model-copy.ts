export type ModelSetupCopy = {
  preset: string
  automatic: string
  metadataHint: string
  context: string
  input: string
  output: string
  unknownPlaceholder: string
  override: string
  reset: string
  matching: string
  matched: string
  ambiguous: string
  unknown: string
  unavailable: string
  invalidLimit: string
  legacyUnsupported: string
  legacyLimitUnsupported: string
  retry: string
  sources: string
}

const en: ModelSetupCopy = {
  preset: "Model preset",
  automatic: "Automatic matching / manual setup",
  context: "Context capacity (tokens)",
  input: "Maximum input (tokens)",
  output: "Maximum output (tokens)",
  unknownPlaceholder: "Unknown; enter manually",
  override: "Manual override",
  reset: "Restore preset value",
  matching: "Matching model metadata…",
  matched: "Model metadata matched. Parameters remain editable.",
  ambiguous: "Several models match. Choose a preset or enter values manually.",
  unknown: "No unambiguous metadata. Choose a preset or enter values manually.",
  unavailable: "Model metadata is unavailable. Manual setup remains available.",
  metadataHint:
    "Presets suggest parameters and do not prove service availability. Endpoint, secret and requested model ID stay as entered.",
  invalidLimit: "Enter a positive whole number, or leave the value unknown.",
  legacyUnsupported:
    "Preset metadata and canonical variants require the supported V2 configuration API. Manual model names and limits remain available.",
  legacyLimitUnsupported:
    "This server requires both context and maximum output when setting limits. Enter both or leave both unknown.",
  retry: "Retry model metadata",
  sources: "Model metadata sources",
}
const zh: ModelSetupCopy = {
  preset: "模型预设",
  automatic: "自动匹配 / 手动配置",
  context: "上下文容量（tokens）",
  input: "最大输入（tokens）",
  output: "最大输出（tokens）",
  unknownPlaceholder: "未知，可手动填写",
  override: "手动覆盖",
  reset: "恢复预设值",
  matching: "正在匹配模型资料…",
  matched: "已匹配模型资料，参数仍可编辑。",
  ambiguous: "存在多个匹配，请明确选择预设或手动填写。",
  unknown: "未匹配到明确资料，可选择预设或手动填写。",
  unavailable: "模型资料暂不可用，可手动填写。",
  metadataHint: "预设只提供参数参考，不代表当前服务已开通该模型；服务地址、密钥和请求模型 ID 保持原值。",
  invalidLimit: "请输入正整数，或留空表示未知。",
  legacyUnsupported: "模型预设及标准变体需要受支持的 V2 配置接口。仍可手动配置模型名称和容量。",
  legacyLimitUnsupported: "当前服务设置容量时需要同时填写上下文和最大输出；也可将两项均留空。",
  retry: "重试模型资料",
  sources: "模型资料来源",
}
const zht: ModelSetupCopy = {
  preset: "模型預設",
  automatic: "自動比對 / 手動設定",
  context: "上下文容量（tokens）",
  input: "最大輸入（tokens）",
  output: "最大輸出（tokens）",
  unknownPlaceholder: "未知，可手動填寫",
  override: "手動覆寫",
  reset: "還原預設值",
  matching: "正在比對模型資料…",
  matched: "已比對模型資料，參數仍可編輯。",
  ambiguous: "有多個相符項目，請明確選擇預設或手動填寫。",
  unknown: "未找到明確資料，可選擇預設或手動填寫。",
  unavailable: "模型資料暫時無法取得，可手動填寫。",
  metadataHint: "預設僅提供參數參考，不代表目前服務已開通該模型；服務位址、金鑰和請求模型 ID 保持原值。",
  invalidLimit: "請輸入正整數，或留空表示未知。",
  legacyUnsupported: "模型預設及標準變體需要受支援的 V2 設定介面。仍可手動設定模型名稱和容量。",
  legacyLimitUnsupported: "目前服務設定容量時需要同時填寫上下文和最大輸出；也可將兩項均留空。",
  retry: "重試模型資料",
  sources: "模型資料來源",
}

export function modelPresetSettingsCopy(locale: string): ModelSetupCopy {
  const key = locale.toLowerCase()
  if (["zht", "zh-tw", "zh-hant", "zh-hk"].includes(key)) return zht
  if (["zh", "zh-cn", "zh-hans", "zhhans"].includes(key)) return zh
  return en
}
