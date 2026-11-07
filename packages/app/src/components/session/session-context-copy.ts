export function contextCopy(locale: string) {
  const zh = locale.startsWith("zh")
  const text = (cn: string, en: string) => zh ? cn : en
  return {
    source: text("来源与采样", "Source and sample"),
    server: text("服务器", "Server"), directory: text("工作区目录", "Workspace directory"), session: text("会话 ID", "Session ID"),
    budget: text("当前选择的模型预算", "Selected model budget"),
    context: text("上下文上限", "Context limit"), input: text("输入上限", "Input limit"), output: text("输出上限", "Output limit"),
    selectedModel: text("当前选择", "Current selection"), sampledModel: text("采样模型", "Sample model"),
    confirmed: text("最近已确认用量", "Latest confirmed usage"),
    details: text("结算明细与采样信息", "Settlement details and sample"),
    sample: text("采样消息", "Sample message"), settledAt: text("确认时间", "Settlement time"),
    recordedAt: text("读取时间", "Read time"), revision: text("读取内容指纹", "Read content fingerprint"),
    noConfirmed: text("尚无已完成且包含用量的模型回复。未结算或失败中的计数不作为已确认用量。", "No completed model reply with usage is available. Streaming or failed counters are not confirmed usage."),
    accounting: text("以下用量来自这条已完成回复；当前选择的模型预算另列，不代表下一条请求的预测。", "Usage below belongs to this completed reply. The selected model budget is separate; neither predicts the next request."),
    estimate: text("已加载消息的来源估算", "Loaded-message source estimate"),
    estimateBasis: text("基于当前已加载消息与 system prompt 的文本字符数（约 4 字符/token），工具输入使用字段数近似；按采样输入用量归一化。未加载消息、图片、附件二进制及最终请求包装不可精确计入。不是下一条请求的 token 预测，也不是服务商逐来源结算。", "Based on text characters in loaded messages and the system prompt (about 4 characters/token), with an input-field approximation for tools; normalized to the sampled input usage. Unloaded messages, images, binary attachments and final request framing are not precisely counted. This is neither a next-request forecast nor provider-settled usage per source."),
    noEstimate: text("缺少已确认输入用量，暂不绘制估算比例。", "Confirmed input usage is unavailable; no estimated proportions are drawn."),
    loaded: text("采样范围：当前已加载消息", "Sample scope: currently loaded messages"),
    preview: text("压缩范围与证据预览", "Compression scope and evidence preview"),
    open: text("读取只读预览", "Read preview"), refresh: text("重新读取", "Read again"), close: text("关闭预览", "Close preview"),
    loading: text("正在读取会话上下文…", "Reading session context…"),
    readonly: text("只读读取，不调用模型、不提交压缩。", "Read-only: no model call or compression submission."),
    candidates: text("当前可读候选输入", "Currently readable candidate inputs"),
    inputJSON: text("查看候选输入 JSON（只读）", "Inspect candidate JSON (read-only)"),
    readError: text("当前来源读取或操作失败，请重新读取后重试。", "The source read or operation failed. Read again and retry."),
    existing: text("已有压缩记录", "Existing compaction records"),
    none: text("没有可读候选消息。", "No readable candidate messages."),
    keep: text("本次保留范围", "Retained range for this operation"), compact: text("本次压缩范围", "Compacted range for this operation"),
    unknownRange: text("未知：当前只读接口未提供权威分界。", "Unknown: the read API provides no authoritative boundary."),
    unknownResult: text("压缩后的摘要、token 数和节省量未知；已有压缩记录是历史证据，不是本次预览结果。", "The resulting summary, token count and savings are unknown. Existing compaction records are historical evidence, not this preview's result."),
    rangeCaveat: text("候选来自服务器当前 active context，不是 Core 承诺的执行计划。配置、tokenizer 和执行时上下文仍由原压缩动作重新评估；此内容指纹不是服务端锁或 CAS 令牌。", "Candidates come from the server's active context, not a committed Core execution plan. The original action re-evaluates configuration, tokenizer and context at execution; this fingerprint is not a server lock or CAS token."),
    stale: text("来源、模型或上下文已变化。请重新读取预览后再确认。", "The source, model or context changed. Read the preview again before confirming."),
    confirm: text("确认并调用原压缩动作", "Confirm original compression action"),
    confirmNote: text("确认前会再次读取并核对同一会话、模型与内容。服务器若不支持原压缩动作，将显示真实失败。", "Confirmation re-reads and checks the same session, model and content. An unsupported compression action remains an actual server error."),
    checking: text("正在核对最新内容…", "Checking current content…"), submitting: text("正在提交原压缩动作…", "Submitting original compression action…"),
    admitted: text("原压缩动作已返回。尚未据此确认压缩完成；请以会话中的后续真实证据为准。", "The original action returned. This does not confirm compression completion; use subsequent actual session evidence."),
    modelMissing: text("尚未选择可用模型。仍可只读查看，确认执行暂不可用。", "No available model is selected. The preview remains readable; execution confirmation is unavailable."),
    busy: text("会话正在执行。可只读查看，执行结束后请重新读取再确认。", "The session is executing. You can inspect it; read again after execution before confirming."),
    unknown: text("未知", "Unknown"), cost: text("会话累计费用", "Session cumulative cost"),
    sampledUsage: text("该次已确认用量 / 该次模型上限", "Confirmed sample usage / its model limit"),
    tokens: text("该次记录的 token 合计", "Sample token total"),
  }
}

export function contextServerLabel(url: string) {
  try { return new URL(url).origin } catch { return "—" }
}
