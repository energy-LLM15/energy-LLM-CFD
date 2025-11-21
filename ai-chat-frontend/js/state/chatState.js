// js/state/chatState.js
// 仅保留对话/主题/流式状态/附件等基础能力；彻底移除旧“填意图/模型补全”相关逻辑。

const emitter = new EventTarget();

// 避免 UI 中涉模型的组件报错（如果你不再展示模型下拉，也可将 models 设为空数组）
const DEFAULT_MODEL_ID = "ally-1-0";

const state = {
  models: [{ id: DEFAULT_MODEL_ID, label: "Ally1.0" }],
  conversations: [],
  activeConversationId: null,
  isStreaming: false,         // 这里表示“有任务在发起/轮询中”
  theme: "dark",
  selectedModelId: DEFAULT_MODEL_ID,
  dimensionMode: "3D"        // 若暂不用可忽略，保留不影响
};

let idCounter = 0;
const attachmentUrlRegistry = new Set();

/* ---------------------- 小工具函数 ---------------------- */

function generateId(prefix) {
  const unique = `${Date.now().toString(36)}-${(++idCounter).toString(36)}`;
  return `${prefix}-${unique}`;
}

function safeRevokeObjectUrl(url) {
  if (!url || typeof URL?.revokeObjectURL !== "function") return;
  try { URL.revokeObjectURL(url); } catch {}
}

function registerAttachmentUrls(attachments) {
  attachments.forEach((a) => a?.url && attachmentUrlRegistry.add(a.url));
}

function releaseAttachmentUrls(conversation) {
  if (!conversation?.messages) return;
  conversation.messages.forEach((msg) => {
    (msg.attachments ?? []).forEach((att) => {
      if (att?.url && attachmentUrlRegistry.has(att.url)) {
        safeRevokeObjectUrl(att.url);
        attachmentUrlRegistry.delete(att.url);
      }
    });
  });
}

function normalizeAttachment(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = (raw.name || "未命名附件").replace(/[\r\n]+/g, " ");
  const size = Number.isFinite(+raw.size) && +raw.size > 0 ? +raw.size : 0;
  const type = typeof raw.type === "string" ? raw.type.trim() : "";
  const url = typeof raw.url === "string" ? raw.url : "";
  const id = typeof raw.id === "string" && raw.id.trim()
    ? raw.id
    : generateId("file");
  return { id, name, size, type, url };
}

function getActiveConversationInternal() {
  return state.conversations.find((x) => x.id === state.activeConversationId) ?? null;
}

function sortConversations() {
  state.conversations.sort((a, b) => {
    const at = a.updatedAt ?? a.createdAt;
    const bt = b.updatedAt ?? b.createdAt;
    return new Date(bt).getTime() - new Date(at).getTime();
  });
}

function getSnapshot() {
  return JSON.parse(JSON.stringify(state));
}

function findMessageById(messageId) {
  if (!messageId) return { conversation: null, message: null };
  for (const c of state.conversations) {
    const m = c.messages.find((x) => x.id === messageId) ?? null;
    if (m) return { conversation: c, message: m };
  }
  return { conversation: null, message: null };
}

function applyMetaPatch(message, patch) {
  if (!patch || typeof patch !== "object") return false;
  const base = { ...(message.meta ?? {}) };
  let changed = false;

  Object.entries(patch).forEach(([key, value]) => {
    if (value === undefined) return;
    if (value === null) {
      if (key in base) {
        delete base[key];
        changed = true;
      }
      return;
    }

    const current = base[key];
    if (
      value && typeof value === "object" && !Array.isArray(value) &&
      current && typeof current === "object" && !Array.isArray(current)
    ) {
      const merged = { ...current, ...value };
      const currentJson = JSON.stringify(current);
      const mergedJson = JSON.stringify(merged);
      if (currentJson !== mergedJson) {
        base[key] = merged;
        changed = true;
      }
    } else if (current !== value) {
      base[key] = value;
      changed = true;
    }
  });

  if (!changed) return false;
  const keys = Object.keys(base);
  message.meta = keys.length > 0 ? base : null;
  return true;
}

function emit() {
  sortConversations();
  emitter.dispatchEvent(new CustomEvent("change", { detail: getSnapshot() }));
}

function createSeedConversation() {
  const now = new Date().toISOString();
  return {
    id: generateId("conv"),
    title: "新的对话",
    model: DEFAULT_MODEL_ID,
    createdAt: now,
    updatedAt: now,
    messages: [],
    ended: false
  };
}


export const chatState = {
  init() {
    if (state.conversations.length === 0) {
      const c = createSeedConversation();
      state.conversations.push(c);
      state.activeConversationId = c.id;
    }
    emit();
  },
  subscribe(cb) {
    const h = (e) => cb(e.detail);
    emitter.addEventListener("change", h);
    cb(getSnapshot());
    return () => emitter.removeEventListener("change", h);
  },
  getState() { return getSnapshot(); },
  getActiveConversation() { return getActiveConversationInternal(); },

  setStreaming(isStreaming) {
    const v = !!isStreaming;
    if (state.isStreaming !== v) {
      state.isStreaming = v;
      emit();
    }
  },

  setDimensionMode(mode) {
    const m = mode === "2D_extruded" ? "2D_extruded" : "3D";
    if (state.dimensionMode !== m) {
      state.dimensionMode = m;
      emit();
    }
  },

  createConversation() {
    const now = new Date().toISOString();
    const c = {
      id: generateId("conv"),
      title: "新的对话",
      model: DEFAULT_MODEL_ID,
      createdAt: now,
      updatedAt: now,
      messages: [],
      ended: false
    };
    state.conversations.unshift(c);
    state.activeConversationId = c.id;
    emit();
    return c;
  },

  setActiveConversation(conversationId) {
    if (conversationId === state.activeConversationId) return;
    const conv = state.conversations.find((x) => x.id === conversationId);
    if (!conv) return;
    conv.model = DEFAULT_MODEL_ID;
    state.activeConversationId = conv.id;
    state.selectedModelId = DEFAULT_MODEL_ID;
    emit();
  },

  deleteConversation(conversationId) {
    const idx = state.conversations.findIndex((x) => x.id === conversationId);
    if (idx === -1) return;
    const [removed] = state.conversations.splice(idx, 1);
    releaseAttachmentUrls(removed);
    const wasActive = removed?.id === state.activeConversationId;

    if (wasActive) {
      state.isStreaming = false;

      const fallback =
        state.conversations[idx] ??
        state.conversations[idx - 1] ??
        state.conversations[0] ?? null;

      if (fallback) {
        fallback.model = DEFAULT_MODEL_ID;
        state.activeConversationId = fallback.id;
        state.selectedModelId = DEFAULT_MODEL_ID;
      } else {
        state.activeConversationId = null;
        state.selectedModelId = DEFAULT_MODEL_ID;
      }
    }
    emit();
  },

  // 兼容旧 UI
  setConversationModel() {
    const conv = getActiveConversationInternal();
    if (conv && conv.model !== DEFAULT_MODEL_ID) {
      conv.model = DEFAULT_MODEL_ID;
      conv.updatedAt = new Date().toISOString();
      emit();
    }
  },

  sendUserMessage(payload) {
    if (state.isStreaming) return;

    const input = typeof payload === "string" ? { text: payload } : (payload ?? {});
    const text = typeof input.text === "string" ? input.text : "";
    const content = text.trim();
    const attachments = Array.isArray(input.attachments)
      ? input.attachments.map(normalizeAttachment).filter(Boolean)
      : [];

    if (!content && attachments.length === 0) return;

    let conv = getActiveConversationInternal() || this.createConversation();
    if (conv.ended) return;

    const ts = new Date().toISOString();
    const userMessage = {
      id: generateId("msg"),
      role: "user",
      content,
      createdAt: ts,
      streaming: false,
      attachments,
      meta: input.meta ?? null
    };
    registerAttachmentUrls(attachments);

    conv.messages.push(userMessage);
    conv.updatedAt = ts;

    if (!conv.title || conv.title === "新的对话") {
      const previewSrc = content || attachments[0]?.name || "新的对话";
      const preview = previewSrc.slice(0, 22);
      conv.title = previewSrc.length > 22 ? `${preview}…` : preview;
    }

    // 启动“占位的助手消息”可选；这里交给 ChatInput 在流程节点插入消息
    emit();
  },

  toggleTheme() {
    state.theme = state.theme === "dark" ? "light" : "dark";
    emit();
  },
  setTheme(theme) {
    if (theme !== "dark" && theme !== "light") return;
    state.theme = theme;
    emit();
  },

  patchMessageMeta(messageId, patch) {
    const { conversation, message } = findMessageById(messageId);
    if (!conversation || !message) return;
    if (!applyMetaPatch(message, patch)) return;
    const ts = new Date().toISOString();
    message.updatedAt = ts;
    conversation.updatedAt = ts;
    emit();
  },

  patchMessage(messageId, patch = {}) {
    const { conversation, message } = findMessageById(messageId);
    if (!conversation || !message) return;

    let changed = false;

    if (Object.prototype.hasOwnProperty.call(patch, "content")) {
      const nextContent =
        patch.content === null || patch.content === undefined
          ? ""
          : String(patch.content);
      if (message.content !== nextContent) {
        message.content = nextContent;
        changed = true;
      }
	}

    if (Object.prototype.hasOwnProperty.call(patch, "streaming")) {
      const nextStreaming = !!patch.streaming;
      if (message.streaming !== nextStreaming) {
        message.streaming = nextStreaming;
        changed = true;
      }
    }

    if (patch.meta !== undefined) {
      if (applyMetaPatch(message, patch.meta)) {
        changed = true;
      }
    }

    if (!changed) return;
    const ts = new Date().toISOString();
    message.updatedAt = ts;
    conversation.updatedAt = ts;
    emit();
  },

  endConversationByMessageId(messageId) {
    const { conversation } = findMessageById(messageId);
    if (!conversation || conversation.ended) return;
    conversation.ended = true;
    conversation.updatedAt = new Date().toISOString();
    if (state.activeConversationId === conversation.id) state.isStreaming = false;
    emit();
  }
};

/* --------- 对外的便捷函数，供其它组件使用 --------- */

export function pushUserMessage(payload) {
  const input = typeof payload === "string" ? { text: payload } : (payload ?? {});
  const text = typeof input.text === "string" ? input.text : "";
  const content = text.trim();
  const attachments = Array.isArray(input.attachments)
    ? input.attachments.map(normalizeAttachment).filter(Boolean)
    : [];
  if (!content && attachments.length === 0) return null;

  let conv = chatState.getActiveConversation() || chatState.createConversation();
  if (conv.ended) return null;

  const ts = new Date().toISOString();
  const msg = {
    id: generateId("msg"),
    role: "user",
    content,
    createdAt: ts,
    updatedAt: ts,
    streaming: false,
    attachments,
    meta: input.meta ?? null
  };
  registerAttachmentUrls(attachments);
  conv.messages.push(msg);
  conv.updatedAt = ts;

  if (!conv.title || conv.title === "新的对话") {
    const previewSrc = content || attachments[0]?.name || "新的对话";
    const preview = previewSrc.slice(0, 22);
    conv.title = previewSrc.length > 22 ? `${preview}…` : preview;
  }

  // 触发渲染
  const event = new CustomEvent("change", { detail: getSnapshot() });
  emitter.dispatchEvent(event);
  return msg;
}

export function pushAssistantSummary(text, intentJson = null, options = {}) {
  const conv = chatState.getActiveConversation() || chatState.createConversation();
  const ts = new Date().toISOString();
  const streaming = options.streaming === true;
  const message = {
    id: generateId("msg"),
    role: "assistant",
    content: (typeof text === "string" ? text : String(text ?? "")).trimEnd(),
    createdAt: ts,
    updatedAt: ts,
	streaming,
    attachments: [],
    meta: intentJson ? { ...(options.meta ?? {}), intent: intentJson } : (options.meta ?? null)
  };
  conv.messages.push(message);
  conv.updatedAt = ts;

  const event = new CustomEvent("change", { detail: getSnapshot() });
  emitter.dispatchEvent(event);
  return message;
}

export function setStreaming(isStreaming) {
  chatState.setStreaming(isStreaming);
}

export function patchMessage(messageId, patch) {
  chatState.patchMessage(messageId, patch);
}

export function patchMessageMeta(messageId, patch) {
  chatState.patchMessageMeta(messageId, patch);
}

export function getModelOptions() {
  // 仅保留一个项，避免旧头部组件报错
  return state.models.map((x) => ({ ...x }));
}
