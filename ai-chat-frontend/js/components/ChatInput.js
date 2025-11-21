// js/components/ChatInput.js

import {
  chatState,
  pushAssistantSummary,
  pushUserMessage,
  setStreaming,
  patchMessage
} from "../state/chatState.js";

import { icons } from "../utils/icons.js";
import { formatFileSize } from "../utils/files.js";

// 注意：这些函数需已在 js/services/chatApi.js 中实现
import {
  bridgeHealth,
  physicalLayerCheck,
  translateToEnglish,
  runFoamAgent,
  pollJob,
  downloadZipUrl
} from "../services/chatApi.js";

export class ChatInput {
  constructor(root) {
    this.root = root;
    this.renderBase();

    this.form = this.root.querySelector("[data-role=input-form]");
    this.textarea = this.root.querySelector(".chat-input__textarea");
    this.submitButton = this.root.querySelector(".chat-input__submit");
    this.submitLabel = this.root.querySelector("[data-role=submit-label]");
    this.submitSpinner = this.root.querySelector("[data-role=submit-spinner]");
    this.statusEl = this.root.querySelector("[data-role=input-status]");
    this.attachButton = this.root.querySelector("[data-action=attach-file]");
    this.fileInput = this.root.querySelector("[data-role=file-input]");
    this.attachmentList = this.root.querySelector("[data-role=attachment-list]");
    this.toolbarButton = document.querySelector("[data-action=generate-settings]");
    this.toolbarLabel = this.toolbarButton?.querySelector("[data-role=toolbar-label]") ?? null;
    this.toolbarSpinner = this.toolbarButton?.querySelector("[data-role=toolbar-spinner]") ?? null;

    // 停止按钮 & 控制器/轮询器
    this.cancelButton = this.root.querySelector("[data-role=cancel-button]");
    this.activeController = null;
    this.pollTimer = null;
    this.activeJobId = null;
	this.logMessageId = null;
    this.lastLogText = "";
    this.lastLogStatus = "";
    this.lastLogNote = "";
    this.lastLogStreaming = null;
	this.physicalCheckMessageId = null;
    this.physicalCheckTicker = null;
    this.physicalCheckFrames = ["⏳", "🌀", "🔄", "🧠"];
    this.physicalCheckFrameIndex = 0;

    this.attachments = [];
    this.lastConversationId = null;

    this.handleSubmit = this.handleSubmit.bind(this);
    this.handleInput = this.handleInput.bind(this);
    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleAttachClick = this.handleAttachClick.bind(this);
    this.handleFileChange = this.handleFileChange.bind(this);
    this.handleAttachmentRemove = this.handleAttachmentRemove.bind(this);
    this.handleGenerateClick = this.handleGenerateClick.bind(this);
    this.handleCancel = this.handleCancel.bind(this);
	this.handleApplyDefaults = this.handleApplyDefaults.bind(this);

    this.form.addEventListener("submit", this.handleSubmit);
    this.textarea.addEventListener("input", this.handleInput);
    this.textarea.addEventListener("keydown", this.handleKeyDown);
    this.attachButton.addEventListener("click", this.handleAttachClick);
    this.fileInput.addEventListener("change", this.handleFileChange);
    this.attachmentList.addEventListener("click", this.handleAttachmentRemove);
    if (this.toolbarButton) this.toolbarButton.addEventListener("click", this.handleGenerateClick);
    if (this.cancelButton) this.cancelButton.addEventListener("click", this.handleCancel);
	window.addEventListener("ally:apply-defaults", this.handleApplyDefaults);

    this.autoResize();
    this.unsubscribe = chatState.subscribe((state) => this.render(state));

    // 可选：启动时探测桥健康状况
    bridgeHealth().catch(() => {});
  }

  renderBase() {
    this.root.innerHTML = `
      <form class="chat-input" data-role="input-form">
        <div class="chat-input__editor">
          <button
            type="button"
            class="chat-input__attach"
            data-action="attach-file"
			aria-label="上传 .msh 网格文件"
            title="上传 .msh 网格文件"
          >
            ${icons.paperclip}
          </button>
          <textarea
            class="chat-input__textarea"
            rows="1"
            placeholder="用中文描述你的CFD需求（例如：‘计算Re=1e5绕翼型稳态外流，输出阻力系数与压降’）"
            aria-label="输入消息"
          ></textarea>
		  <input type="file" data-role="file-input" accept=".msh" hidden multiple />
          <div class="chat-input__buttons">
            <button type="submit" class="chat-input__submit" data-role="submit-button">
              <span class="chat-input__submit-icon" aria-hidden="true">${icons.send}</span>
              <span class="chat-input__submit-label" data-role="submit-label">提交任务</span>
              <span class="chat-input__spinner" data-role="submit-spinner" aria-hidden="true"></span>
            </button>
            <button type="button" class="chat-input__cancel" data-role="cancel-button" hidden>停止</button>
          </div>
        </div>
        <div class="chat-input__attachments" data-role="attachment-list"></div>
        <div class="chat-input__actions">
          <span>Enter 提交 · Shift+Enter 换行</span>
          <span data-role="input-status"></span>
        </div>
      </form>
    `;
  }

  render(state) {
    const { isStreaming, conversations, activeConversationId } = state;
    const conversation = conversations.find((x) => x.id === activeConversationId) ?? null;
    const conversationEnded = conversation?.ended === true;

    const baseCanSubmit = this.canSubmit();
    const canSubmit = !conversationEnded && baseCanSubmit;

    if (conversation?.id !== this.lastConversationId) {
      this.clearLocalAttachments();
      this.lastConversationId = conversation?.id ?? null;
    }

    this.textarea.disabled = isStreaming || conversationEnded;
    this.submitButton.disabled = isStreaming || !canSubmit;
    this.submitButton.title = conversationEnded
      ? "当前会话已结束"
      : isStreaming
        ? "任务执行中"
        : "提交任务到 CFD-Agent";
    this.submitButton.dataset.loading = isStreaming ? "true" : "false";
    this.submitButton.classList.toggle("is-loading", isStreaming);
    if (this.submitLabel) this.submitLabel.textContent = isStreaming ? "执行中…" : "提交任务";
    if (this.submitSpinner) this.submitSpinner.hidden = !isStreaming;

    this.attachButton.disabled = isStreaming || conversationEnded;

    if (this.toolbarButton) {
      this.toolbarButton.disabled = isStreaming || !canSubmit;
      this.toolbarButton.dataset.loading = isStreaming ? "true" : "false";
      this.toolbarButton.classList.toggle("is-loading", isStreaming);
      this.toolbarButton.setAttribute("aria-busy", isStreaming ? "true" : "false");
      if (this.toolbarLabel) this.toolbarLabel.textContent = isStreaming ? "执行中…" : "提交任务";
      if (this.toolbarSpinner) this.toolbarSpinner.hidden = !isStreaming;
    }

    if (this.cancelButton) {
      this.cancelButton.hidden = !isStreaming;
      this.cancelButton.disabled = !isStreaming;
    }

    if (conversationEnded) {
      this.statusEl.textContent = "当前会话已结束，请新建对话以继续。";
    } else if (isStreaming) {
      this.statusEl.textContent = "任务执行中…";
    } else if (!canSubmit) {
      this.statusEl.textContent = "请输入任务描述后提交";
    } else {
      this.statusEl.textContent = "";
    }
  }

  async handleSubmit(e) {
    e.preventDefault();
    await this.processInput();
  }

  handleInput() {
    this.autoResize();
    const state = chatState.getState();
    const conversation = state.conversations.find((x) => x.id === state.activeConversationId) ?? null;
    if (conversation?.ended) {
      this.submitButton.disabled = true;
      if (this.toolbarButton) this.toolbarButton.disabled = true;
      this.statusEl.textContent = "当前会话已结束，请新建对话以继续。";
      return;
    }
    const canSubmit = this.canSubmit();
    this.submitButton.disabled = !canSubmit;
    if (this.toolbarButton) this.toolbarButton.disabled = !canSubmit;
  }

  handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      this.form.requestSubmit();
    }
  }

  handleGenerateClick() {
    if (this.toolbarButton?.disabled) return;
    this.form.requestSubmit();
  }
  
  handleApplyDefaults(event) {
    const messageId = event?.detail?.messageId;
    if (!messageId) return;

    const state = chatState.getState();
    const conversation = state.conversations.find((c) => c.id === state.activeConversationId) ?? null;
    if (!conversation) return;

    const message = conversation.messages.find((m) => m.id === messageId) ?? null;
    const info = message?.meta?.physicalCheck ?? null;
    const applyText = typeof info?.applyText === "string" ? info.applyText.trim() : "";
    if (!applyText) return;

    this.textarea.value = applyText;
    this.autoResize();
    this.handleInput();
    this.statusEl.textContent = "已应用 Ally1.0 默认物理量，请确认后提交。";
    this.textarea.focus();
  }

  handleCancel() {
    // 停止前端请求与轮询（不会强制终止后端计算）
    try { this.activeController?.abort(); } catch {}
	const jobId = this.activeJobId;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
	this.stopPhysicalCheckIndicator("⏹️ Ally1.0 物理层检查已取消", "cancelled");
    setStreaming(false);
	if (this.logMessageId) {
      this.updateLogMessage(jobId, {
        statusLabel: "轮询已停止",
        logText: this.lastLogText,
        streaming: false,
        note: "前端已停止刷新日志，CFD-Agent 可能仍在后台继续运行。"
      });
      this.resetLogTracking();
    }
    this.activeJobId = null;
    pushAssistantSummary("⏹️ 已停止本地轮询。若后端仍在计算，可稍后使用下载链接获取结果。");
    this.statusEl.textContent = "已停止轮询。";
  }
  
  resetLogTracking() {
    this.logMessageId = null;
    this.lastLogText = "";
    this.lastLogStatus = "";
    this.lastLogNote = "";
    this.lastLogStreaming = null;
  }

  updateLogMessage(jobId, options = {}) {
    if (!this.logMessageId) return;

    const statusLabel = options.statusLabel || "运行中";
    const rawLog = typeof options.logText === "string" ? options.logText : "";
    const cleanedLog = rawLog.replace(/\u0000/g, "").trimEnd();
    const noteText = options.note ? String(options.note) : null;
    const streaming = options.streaming === true;
    const cacheKey = noteText ?? "";

    if (
      this.lastLogText === cleanedLog &&
      this.lastLogStatus === statusLabel &&
      this.lastLogNote === cacheKey &&
      this.lastLogStreaming === streaming
    ) {
      return;
    }

    const lines = [];
    lines.push(`🛠️ CFD-Agent 状态：${statusLabel}${jobId ? `（Job: ${jobId}）` : ""}`);
    if (noteText) {
      lines.push("", noteText);
    }
    if (cleanedLog) {
      lines.push("", "```txt");
      lines.push(cleanedLog);
      lines.push("```");
    } else {
      lines.push("", "*暂无日志输出*");
    }

    patchMessage(this.logMessageId, {
      content: lines.join("\n"),
      streaming,
      meta: {
        jobId,
        status: statusLabel,
        logText: cleanedLog,
        note: noteText ?? null
      }
    });

    this.lastLogText = cleanedLog;
    this.lastLogStatus = statusLabel;
    this.lastLogNote = cacheKey;
    this.lastLogStreaming = streaming;
  }

  async processInput() {
    const appState = chatState.getState();
    if (appState.isStreaming) return;

    const conversation = appState.conversations.find((x) => x.id === appState.activeConversationId) ?? null;
    if (conversation?.ended) {
      this.statusEl.textContent = "当前会话已结束，请新建对话以继续。";
      return;
    }

    const rawText = this.textarea.value;
    const content = rawText.trim();
    if (!content) {
      this.statusEl.textContent = "请先输入任务描述";
      return;
    }

    // 推送用户消息
	const attachmentsForMessage = this.attachments.map((it) => ({
      id: it.id,
      name: it.file.name,
      size: it.file.size,
      type: it.file.type,
      url: it.url
    }));

    const meshAttachment = [...this.attachments]
      .reverse()
      .find((it) => {
        const name = typeof it?.file?.name === "string" ? it.file.name.toLowerCase() : "";
        return name.endsWith(".msh");
      });
    const meshFile = meshAttachment?.file ?? null;
	
    const payload = {
      text: rawText,
	  attachments: attachmentsForMessage
    };
    const userMsg = pushUserMessage(payload);
    if (!userMsg) return;

    // 清空输入框与附件区域
    this.textarea.value = "";
    this.autoResize();
    this.clearLocalAttachments({ release: false });
    this.fileInput.value = "";

    setStreaming(true);
    this.cancelButton.hidden = false;
    this.cancelButton.disabled = false;

    // 取消上一控制器
    if (this.activeController) {
      try { this.activeController.abort(); } catch {}
    }
    this.activeController = new AbortController();

    try {
		  this.statusEl.textContent = "正在执行 Ally1.0 物理层检查…";
      this.startPhysicalCheckIndicator();
      const check = await physicalLayerCheck(content, { signal: this.activeController.signal });

      const missingItems = Array.isArray(check?.missing)
        ? check.missing.map((item) => String(item)).filter((item) => item.trim().length > 0)
        : [];
      const defaults = Array.isArray(check?.defaults) ? check.defaults : [];
      const summary = typeof check?.summary === "string" ? check.summary.trim() : "";
      let applyText = typeof check?.applyText === "string" ? check.applyText.trim() : "";
      if (!applyText && defaults.length) {
        const defaultLines = defaults
          .map((entry) => {
            if (!entry) return "";
            if (typeof entry === "string") return entry.trim();
            if (typeof entry !== "object") return "";
            const name = [entry.name, entry.label, entry.field]
              .map((value) => (typeof value === "string" ? value.trim() : ""))
              .find((value) => !!value) || "";
            const value = typeof entry.value === "string"
              ? entry.value.trim()
              : typeof entry.value === "number" || typeof entry.value === "boolean"
                ? String(entry.value)
                : typeof entry.default === "string"
                  ? entry.default.trim()
                  : "";
            const note = typeof entry.note === "string"
              ? entry.note.trim()
              : typeof entry.reason === "string"
                ? entry.reason.trim()
                : "";
            const detail = [value, note].filter(Boolean).join("，");
            if (name && detail) return `${name}：${detail}`;
            if (name) return `${name}`;
            return detail;
          })
          .filter((line) => line && line.trim().length > 0);
        if (defaultLines.length) {
          applyText = `${content}\n\n（Ally1.0 建议默认值）\n${defaultLines.map((line) => `- ${line}`).join("\n")}`;
        }
      }
      const passed = check?.passed !== false && missingItems.length === 0;

      if (!passed) {
        const missingText = missingItems.length
          ? `缺少 ${missingItems.join("、")}`
          : "请补充必要的物理量";
        const alertLines = [`⚠️ Ally1.0 物理层检查未通过：${missingText}。`];
        if (summary) alertLines.push("", summary);

        const assistantMessage = pushAssistantSummary(alertLines.join("\n"), null, {
          meta: {
            physicalCheck: {
              status: "failed",
              missing: missingItems,
              defaults,
              summary,
              applyText,
              draft: check?.draft ?? null
            }
          }
        });

        if (!assistantMessage) {
          pushAssistantSummary(`⚠️ Ally1.0 物理层检查未通过：${missingText}。`);
        }
		
		this.stopPhysicalCheckIndicator("❌ Ally1.0 物理层检查未通过", "failed");
        this.statusEl.textContent = "物理层检查未通过，请完善后重新提交。";
        setStreaming(false);
        this.cancelButton.hidden = true;
        this.cancelButton.disabled = true;
        this.resetLogTracking();
        this.activeJobId = null;
        this.activeController = null;
        return;
      }
	  
          pushAssistantSummary("📄 JSON 检查通过");
      pushAssistantSummary("🧠 物理层检查通过");

          this.stopPhysicalCheckIndicator("✅ Ally1.0 物理层检查通过", "passed");
          this.statusEl.textContent = "正在将需求翻译为英文…";
      const english = await translateToEnglish(content, undefined, { signal: this.activeController.signal });
      const englishTrimmed = english.trim();
      if (!englishTrimmed) {
        throw new Error("翻译结果为空");
      }

      this.statusEl.textContent = "正在提交英文需求到 CFD-Agent…";
	  const runResp = await runFoamAgent({ prompt: englishTrimmed, meshFile });
      const jobId = runResp?.job_id || runResp?.jobId || runResp?.id;
      if (!jobId) {
        throw new Error(runResp?.message || "后端未返回有效的 job_id");
      }

      this.activeJobId = jobId;
		  this.resetLogTracking();
		  
	  if (meshFile) {
        const meshName = typeof meshFile.name === "string" && meshFile.name.trim()
          ? meshFile.name.trim()
          : "my.msh";
        pushAssistantSummary(`📎 已上传自定义网格：${meshName}`);
      }

      pushAssistantSummary(`🚀 已转换为英文并提交任务（Job: ${jobId}）`);

          const logMsg = pushAssistantSummary(
        `🛠️ CFD-Agent 任务日志（Job: ${jobId}）`,
        null,
        { streaming: true, meta: { jobId, status: "准备中" } }
      );
      if (logMsg?.id) {
        this.logMessageId = logMsg.id;
        this.lastLogText = "";
        this.lastLogStatus = "";
        this.lastLogNote = "";
        this.lastLogStreaming = null;
        this.updateLogMessage(jobId, {
          statusLabel: "准备中",
          logText: "",
          streaming: true,
          note: "等待 CFD-Agent 输出日志…"
        });
      }

      // 轮询状态
	  this.statusEl.textContent = "已转换格式并提交任务，正在轮询状态…";
      // 这里不保存返回值，避免未使用变量

      this.pollTimer = setInterval(async () => {
        try {
          const s = await pollJob(jobId, { signal: this.activeController.signal });
          // s: { status: "queued|running|succeeded|failed", message?, progress? }
          if (!s || !s.status) return;
		  
		  const statusLabels = {
            queued: "排队中",
            running: "运行中",
            succeeded: "已完成",
            failed: "失败"
          };
          const statusLabel = statusLabels[s.status] || s.status;
          const rawTail = typeof s.log_tail === "string" ? s.log_tail : "";
          const logTail = rawTail.replace(/\u0000/g, "").trimEnd();
          const streaming = s.status === "queued" || s.status === "running";
          const failureReason = s.message || (typeof s.error === "string" ? s.error : "");

          let note = null;
          if (s.status === "queued") {
            note = "任务已进入队列，等待执行。";
          } else if (s.status === "running") {
            note = s.message || "仿真进行中…";
          } else if (s.status === "succeeded") {
            note = "CFD-Agent 已完成仿真并生成结果。";
          } else if (s.status === "failed") {
            note = failureReason ? `失败原因：${failureReason}` : "CFD-Agent 返回失败。";
          }

          this.updateLogMessage(jobId, {
            statusLabel,
            logText: logTail,
            streaming,
            note
          });

          if (s.status === "queued" || s.status === "running") {
            this.statusEl.textContent = s.message ? `执行中：${s.message}` : "执行中…";
          } else if (s.status === "succeeded") {
            clearInterval(this.pollTimer);
            this.pollTimer = null;

            const url = downloadZipUrl(jobId);
            pushAssistantSummary(
              `✅ 仿真完成（Job: ${jobId}）。\n\n` +
              `📦 [下载结果 ZIP](${url})\n\n` +
              `> 结果包含 \`output/\` 下的关键文件；如需可视化，请在本地解压后用 ParaView 等工具查看。`
            );
			this.updateLogMessage(jobId, {
              statusLabel: "已完成",
              logText: logTail,
              streaming: false,
              note: "结果已生成，可通过下方链接下载 ZIP。"
            });
            this.statusEl.textContent = "任务完成。";
            setStreaming(false);
			this.resetLogTracking();
            this.activeJobId = null;
          } else if (s.status === "failed") {
            clearInterval(this.pollTimer);
            this.pollTimer = null;

			pushAssistantSummary(`❌ 仿真失败（Job: ${jobId}）。${failureReason ? `\n\n原因：${failureReason}` : ""}`, null, { meta: { isError: true } });
            this.updateLogMessage(jobId, {
              statusLabel: "失败",
              logText: logTail,
              streaming: false,
              note: failureReason ? `失败原因：${failureReason}` : "CFD-Agent 返回非零退出码。"
            });
            this.statusEl.textContent = "任务失败。";
            setStreaming(false);
			this.resetLogTracking();
            this.activeJobId = null;
          }
        } catch (err) {
          // 轮询抛错通常是网络/中断，不立刻终止，可在下次 tick 重试；若是 abort 则静默
          if (String(err?.name).includes("Abort")) return;
        }
      }, 1500);
    } catch (error) {
      const msg = error?.message ?? String(error ?? "未知错误");
      if (String(msg).toLowerCase().includes("abort")) {
        this.stopPhysicalCheckIndicator("⏹️ Ally1.0 物理层检查已取消", "cancelled");
		pushAssistantSummary("⏸️ 已取消本次提交/轮询。");
        this.statusEl.textContent = "已取消本次请求。";
      } else {
		this.stopPhysicalCheckIndicator(`❌ Ally1.0 物理层检查失败：${msg}`, "error");
        pushAssistantSummary(`❌ 提交或翻译失败：${msg}`, null, { meta: { isError: true } });
        this.statusEl.textContent = `失败：${msg}`;
      }
      setStreaming(false);
          this.resetLogTracking();
      this.activeJobId = null;
    } finally {
      // 这里不隐藏“停止”按钮，让其在 isStreaming=false 时自动隐藏
      this.textarea.focus();
    }
  }

  handleAttachClick() {
    if (!this.attachButton.disabled) this.fileInput.click();
  }

  handleFileChange(e) {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;

	const accepted = ["msh"];
    const added = [];
    let hasInvalid = false;

    files.forEach((file) => {
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
      if (!accepted.includes(ext)) { hasInvalid = true; return; }
      const att = {
        id: crypto.randomUUID ? crypto.randomUUID() : `file-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        file,
        url: URL.createObjectURL(file)
      };
      this.attachments.push(att);
      added.push(att);
    });

    if (added.length > 0) {
      this.renderAttachments();
      const canSubmit = this.canSubmit();
      this.submitButton.disabled = !canSubmit;
      if (this.toolbarButton) this.toolbarButton.disabled = !canSubmit;
      this.autoResize();
    }

    if (hasInvalid) {
	  this.statusEl.textContent = "仅支持上传 .msh 网格文件";
    }

    this.fileInput.value = "";
  }

  handleAttachmentRemove(e) {
    const btn = e.target.closest("[data-action=remove-attachment]");
    if (!btn) return;
    const id = btn.dataset.attachmentId;
    const idx = this.attachments.findIndex((x) => x.id === id);
    if (idx === -1) return;
    const [removed] = this.attachments.splice(idx, 1);
    if (removed?.url) URL.revokeObjectURL(removed.url);
    this.renderAttachments();
    const canSubmit = this.canSubmit();
    this.submitButton.disabled = !canSubmit;
    if (this.toolbarButton) this.toolbarButton.disabled = !canSubmit;
  }

  autoResize() {
    this.textarea.style.height = "auto";
    const maxHeight = 220;
    this.textarea.style.height = `${Math.min(this.textarea.scrollHeight, maxHeight)}px`;
  }

  canSubmit() {
    return Boolean(this.textarea.value.trim());
  }

  renderAttachments() {
    if (!this.attachments.length) {
      this.attachmentList.innerHTML = "";
      this.attachmentList.classList.remove("chat-input__attachments--visible");
      return;
    }
    this.attachmentList.classList.add("chat-input__attachments--visible");
    const frag = document.createDocumentFragment();

    this.attachments.forEach((it) => {
      const chip = document.createElement("div");
      chip.className = "chat-input__attachment";

      const name = document.createElement("span");
      name.className = "chat-input__attachment-name";
      name.textContent = it.file.name;

      const size = document.createElement("span");
      size.className = "chat-input__attachment-size";
      size.textContent = formatFileSize(it.file.size);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "chat-input__attachment-remove";
      remove.dataset.attachmentId = it.id;
      remove.setAttribute("aria-label", `移除附件 ${it.file.name}`);
      remove.innerHTML = icons.close;
      remove.dataset.action = "remove-attachment";

      chip.append(name, size, remove);
      frag.appendChild(chip);
    });

    this.attachmentList.innerHTML = "";
    this.attachmentList.appendChild(frag);
  }

  clearLocalAttachments(options = {}) {
    const { release = true } = options;
    if (release) {
      this.attachments.forEach((it) => { if (it.url) URL.revokeObjectURL(it.url); });
    }
    this.attachments = [];
    this.renderAttachments();
  }

  destroy() {
    this.form.removeEventListener("submit", this.handleSubmit);
    this.textarea.removeEventListener("input", this.handleInput);
    this.textarea.removeEventListener("keydown", this.handleKeyDown);
    this.attachButton.removeEventListener("click", this.handleAttachClick);
    this.fileInput.removeEventListener("change", this.handleFileChange);
    this.attachmentList.removeEventListener("click", this.handleAttachmentRemove);
    if (this.toolbarButton) this.toolbarButton.removeEventListener("click", this.handleGenerateClick);
    if (this.cancelButton) this.cancelButton.removeEventListener("click", this.handleCancel);
	window.removeEventListener("ally:apply-defaults", this.handleApplyDefaults);

    try { this.activeController?.abort(); } catch {}
    if (this.pollTimer) clearInterval(this.pollTimer);
	this.stopPhysicalCheckIndicator("⏹️ Ally1.0 物理层检查已终止", "cancelled");
    this.clearLocalAttachments();
    if (this.unsubscribe) this.unsubscribe();
  }
  startPhysicalCheckIndicator() {
    if (this.physicalCheckTicker) {
      clearInterval(this.physicalCheckTicker);
      this.physicalCheckTicker = null;
    }

    const firstFrame = this.physicalCheckFrames[0] || "⏳";
    const message = pushAssistantSummary(`${firstFrame} Ally1.0 物理层检查进行中…`, null, {
      streaming: true,
      meta: { physicalCheck: { status: "running" } }
    });

    if (!message?.id) {
      this.physicalCheckMessageId = null;
      this.physicalCheckFrameIndex = 0;
      return;
    }

    this.physicalCheckMessageId = message.id;
    this.physicalCheckFrameIndex = 0;
    this.physicalCheckTicker = setInterval(() => {
      if (!this.physicalCheckMessageId) {
        clearInterval(this.physicalCheckTicker);
        this.physicalCheckTicker = null;
        return;
      }

      this.physicalCheckFrameIndex = (this.physicalCheckFrameIndex + 1) % this.physicalCheckFrames.length;
      const frame = this.physicalCheckFrames[this.physicalCheckFrameIndex] || "⏳";
      patchMessage(this.physicalCheckMessageId, {
        content: `${frame} Ally1.0 物理层检查进行中…`,
        streaming: true
      });
    }, 1200);
  }

  stopPhysicalCheckIndicator(finalText, status = "completed") {
    if (this.physicalCheckTicker) {
      clearInterval(this.physicalCheckTicker);
      this.physicalCheckTicker = null;
    }

    if (this.physicalCheckMessageId) {
      const patch = { streaming: false };

      if (typeof finalText === "string" && finalText.trim()) {
        patch.content = finalText.trim();
      }

      if (status) {
        patch.meta = { physicalCheck: { status } };
      }

      patchMessage(this.physicalCheckMessageId, patch);
    }

    this.physicalCheckMessageId = null;
    this.physicalCheckFrameIndex = 0;
  }
}
