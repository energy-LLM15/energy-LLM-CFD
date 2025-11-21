// js/utils/intentResponse.js
/**
 * 兼容旧接口：将任意后端响应规范化为 { summaryText, intent, meta } 结构。
 * - 新架构不再返回“intent JSON”，此处的 intent 固定为 null。
 * - summaryText 优先使用后端的 human_summary/summary/message 字段，否则兜底为固定提示。
 * - meta 中仅保留必要的 UI 字段，避免下游渲染报错。
 */
export function normalizeIntentResponse(response, options = {}) {
  const summaryRaw =
    (typeof response?.human_summary === "string" && response.human_summary.trim()) ||
    (typeof response?.summary === "string" && response.summary.trim()) ||
    (typeof response?.message === "string" && response.message.trim()) ||
    "";

  const summaryText = summaryRaw || "（任务已提交，等待结果…）";

  const pipelineStatus =
    (typeof response?.pipeline_status === "string" && response.pipeline_status) ||
    (response?.ok === true ? "ok" : "pending");

  const storageInfo =
    response && typeof response.storage === "object" && response.storage !== null && !Array.isArray(response.storage)
      ? response.storage
      : null;

  const userRequest = typeof options?.userRequest === "string" ? options.userRequest : null;
  const source = typeof options?.source === "string" ? options.source : null;

  const meta = {
    review: null,
    pipeline_status: pipelineStatus,
    defaults_overview: null,
    missing_parameters: null,
    intent_defaults: null,
    intent_control: {
      status: pipelineStatus === "ok" ? "pending" : "collecting",
      user_request: userRequest,
      source: source || null
    }
  };

  if (storageInfo && pipelineStatus === "ok") {
    const filename = typeof storageInfo.filename === "string" ? storageInfo.filename : null;
    meta.intent_control = {
      ...meta.intent_control,
      status: "applied",
      filename,
      storage_path: typeof storageInfo.path === "string" ? storageInfo.path : null,
      saved_at: typeof storageInfo.saved_at === "string" ? storageInfo.saved_at : null,
      auto_saved: true
    };
  }

  // 新流程不再返回“intent JSON”
  return {
    summaryText,
    intent: null,
    meta
  };
}
