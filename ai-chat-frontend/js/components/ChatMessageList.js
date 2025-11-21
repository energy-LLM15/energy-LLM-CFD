// js/components/ChatMessageList.js
//
// 目的：
// 1) 移除与旧编排后端（fill/validate/apply 等意图流）的所有依赖与 UI。
// 2) 保留通用的消息渲染、附件下载、流式指示。
//
import { renderMarkdown } from "../utils/markdown.js";
import { formatFileSize } from "../utils/files.js";

const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit"
});

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatTime(timestamp) {
  if (!timestamp) return "";
  return timeFormatter.format(new Date(timestamp));
}

export class ChatMessageList {
  constructor(root, stateManager) {
    this.root = root;
    this.stateManager = stateManager;
    this.scroller = this.root;
    this.chatHost = this.root.closest(".chat");
	this.handleActionClick = this.handleActionClick.bind(this);
    this.root.addEventListener("click", this.handleActionClick);
    this.unsubscribe = this.stateManager.subscribe((state) => this.render(state));
  }
  
  handleActionClick(event) {
    const button = event.target.closest("[data-action=apply-defaults]");
    if (!button) return;
    const messageId = button.getAttribute("data-message-id");
    if (!messageId) return;

    const detail = { messageId };
    window.dispatchEvent(new CustomEvent("ally:apply-defaults", { detail }));
  }

  render(state) {
    const { conversations, activeConversationId } = state;
    const conversation =
      conversations.find((item) => item.id === activeConversationId) ?? null;

    const isEmpty = !conversation || conversation.messages.length === 0;
    this.root.classList.toggle("chat__messages--empty", isEmpty);
    if (this.chatHost) {
      this.chatHost.classList.toggle("chat--empty", isEmpty);
    }

    if (isEmpty) {
      this.renderEmpty();
      return;
    }

    this.root.innerHTML = "";
    const fragment = document.createDocumentFragment();
    conversation.messages.forEach((message) => {
      fragment.appendChild(this.createMessage(message));
    });
    this.root.appendChild(fragment);
    this.scrollToBottom();
  }

  createMessage(message) {
    const article = document.createElement("article");
    article.className = `message message--${message.role}`;
    if (message.role === "assistant" && message.streaming) {
      article.dataset.streaming = "true";
    }

    const avatar = document.createElement("span");
    avatar.className = "message__avatar";
    avatar.textContent = message.role === "assistant" ? "AI" : "我";

    const bubble = document.createElement("div");
    bubble.className = "message__bubble";
    if (message.meta?.isError) {
      bubble.classList.add("message__bubble--error");
    }

	// --- 附件（用户侧上传 .msh 网格等）
    if (Array.isArray(message.attachments) && message.attachments.length > 0) {
      const attachments = document.createElement("div");
      attachments.className = "message__attachments";

      message.attachments.forEach((attachment) => {
        const link = document.createElement("a");
        link.className = "message__attachment";
        link.innerHTML = `
          <span class="message__attachment-icon" aria-hidden="true">📎</span>
          <span class="message__attachment-name">${escapeHtml(attachment.name)}</span>
          <span class="message__attachment-size">${formatFileSize(attachment.size)}</span>
        `;
        link.title = attachment.name;
        if (attachment.url) {
          link.href = attachment.url;
          link.target = "_blank";
          link.rel = "noreferrer noopener";
          link.download = attachment.name;
        } else {
          link.href = "#";
          link.setAttribute("aria-disabled", "true");
        }
        attachments.appendChild(link);
      });

      bubble.appendChild(attachments);
    }

    // --- 正文（支持 Markdown）
    const content = document.createElement("div");
    content.className = "message__content";
    content.innerHTML = renderMarkdown(message.content || "");
    bubble.appendChild(content);
	
	const physicalPanel = this.createPhysicalPanel(message.id, message.meta || {});
    if (physicalPanel) bubble.appendChild(physicalPanel);

    // --- 新增：Foam-Agent 结果/状态面板（根据 message.meta 渲染）
    const resultPanel = this.createResultPanel(message.meta || {});
    if (resultPanel) bubble.appendChild(resultPanel);

    // --- 底部时间 + 流式指示
    const meta = document.createElement("div");
    meta.className = "message__meta";
    meta.textContent = formatTime(message.updatedAt ?? message.createdAt);

    if (message.role === "assistant" && message.streaming) {
      const indicator = document.createElement("div");
      indicator.className = "message__indicator";
      indicator.innerHTML =
        '<span class="message__indicator-dots"><i></i></span><span class="message__indicator-text">正在生成</span>';
      meta.appendChild(indicator);
    }

    const body = document.createElement("div");
    body.className = "message__body";
    body.appendChild(bubble);
    body.appendChild(meta);

    article.appendChild(avatar);
    article.appendChild(body);
    return article;
  }

  /**
   * 渲染 Foam-Agent 运行相关的结果/状态 UI：
   * - 下载结果 ZIP（meta.downloadUrl / meta.download.url / meta.resultUrl / meta.zipUrl）
   * - 任务 ID（meta.jobId / meta.job.id）
   * - 桥接状态与 OpenFOAM 目录（meta.bridge.status, meta.bridge.wm_project_dir）
   * - 可选日志/备注（meta.logText / meta.note）
   */
  
  createPhysicalPanel(messageId, meta) {
    const info = meta?.physicalCheck;
    if (!info || info.status !== "failed") return null;

    const missing = Array.isArray(info.missing)
      ? info.missing.map((item) => String(item).trim()).filter(Boolean)
      : [];
    const defaultsRaw = Array.isArray(info.defaults) ? info.defaults : [];
    const summary = typeof info.summary === "string" ? info.summary.trim() : "";
    const applyText = typeof info.applyText === "string" ? info.applyText.trim() : "";

    const defaults = defaultsRaw
      .map((entry) => {
        if (!entry) return null;
        if (typeof entry === "string") {
          const name = entry.trim();
          return name ? { name, value: "", note: "" } : null;
        }
        if (typeof entry !== "object") return null;
        const name = [entry.name, entry.label, entry.field, entry.key]
          .map((value) => (typeof value === "string" ? value.trim() : ""))
          .find((value) => !!value) || "";
        let value = "";
        if (typeof entry.value === "string") value = entry.value.trim();
        else if (typeof entry.value === "number" || typeof entry.value === "boolean") value = String(entry.value);
        else if (typeof entry.default === "string") value = entry.default.trim();
        else if (entry.default && typeof entry.default === "number") value = String(entry.default);
        const note = [entry.note, entry.reason, entry.description, entry.comment]
          .map((value) => (typeof value === "string" ? value.trim() : ""))
          .find((value) => !!value) || "";
        if (!name && !value && !note) return null;
        return { name, value, note };
      })
      .filter(Boolean);

    const wrapper = document.createElement("div");
    wrapper.className = "message__physical message__physical--failed";

    const header = document.createElement("div");
    header.className = "message__physical-header";

    const icon = document.createElement("span");
    icon.className = "message__physical-icon";
    icon.textContent = "🧪";

    const texts = document.createElement("div");
    texts.className = "message__physical-texts";

    const title = document.createElement("div");
    title.className = "message__physical-title";
    title.textContent = "Ally1.0 物理层检查未通过";

    const subtitle = document.createElement("div");
    subtitle.className = "message__physical-subtitle";
    subtitle.textContent = missing.length
      ? `缺少：${missing.join("、")}`
      : "请补充必需的物理量或采用建议默认值";

    texts.appendChild(title);
    texts.appendChild(subtitle);
    header.appendChild(icon);
    header.appendChild(texts);
    wrapper.appendChild(header);

    if (missing.length) {
      const chips = document.createElement("div");
      chips.className = "message__physical-missing";
      missing.forEach((item) => {
        const chip = document.createElement("span");
        chip.className = "message__physical-chip";
        chip.textContent = item;
        chips.appendChild(chip);
      });
      wrapper.appendChild(chips);
    }

    if (summary) {
      const note = document.createElement("p");
      note.className = "message__physical-note";
      note.textContent = summary;
      wrapper.appendChild(note);
    }

    if (defaults.length) {
      const defaultsWrap = document.createElement("div");
      defaultsWrap.className = "message__physical-defaults";

      const defaultsTitle = document.createElement("div");
      defaultsTitle.className = "message__physical-defaults-title";
      defaultsTitle.textContent = "建议默认值";
      defaultsWrap.appendChild(defaultsTitle);

      defaults.forEach((entry) => {
        const card = document.createElement("div");
        card.className = "message__physical-default";

        const name = document.createElement("div");
        name.className = "message__physical-default-name";
        name.textContent = entry.name || "默认参数";
        card.appendChild(name);

        if (entry.value) {
          const value = document.createElement("div");
          value.className = "message__physical-default-value";
          value.textContent = entry.value;
          card.appendChild(value);
        }

        if (entry.note) {
          const note = document.createElement("div");
          note.className = "message__physical-default-note";
          note.textContent = entry.note;
          card.appendChild(note);
        }

        defaultsWrap.appendChild(card);
      });

      wrapper.appendChild(defaultsWrap);
    }

    if (applyText) {
      const action = document.createElement("button");
      action.type = "button";
      action.className = "message__physical-action";
      action.dataset.action = "apply-defaults";
      action.dataset.messageId = messageId;
      action.textContent = "✨ 一键应用默认值";
      wrapper.appendChild(action);
    }

    return wrapper;
  } 
  
  createResultPanel(meta) {
    if (!meta || typeof meta !== "object") return null;

    const downloadUrl =
      meta.downloadUrl ||
      meta.resultUrl ||
      meta.zipUrl ||
      (meta.download && meta.download.url) ||
      "";
    const filename =
      meta.filename ||
      (meta.download && meta.download.filename) ||
      "result.zip";
    const jobId = meta.jobId || (meta.job && meta.job.id) || "";
    const bridgeStatus =
      (meta.bridge && meta.bridge.status) || meta.status || "";
    const wmProjectDir =
      (meta.bridge && meta.bridge.wm_project_dir) || meta.wm_project_dir || "";
    const note = meta.note || "";
    const logText = meta.logText || "";

    const needPanel =
      downloadUrl || jobId || bridgeStatus || wmProjectDir || note || logText;
    if (!needPanel) return null;

    const wrapper = document.createElement("div");
    wrapper.className = "message__result";

    // 上方信息行：状态 / OpenFOAM 目录 / 任务号
    const infoParts = [];
    if (bridgeStatus) infoParts.push(`状态：${bridgeStatus}`);
    if (wmProjectDir) infoParts.push(`OpenFOAM：${wmProjectDir}`);
    if (jobId) infoParts.push(`任务ID：${jobId}`);
    if (infoParts.length > 0) {
      const info = document.createElement("div");
      info.className = "message__result-info";
      info.textContent = infoParts.join(" · ");
      wrapper.appendChild(info);
    }

    // 下载按钮
    if (downloadUrl) {
      const dl = document.createElement("a");
      dl.className = "message__result-download";
      dl.href = downloadUrl;
      dl.target = "_blank";
      dl.rel = "noreferrer noopener";
      dl.textContent = filename ? `下载结果（${filename}）` : "下载结果";
      wrapper.appendChild(dl);
    }

    // 可折叠日志/备注
    if (note || logText) {
      const details = document.createElement("details");
      details.className = "message__result-details";
      const summary = document.createElement("summary");
      summary.textContent = "查看说明/日志";
      details.appendChild(summary);

      const body = document.createElement("div");
      const md = [];
      if (note) md.push(String(note));
      if (logText) md.push("```txt\n" + String(logText) + "\n```");
      body.innerHTML = renderMarkdown(md.join("\n\n"));
      details.appendChild(body);

      wrapper.appendChild(details);
    }

    return wrapper;
  }

  renderEmpty() {
    this.root.innerHTML = `
      <div class="empty-state">
        <span class="empty-state__badge">CFD 助手</span>
        <h2 class="empty-state__title">输入你的任何仿真需求（可中文），请去喝杯咖啡让我帮你 CFD 仿真</h2>
        <p class="empty-state__tips">
          例如：<br />
          <code>用 simpleFoam 做 3D 风洞内圆柱绕流，来流速度 10 m/s，比较 k–ε 与 k–ω 的差异</code>
        </p>
      </div>
    `;
    if (this.scroller) this.scroller.scrollTop = 0;
  }

  scrollToBottom() {
    requestAnimationFrame(() => {
      if (!this.scroller) return;
      const maxScroll = this.scroller.scrollHeight - this.scroller.clientHeight;
      this.scroller.scrollTop = maxScroll > 0 ? maxScroll : 0;
    });
  }

  destroy() {
    if (this.unsubscribe) this.unsubscribe();
	this.root.removeEventListener("click", this.handleActionClick);
  }
}
