// js/components/ChatToolbar.js
import { chatState } from "../state/chatState.js";

const DIMENSION_STORAGE_KEY = "cfd_dimension_mode";

function normalizeMode(mode) {
  return mode === "2D_extruded" ? "2D_extruded" : "3D";
}

export class ChatToolbar {
  constructor(root) {
    this.root = root;
    this.handleToggle = this.handleToggle.bind(this);

    this.renderBase();

    this.generateButton = this.root.querySelector("[data-action=generate-settings]");
    this.dimensionButtons = Array.from(
      this.root.querySelectorAll("[data-role=dimension-option]")
    );

    this.dimensionButtons.forEach((button) => {
      button.addEventListener("click", this.handleToggle);
    });

    this.unsubscribe = chatState.subscribe((state) => this.render(state));

    // 恢复本地维度偏好
    try {
      const stored = localStorage.getItem(DIMENSION_STORAGE_KEY);
      if (stored) {
        chatState.setDimensionMode(normalizeMode(stored));
      }
    } catch (error) {
      console.warn("[ChatToolbar] 无法从 localStorage 读取维度偏好", error);
    }
  }

  renderBase() {
    this.root.innerHTML = `
      <div class="chat-toolbar">
        <div class="chat-toolbar__left">
          <div class="chat-toolbar__dimension" role="group" aria-label="几何维度">
            <button
              type="button"
              class="dimension-toggle__option"
              data-role="dimension-option"
              data-dimension="3D"
              aria-pressed="true"
            >
              3D
            </button>
            <button
              type="button"
              class="dimension-toggle__option"
              data-role="dimension-option"
              data-dimension="2D_extruded"
              aria-pressed="false"
            >
              2D 挤出
            </button>
          </div>
        </div>
        <div class="chat-toolbar__right">
          <button type="button" class="chat-toolbar__generate" data-action="generate-settings">
            <span class="chat-toolbar__icon" aria-hidden="true">⚙️</span>
            <span class="chat-toolbar__label" data-role="toolbar-label">生成设置</span>
            <span class="chat-toolbar__spinner" data-role="toolbar-spinner" aria-hidden="true"></span>
          </button>
        </div>
      </div>
    `;
  }

  render(state) {
    const currentMode = normalizeMode(state.dimensionMode);
    const isStreaming = Boolean(state.isStreaming);
    const conversation = state.conversations.find(c => c.id === state.activeConversationId) ?? null;
    const conversationEnded = conversation?.ended === true;

    // 维度按钮状态
    this.dimensionButtons.forEach((button) => {
      const mode = normalizeMode(button.dataset.dimension);
      const isActive = mode === currentMode;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-pressed", isActive ? "true" : "false");
      button.disabled = isStreaming || conversationEnded;
    });

    // 生成按钮由 ChatInput 统一触发，但这里同步可用/忙碌态，避免 UI 闪烁
    if (this.generateButton) {
      const label = this.generateButton.querySelector("[data-role=toolbar-label]");
      const spinner = this.generateButton.querySelector("[data-role=toolbar-spinner]");

      this.generateButton.disabled = isStreaming || conversationEnded;
      this.generateButton.setAttribute("aria-disabled", this.generateButton.disabled ? "true" : "false");

      // 与 ChatInput 的按钮文案保持一致（“生成设置/生成中…”）
      this.generateButton.dataset.loading = isStreaming ? "true" : "false";
      this.generateButton.classList.toggle("is-loading", isStreaming);
      if (label) label.textContent = isStreaming ? "生成中…" : "生成设置";
      if (spinner) spinner.hidden = !isStreaming;
    }
  }

  handleToggle(event) {
    const button = event.currentTarget;
    if (!button || button.disabled) return;
    const mode = normalizeMode(button.dataset.dimension);
    chatState.setDimensionMode(mode);
    try {
      localStorage.setItem(DIMENSION_STORAGE_KEY, mode);
    } catch (error) {
      console.warn("[ChatToolbar] 无法写入维度偏好", error);
    }
  }

  destroy() {
    this.dimensionButtons.forEach((button) => {
      button.removeEventListener("click", this.handleToggle);
    });
    if (this.unsubscribe) this.unsubscribe();
  }
}
