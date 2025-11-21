// js/components/ChatHeader.js
//
// 目的：
// 1) 删除“求解器 Profile 下拉”及所有与旧编排后端（profiles/schema 等）的交互。
// 2) 保留“推理模型”下拉（用于选择 DeepSeek 翻译模型），以及主题切换。
// 3) 新增 FastAPI 桥接健康检查（/health）状态展示：在线/离线 + wm_project_dir。
//
import { chatState } from "../state/chatState.js";
import { icons } from "../utils/icons.js";
import { bridgeHealth } from "../services/chatApi.js";

const rtf = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });

function formatMessageSummary(conversation) {
  if (!conversation) return "准备就绪，随时开始新的仿真协作。";
  if (conversation.ended) return "会话已结束，请新建对话。";
  const messageCount = conversation.messages.length;
  if (messageCount === 0) return "还没有消息，输入目标即可开始。";
  const lastUpdated = conversation.updatedAt ?? conversation.createdAt;
  const delta = new Date(lastUpdated).getTime() - Date.now();
  const minutes = Math.round(delta / 60000);
  if (Math.abs(minutes) < 1) return "刚刚";
  if (Math.abs(minutes) < 60) return rtf.format(minutes, "minute");
  const hours = Math.round(delta / 3600000);
  if (Math.abs(hours) < 24) return rtf.format(hours, "hour");
  const days = Math.round(delta / 86400000);
  return rtf.format(days, "day");
}

function labelOf(id, models) {
  const m = models.find((x) => x.id === id);
  return m ? m.label : id || "未选择";
}

export class ChatHeader {
  constructor(root) {
    this.root = root;

    // UI 状态
    this.modelSignature = "";
    this.isModelMenuOpen = false;

    // 桥接状态
    this.bridgeOk = false;
    this.wmProjectDir = "";
    this.bridgeText = "检测中…";

    // 事件绑定
    this.handleThemeToggle = this.handleThemeToggle.bind(this);
    this.handleSidebarToggle = this.handleSidebarToggle.bind(this);
    this.handleModelButton = this.handleModelButton.bind(this);
    this.handleDocClick = this.handleDocClick.bind(this);
    this.handleKeydown = this.handleKeydown.bind(this);

    this.renderBase();

    // refs
    this.titleEl = this.root.querySelector(".chat-header__title");
    this.subtitleEl = this.root.querySelector(".chat-header__subtitle");
    this.themeButton = this.root.querySelector("[data-action=toggle-theme]");
    this.sidebarToggle = this.root.querySelector("[data-action=toggle-sidebar]");

    // model dropdown refs
    this.modelWrap = this.root.querySelector('[data-component="model-select"]');
    this.modelButton = this.modelWrap.querySelector(".model-select__button");
    this.modelLabel = this.modelWrap.querySelector(".model-select__label");
    this.modelMenu = this.modelWrap.querySelector(".model-select__menu");

    // bridge status ref
    this.bridgeBadge = this.root.querySelector("[data-role=bridge-badge]");

    // bind events
    this.themeButton.addEventListener("click", this.handleThemeToggle);
    this.sidebarToggle.addEventListener("click", this.handleSidebarToggle);
    this.modelButton.addEventListener("click", this.handleModelButton);
    document.addEventListener("click", this.handleDocClick, { passive: true });
    document.addEventListener("keydown", this.handleKeydown);

    // 订阅全局状态
    this.unsubscribe = chatState.subscribe((state) => this.render(state));

    // 拉一次健康检查
    this.bootstrapBridgeHealth();
    // 可选：间隔刷新（如需更实时可开启）
    // this.healthTimer = setInterval(() => this.bootstrapBridgeHealth(), 15000);
  }

  async bootstrapBridgeHealth() {
    try {
      const data = await bridgeHealth(); // { ok: true, wm_project_dir: "/home/.../OpenFOAM-10" }
      this.bridgeOk = !!data?.ok;
      this.wmProjectDir = typeof data?.wm_project_dir === "string" ? data.wm_project_dir : "";
      this.bridgeText = this.bridgeOk
        ? (this.wmProjectDir ? `桥接正常 · ${this.wmProjectDir}` : "桥接正常")
        : "桥接不可用";
    } catch (_) {
      this.bridgeOk = false;
      this.wmProjectDir = "";
      this.bridgeText = "桥接不可用";
    }
    this.updateBridgeBadge();
  }

  updateBridgeBadge() {
    if (!this.bridgeBadge) return;
    this.bridgeBadge.textContent = this.bridgeText;
    this.bridgeBadge.dataset.state = this.bridgeOk ? "ok" : "down";
    this.bridgeBadge.title = this.bridgeText;
  }

  renderBase() {
    this.root.innerHTML = `
      <div class="chat-header">
        <button type="button" class="chat-header__sidebar-toggle" data-action="toggle-sidebar" aria-label="展开或收起侧边栏">
          ${icons.menu}
        </button>

        <div class="chat-header__title-group">
          <h1 class="chat-header__title">AI 协作空间</h1>
          <p class="chat-header__subtitle">准备就绪，随时开始新的仿真协作。</p>
        </div>

        <div class="chat-header__actions">
          <!-- FastAPI→Foam-Agent 桥接状态 -->
          <span class="chat-header__badge" data-role="bridge-badge" title="CFD-Agent 桥接健康">检测中…</span>

          <!-- 推理模型选择（DeepSeek CFD模型等） -->
          <div class="chat-header__model">
            <span class="chat-header__model-label">CFD模型</span>
            <div class="model-select" data-component="model-select">
              <button type="button" class="model-select__button" aria-haspopup="listbox" aria-expanded="false">
                <span class="model-select__chip">
                  <span class="model-select__icon" aria-hidden="true">${icons.model}</span>
                  <span class="model-select__label">—</span>
                </span>
                <span class="model-select__caret" aria-hidden="true"></span>
              </button>
              <ul class="model-select__menu" role="listbox" tabindex="-1" hidden></ul>
            </div>
          </div>

          <button type="button" class="chat-header__theme-toggle" data-action="toggle-theme" aria-label="切换主题">
            ${icons.sun}
          </button>
        </div>
      </div>
    `;
  }

  // ---------- 渲染 ----------
  render(state) {
    const {
      conversations,
      activeConversationId,
      models,
      theme,
      isStreaming,
      selectedModelId
    } = state;
    const conversation =
      conversations.find((item) => item.id === activeConversationId) ?? null;
    const conversationEnded = conversation?.ended === true;

    // 标题与副标题
    this.titleEl.textContent = conversation?.title || "AI 协作空间";
    this.subtitleEl.textContent = formatMessageSummary(conversation);

    
    const activeId = conversation?.model ?? selectedModelId ?? models[0]?.id ?? "";
    this.modelLabel.textContent = labelOf(activeId, models);

    const sig = models.map((m) => `${m.id}:${m.label}`).join("|");
    if (sig !== this.modelSignature) {
      this.modelMenu.innerHTML = models
        .map(
          (m) => `
          <li class="model-select__option" role="option"
              aria-selected="${m.id === activeId ? "true" : "false"}"
              data-id="${m.id}">
            <span class="model-select__badge" aria-hidden="true">★</span>
            <span class="model-select__text">${m.label}</span>
            ${m.id === activeId ? '<span class="model-select__check" aria-hidden="true">✓</span>' : ""}
          </li>`
        )
        .join("");
      this.modelMenu.querySelectorAll(".model-select__option").forEach((li) => {
        li.addEventListener("click", () => {
          const id = li.getAttribute("data-id");
          chatState.setConversationModel(id);
          this.closeModelMenu(true);
        });
      });
      this.modelSignature = sig;
    } else {
      // 仅同步选中态
      this.modelMenu.querySelectorAll(".model-select__option").forEach((li) => {
        const id = li.getAttribute("data-id");
        li.setAttribute("aria-selected", id === activeId ? "true" : "false");
        const hasCheck = !!li.querySelector(".model-select__check");
        if (id === activeId && !hasCheck) {
          li.insertAdjacentHTML("beforeend", '<span class="model-select__check" aria-hidden="true">✓</span>');
        } else if (id !== activeId && hasCheck) {
          li.querySelector(".model-select__check").remove();
        }
      });
    }

    // 生成中禁用下拉
    const disabled = isStreaming || conversationEnded;
    this.modelButton.disabled = disabled;
    this.modelButton.setAttribute("aria-disabled", disabled ? "true" : "false");
    if (disabled) this.closeModelMenu(false);

    // 主题图标
    if (theme === "dark") {
      this.themeButton.innerHTML = icons.sun;
      this.themeButton.setAttribute("aria-label", "切换到浅色模式");
    } else {
      this.themeButton.innerHTML = icons.moon;
      this.themeButton.setAttribute("aria-label", "切换到深色模式");
    }

    // 刷新桥接徽标
    this.updateBridgeBadge();
  }

  // ---------- 交互 ----------
  handleThemeToggle() { chatState.toggleTheme(); }
  handleSidebarToggle() { document.body.classList.toggle("sidebar-open"); }
  handleModelButton() { if (!this.modelButton.disabled) this.toggleModelMenu(); }

  toggleModelMenu() {
    const isOpen = !this.isModelMenuOpen;
    this.modelWrap.classList.toggle("is-open", isOpen);
    this.modelButton.setAttribute("aria-expanded", String(isOpen));
    this.modelMenu.hidden = !isOpen;
    if (isOpen) this.modelMenu.focus({ preventScroll: true });
    this.isModelMenuOpen = isOpen;
  }
  closeModelMenu(focusBtn = false) {
    if (!this.isModelMenuOpen) return;
    this.modelWrap.classList.remove("is-open");
    this.modelButton.setAttribute("aria-expanded", "false");
    this.modelMenu.hidden = true;
    this.isModelMenuOpen = false;
    if (focusBtn) this.modelButton.focus();
  }

  handleDocClick(e) {
    if (!this.modelWrap) return;
    if (!this.modelWrap.contains(e.target)) this.closeModelMenu(false);
  }
  handleKeydown(e) {
    if (e.key === "Escape") {
      this.closeModelMenu(true);
    }
  }

  destroy() {
    document.removeEventListener("click", this.handleDocClick);
    document.removeEventListener("keydown", this.handleKeydown);
    this.themeButton.removeEventListener("click", this.handleThemeToggle);
    this.sidebarToggle.removeEventListener("click", this.handleSidebarToggle);
    this.modelButton.removeEventListener("click", this.handleModelButton);
    if (this.unsubscribe) this.unsubscribe();
    // if (this.healthTimer) clearInterval(this.healthTimer);
  }
}
