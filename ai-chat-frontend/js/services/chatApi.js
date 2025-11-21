// js/services/chatApi.js
//
// 说明：前端与 FastAPI 对齐 —— /run 使用 requirement 字段；/status 统一出 status；
// 并将 422 的 detail 数组转成可读错误文本，避免 [object Object]。
//
// 导出：
// - bridgeHealth()
// - physicalLayerCheck(zhText, { signal? })
// - translateToEnglish(zhText, modelId?, { signal? })
// - runFoamAgent(opts)
// - pollJob(jobId, { signal? })
// - downloadZipUrl(jobId)
// - （底层能力）getJobStatus, downloadResultZip, createChatCompletion


import { BRIDGE_API, getModelConfig } from "../config/modelPresets.js";

/* -------------------- 工具：错误与基础 HTTP -------------------- */

/** 把 FastAPI 的 ValidationError(detail) 或普通错误转成可读字符串 */
function stringifyFastApiError(data, res) {
  // detail: [{loc: [...], msg: "...", type: "..."}]
  if (Array.isArray(data?.detail) && data.detail.length) {
    return data.detail
      .map((e) => {
        const loc = Array.isArray(e?.loc) ? e.loc.join(".") : "";
        const msg = e?.msg || e?.type || "validation error";
        return loc ? `${loc}: ${msg}` : msg;
      })
      .join("; ");
  }
  if (typeof data?.detail === "string") return data.detail;
  if (typeof data?.message === "string") return data.message;
  const code = res?.status ? `${res.status} ${res.statusText || ""}`.trim() : "";
  return code || "Request failed";
}

/** fetch JSON：容错解析 + 统一错误信息 */
async function fetchJSON(url, init) {
  const res = await fetch(url, init);
  let raw = null;
  try {
    raw = await res.text();
  } catch (_) {
    /* ignore */
  }

  let data = null;
  if (raw && raw.length) {
    try {
      data = JSON.parse(raw);
    } catch {
      // 后端偶发返回非 JSON；保留 raw 以便定位
      data = null;
    }
  }

  if (!res.ok) {
    throw new Error(stringifyFastApiError(data, res));
  }
  return data;
}

function extractJsonPayload(raw) {
  if (!raw || typeof raw !== "string") return null;
  const candidates = [];
  const codeMatch = raw.match(/```json([\s\S]*?)```/i);
  if (codeMatch && codeMatch[1]) {
    candidates.push(codeMatch[1]);
  }
  const trimmed = raw.trim();
  if (trimmed) {
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
    }
    candidates.push(trimmed);
  }

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch (_) {
      continue;
    }
  }
  return null;
}

function normalizeMissingEntries(raw) {
  const source = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const result = [];
  source.forEach((item) => {
    if (!item) return;
    if (typeof item === "string") {
      const text = item.trim();
      if (text) result.push(text);
      return;
    }
    if (typeof item === "object") {
      const label = [item.label, item.name, item.field, item.key, item.id]
        .map((v) => (typeof v === "string" ? v.trim() : ""))
        .find((v) => !!v);
      const detail = [item.detail, item.reason, item.description, item.note, item.hint, item.requirement]
        .map((v) => (typeof v === "string" ? v.trim() : ""))
        .find((v) => !!v);

      let text = label || "";
      if (detail) {
        text = text ? `${text}（${detail}）` : detail;
      }

      if (!text) {
        const fallback = Object.values(item)
          .map((v) => (typeof v === "string" ? v.trim() : ""))
          .filter(Boolean)
          .join(" · ");
        text = fallback;
      }

      if (text) result.push(text);
    }
  });
  return Array.from(new Set(result));
}

function normalizeDefaultEntries(raw) {
  let source = [];
  if (Array.isArray(raw)) {
    source = raw;
  } else if (raw && typeof raw === "object") {
    source = Object.entries(raw).map(([key, value]) => ({ name: key, value }));
  }

  const result = [];
  source.forEach((item) => {
    if (!item) return;
    if (typeof item === "string") {
      const text = item.trim();
      if (text) {
        result.push({ name: text, value: "", note: "" });
      }
      return;
    }
    if (typeof item !== "object") return;

    const name = [item.name, item.label, item.field, item.key, item.id]
      .map((v) => (typeof v === "string" ? v.trim() : ""))
      .find((v) => !!v) || "";

    const valueCandidate = [item.value, item.default, item.suggested, item.example, item.recommended]
      .find((v) => v !== undefined && v !== null);

    let value = "";
    if (typeof valueCandidate === "string") {
      value = valueCandidate.trim();
    } else if (typeof valueCandidate === "number" || typeof valueCandidate === "boolean") {
      value = String(valueCandidate);
    } else if (valueCandidate && typeof valueCandidate === "object") {
      try {
        value = JSON.stringify(valueCandidate);
      } catch (_) {
        value = "";
      }
    }

    const note = [item.note, item.reason, item.description, item.comment, item.unit]
      .map((v) => (typeof v === "string" ? v.trim() : ""))
      .find((v) => !!v) || "";

    if (!name && !value && !note) return;
    result.push({ name, value, note });
  });

  return result;
}

/* -------------------- FastAPI 桥接：健康/提交/状态/下载 -------------------- */

/** GET /health */
export async function bridgeHealth() {
  const url = `${BRIDGE_API.baseUrl}${BRIDGE_API.paths.health}`;
  return fetchJSON(url);
}

/**
 * POST /run
 * 写入 user_requirement.txt 并启动 Foam-Agent 主流程
 * @param {object} opts
 *  - prompt {string}   英文需求（必填）
 *  - case_name {string} 任务别名（可选）
 *  - meshFile {File}   可选：用户上传的 .msh 网格文件
 * @return {Promise<{job_id:string}>}
 */
export async function runFoamAgent(opts) {
  const { prompt, case_name, meshFile } = opts || {};
  if (!prompt || !prompt.trim()) {
    throw new Error("runFoamAgent: 缺少英文需求 prompt。");
  }

  const url = `${BRIDGE_API.baseUrl}${BRIDGE_API.paths.run}`;
  const form = new FormData();
  form.append("requirement", prompt.trim());
  if (case_name && String(case_name).trim()) {
    form.append("case_name", String(case_name).trim());
  }

  if (meshFile && typeof meshFile === "object") {
    const filename = typeof meshFile.name === "string" && meshFile.name ? meshFile.name : "mesh.msh";
    try {
      form.append("mesh", meshFile, filename);
    } catch (_) {
      form.append("mesh", meshFile);
    }
  }

  return fetchJSON(url, {
    method: "POST",
	body: form
  });
}

/**
 * GET /status/{job_id}
 * 后端返回 { state: running|finished|failed, returncode, log_tail, zip, ... }
 * 这里统一映射为 { status: queued|running|succeeded|failed, message?, downloadUrl? }
 */
export async function getJobStatus(jobId, options = {}) {
  if (!jobId) throw new Error("getJobStatus: 缺少 jobId。");
  const url = `${BRIDGE_API.baseUrl}${BRIDGE_API.paths.status}/${encodeURIComponent(jobId)}`;
  const data = await fetchJSON(url, { signal: options.signal });

  // 映射
  const map = { running: "running", finished: "succeeded", failed: "failed", queued: "queued" };
  const status = data?.status || map[data?.state] || "running";

  // 从日志尾部提取最后一行非空文本，作为 message
  let message = "";
  if (typeof data?.log_tail === "string" && data.log_tail.length) {
    const parts = data.log_tail.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    message = parts[parts.length - 1] || "";
  }
  if (!message && typeof data?.error === "string" && data.error.trim()) {
    message = data.error.trim();
  }

  // 如果后端已生成 zip 绝对路径，前端仍然拼自己的 /download/{job_id}
  const downloadUrl = (status === "succeeded") ? downloadZipUrl(jobId) : null;

  return { ...data, status, message, downloadUrl };
}

/**
 * GET /download/{job_id} -> Blob
 */
export async function downloadResultZip(jobId) {
  if (!jobId) throw new Error("downloadResultZip: 缺少 jobId。");
  const url = `${BRIDGE_API.baseUrl}${BRIDGE_API.paths.download}/${encodeURIComponent(jobId)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

  const blob = await res.blob();
  const cd = res.headers.get("Content-Disposition") || "";
  const m = cd.match(/filename="?([^"]+)"?/i);
  const filename = m?.[1] || `foam-agent-${jobId}.zip`;
  return { blob, filename };
}

/** 仅拼出下载链接（供前端展示为 <a href>） */
export function downloadZipUrl(jobId) {
  if (!jobId) throw new Error("downloadZipUrl: 缺少 jobId。");
  return `${BRIDGE_API.baseUrl}${BRIDGE_API.paths.download}/${encodeURIComponent(jobId)}`;
}

/* -------------------- Ally1.0 物理层检查 & 翻译 -------------------- */

function pickSummaryText(payload) {
  if (!payload || typeof payload !== "object") return "";
  const candidates = [payload.summary, payload.message, payload.note, payload.explanation, payload.comment];
  for (const item of candidates) {
    if (typeof item === "string" && item.trim()) return item.trim();
  }
  return "";
}

function pickApplyText(payload) {
  if (!payload || typeof payload !== "object") return "";
  const candidates = [payload.completed_request, payload.completion, payload.suggested_prompt, payload.rewritten_request];
  for (const item of candidates) {
    if (typeof item === "string" && item.trim()) return item.trim();
  }
  return "";
}

function resolvePassFlag(payload, missingList) {
  if (!payload || typeof payload !== "object") {
    return missingList.length === 0;
  }

  if (typeof payload.passed === "boolean") return payload.passed;
  if (typeof payload.passed === "number") return payload.passed > 0;
  if (typeof payload.passed === "string") {
    const flag = payload.passed.toLowerCase();
    if (/true|pass|ok|success/.test(flag)) return true;
    if (/false|fail|error/.test(flag)) return false;
  }
  if (typeof payload.ok === "boolean") return payload.ok;
  if (typeof payload.ok === "number") return payload.ok > 0;
  if (typeof payload.ok === "string") {
    const flag = payload.ok.toLowerCase();
    if (/true|pass|ok|success/.test(flag)) return true;
    if (/false|fail|error/.test(flag)) return false;
  }
  if (typeof payload.success === "boolean") return payload.success;
  if (typeof payload.success === "number") return payload.success > 0;
  if (typeof payload.success === "string") {
    const flag = payload.success.toLowerCase();
    if (/true|pass|ok|success/.test(flag)) return true;
    if (/false|fail|error/.test(flag)) return false;
  }

  const status = typeof payload.status === "string" ? payload.status.toLowerCase() : "";
  if (status.includes("fail")) return false;
  if (status.includes("pass") || status.includes("success") || status.includes("ok")) return true;

  return missingList.length === 0;
}

export async function physicalLayerCheck(zhText, options = {}) {
  const base = { passed: true, missing: [], defaults: [], summary: "", applyText: "", draft: null, raw: "", reasoning: "" };
  if (!zhText || !zhText.trim()) return base;

  const messages = [
    {
      role: "system",
      content: [
        "你是 Ally1.0，一名 CFD 物理层检查助手。",
        "请阅读用户的中文需求，识别是否写明了必要的物理量：流体介质、流动工况（稳态/瞬态、层流/湍流等）、速度或雷诺数、特征尺度或尺寸、边界条件、目标输出。",
        "必须仅以严格 JSON 作答，包含字段：passed（布尔）、missing（字符串数组）、defaults（[{name,value,note?}]）、summary（字符串）、completed_request（字符串，表示套用默认值后的完整需求）、draft（对象，可用于内部参数草稿）。",
        "如果缺少关键物理量，请在 missing 中列出缺失项，并在 defaults 中给出合理的默认值建议。",
        "除 JSON 结构外，所有可读文本（如 missing、defaults.name/value/note、summary、completed_request 等）务必使用简体中文描述，不要出现英文。"
      ].join(" ")
    },
    { role: "user", content: zhText }
  ];

  const { content, reasoning } = await createChatCompletion("ally-1-0-reasoner", messages, options);
  const payload = extractJsonPayload(content) || {};
  const missing = normalizeMissingEntries(payload.missing || payload.missing_fields || payload.missingItems);
  const defaults = normalizeDefaultEntries(payload.defaults || payload.default_values || payload.suggested_defaults);
  const summary = pickSummaryText(payload);
  const applyText = pickApplyText(payload);
  const draft = payload.draft || payload.parameters || null;
  const passed = resolvePassFlag(payload, missing);

  return {
    passed,
    missing,
    defaults,
    summary,
    applyText,
    draft,
    raw: content,
    reasoning: reasoning || ""
  };
}

/**
 * 把中文需求翻译为英文（用于写入 user_requirement.txt）
 * @param {string} zhText 中文文本
 * @param {string} modelId 例如 "ally-1-0"
 * @returns {Promise<string>}
 */
export async function translateToEnglish(zhText, modelId = "ally-1-0", options = {}) {
  if (!zhText || !zhText.trim()) return "";
  const messages = [
    {
      role: "system",
      content:
        "You are a professional technical translator. Translate the user input into concise, clear English for CFD simulation requirements. Preserve numbers, units, symbols, file/solver names. Output English only."
    },
    { role: "user", content: zhText }
  ];
  const { content } = await createChatCompletion(modelId, messages, options);
  return content || "";
}

/** pollJob：薄封装 */
export async function pollJob(jobId, options = {}) {
  return getJobStatus(jobId, options);
}


function normalizeUrl(baseUrl, path) {
  const trimmedBase = baseUrl.replace(/\/+$/, "");
  const trimmedPath = path.startsWith("/") ? path : `/${path}`;
  return `${trimmedBase}${trimmedPath}`;
}

function buildHeaders(requestConfig) {

  const runtimeKey =
    (typeof window !== "undefined" &&
      (window.DEEPSEEK_API_KEY || localStorage.getItem("deepseek_api_key"))) ||
    "";
  const apiKey = requestConfig.apiKey || runtimeKey;
  if (!apiKey) {
    throw new Error(
      "缺少 DeepSeek API Key。请在控制台设置 window.DEEPSEEK_API_KEY='sk-***' 或 localStorage.setItem('deepseek_api_key','sk-***')"
    );
  }
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    ...(requestConfig.headers ?? {})
  };
}

function sanitizeParams(params = {}) {
  const result = {};
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) result[k] = v;
  });
  return result;
}

/**
 *
 * @returns {Promise<{content:string, reasoning:string}>}
 */
export async function createChatCompletion(modelId, messages, options = {}) {
  const preset = getModelConfig(modelId);
  if (!preset) {
    throw new Error(`未找到模型 ${modelId} 的配置，请检查 js/config/modelPresets.js。`);
  }
  const cfg = preset.request;
  if (!cfg?.baseUrl || !cfg?.path || !cfg?.model) {
    throw new Error(`${preset.label} 缺少 baseUrl/path/model 配置。`);
  }

  const url = normalizeUrl(cfg.baseUrl, cfg.path);
  const payload = {
    model: cfg.model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    stream: false,
    ...sanitizeParams(cfg.params)
  };
  const headers = buildHeaders(cfg);

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: options.signal
  });

  const raw = await resp.text();
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    /* ignore */
  }

  if (!resp.ok) {
    const msg = data?.error?.message || `${resp.status} ${resp.statusText}`;
    throw new Error(msg);
  }

  const choice = Array.isArray(data?.choices) ? data.choices[0] : null;
  const message = choice?.message ?? {};
  const content =
    typeof message?.content === "string"
      ? message.content.trim()
      : data?.output ?? "";
  const reasoning =
    typeof message?.reasoning_content === "string"
      ? message.reasoning_content.trim()
      : data?.reasoning ?? "";

  return { content, reasoning };
}
