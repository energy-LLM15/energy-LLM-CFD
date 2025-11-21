// js/components/ChatSidebar.js
import { chatState } from "../state/chatState.js";
import { icons } from "../utils/icons.js";

const rtf = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });

function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatRelativeTime(timestamp) {
  if (!timestamp) return "刚刚";
  const delta = new Date(timestamp).getTime() - Date.now();
  const minutes = Math.round(delta / 60000);
  if (Math.abs(minutes) < 1) return "刚刚";
  if (Math.abs(minutes) < 60) return rtf.format(minutes, "minute");
  const hours = Math.round(delta / 3600000);
  if (Math.abs(hours) < 24) return rtf.format(hours, "hour");
  const days = Math.round(delta / 86400000);
  return rtf.format(days, "day");
}

export class ChatSidebar {
  constructor(root) {
    this.root = root;
    this.root.innerHTML = this.template();

    this.listEl = this.root.querySelector("[data-role=conversation-list]");
    this.newButton = this.root.querySelector("[data-action=new-conversation]");
    this.collapseButton = this.root.querySelector("[data-action=toggle-collapse]");
    this.collapseIcon = this.collapseButton.querySelector("[data-role=collapse-icon]");
    this.collapseLabel = this.collapseButton.querySelector("[data-role=collapse-label]");

    this.handleCreateConversation = this.handleCreateConversation.bind(this);
    this.handleListClick = this.handleListClick.bind(this);
    this.handleCollapseToggle = this.handleCollapseToggle.bind(this);

    this.newButton.addEventListener("click", this.handleCreateConversation);
    this.listEl.addEventListener("click", this.handleListClick);
    this.collapseButton.addEventListener("click", this.handleCollapseToggle);

    this.unsubscribe = chatState.subscribe((state) => this.render(state));
  }

  template() {
    return `
      <div class="sidebar__header">
        <div class="sidebar__title">
          <span>Workflow Studio</span>
          <span class="sidebar__title-badge">Beta</span>
        </div>
        <p class="sidebar__subtitle">保存常用提示词与自动化流程，随时重新启用。</p>
      </div>
      <div class="sidebar__actions">
        <button type="button" class="sidebar__button sidebar__button--new" data-action="new-conversation">
          <span class="sidebar__button-media" aria-hidden="true">
            <img src="./assets/new-conversation-car.png" alt="新建对话插图" />
          </span>
          <span class="sidebar__button-text">
            <span class="sidebar__button-title">新建对话</span>
            <span class="sidebar__button-caption">快速启动一段全新的灵感旅程</span>
          </span>
        </button>
      </div>
      <ul class="sidebar__list" data-role="conversation-list" aria-label="对话列表"></ul>
      <div class="sidebar__footer">
        <button
          type="button"
          class="sidebar__collapse"
          data-action="toggle-collapse"
          aria-expanded="true"
        >
          <span class="sidebar__collapse-icon" data-role="collapse-icon">${icons.chevronLeft}</span>
          <span class="sidebar__collapse-label" data-role="collapse-label">收起侧边栏</span>
        </button>
      </div>
    `;
  }

  render(state) {
    const { conversations, activeConversationId, isStreaming, models } = state;

    if (conversations.length === 0) {
      this.listEl.innerHTML = `<li class="sidebar__item">暂无对话，点击上方按钮开始新的创作。</li>`;
      return;
    }

    this.listEl.innerHTML = "";
    const modelLabelMap = new Map(models.map((model) => [model.id, model.label]));

    conversations.forEach((conversation) => {
      const item = document.createElement("li");
      const isActive = conversation.id === activeConversationId;
      item.className = `sidebar__item${isActive ? " sidebar__item--active" : ""}`;
      item.dataset.conversationId = conversation.id;

      const title = escapeHtml(conversation.title || "未命名对话");
      const modelLabel = modelLabelMap.get(conversation.model) ?? conversation.model;
      const updatedAt = formatRelativeTime(conversation.updatedAt);

      const streamingBadge = isActive && isStreaming ? `<span class="sidebar__status">生成中…</span>` : "";
      const endedBadge = conversation.ended ? `<span class="sidebar__status sidebar__status--ended">已结束</span>` : "";
      const statusBadge = endedBadge || streamingBadge;

      item.innerHTML = `
        <div class="sidebar__item-header">
          <span class="sidebar__item-title">${title}</span>
          <button
            type="button"
            class="sidebar__item-delete"
            data-action="delete-conversation"
            aria-label="删除对话"
            title="删除对话"
          >
            ${icons.trash}
          </button>
        </div>
        <div class="sidebar__item-meta">
          <span>${escapeHtml(modelLabel)}</span>
          <span>${updatedAt}</span>
        </div>
        ${statusBadge}
      `;

      this.listEl.appendChild(item);
    });
    this.renderCollapseState();
  }

  renderCollapseState() {
    const isCollapsed = document.body.classList.contains("sidebar-collapsed");
    this.root.classList.toggle("sidebar--collapsed", isCollapsed);
    this.collapseButton.setAttribute("aria-expanded", String(!isCollapsed));
    this.collapseIcon.innerHTML = isCollapsed ? icons.chevronRight : icons.chevronLeft;
    this.collapseLabel.textContent = isCollapsed ? "展开侧边栏" : "收起侧边栏";
  }

  handleCreateConversation() {
    chatState.createConversation();
    document.body.classList.remove("sidebar-open");
    document.body.classList.remove("sidebar-collapsed");
    this.renderCollapseState();
  }

  handleListClick(event) {
    const deleteButton = event.target.closest("[data-action=delete-conversation]");
    if (deleteButton) {
      event.preventDefault();
      event.stopPropagation();
      const item = deleteButton.closest(".sidebar__item");
      if (item) chatState.deleteConversation(item.dataset.conversationId);
      return;
    }

    const target = event.target.closest(".sidebar__item");
    if (!target) return;
    chatState.setActiveConversation(target.dataset.conversationId);
    document.body.classList.remove("sidebar-open");
  }

  handleCollapseToggle() {
    document.body.classList.toggle("sidebar-collapsed");
    if (document.body.classList.contains("sidebar-collapsed")) {
      document.body.classList.remove("sidebar-open");
    }
    this.renderCollapseState();
  }

  destroy() {
    this.newButton.removeEventListener("click", this.handleCreateConversation);
    this.listEl.removeEventListener("click", this.handleListClick);
    this.collapseButton.removeEventListener("click", this.handleCollapseToggle);
    if (this.unsubscribe) this.unsubscribe();
  }
}
