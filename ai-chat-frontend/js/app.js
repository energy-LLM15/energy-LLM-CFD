import { chatState } from "./state/chatState.js";
import { ChatSidebar } from "./components/ChatSidebar.js";
import { ChatHeader } from "./components/ChatHeader.js";
import { ChatMessageList } from "./components/ChatMessageList.js";
import { ChatInput } from "./components/ChatInput.js";
import { ChatToolbar } from "./components/ChatToolbar.js";

function main() {
  const sidebarRoot = document.querySelector("[data-component=sidebar]");
  const headerRoot = document.querySelector("[data-component=header]");
  const messagesRoot = document.querySelector("[data-component=messages]");
  const inputRoot = document.querySelector("[data-component=input]");
  const toolbarRoot = document.querySelector("[data-component=toolbar]");

  if (!sidebarRoot || !headerRoot || !messagesRoot || !inputRoot || !toolbarRoot) {
    throw new Error("应用容器缺失，无法初始化界面");
  }

  chatState.init();

  const sidebar = new ChatSidebar(sidebarRoot);
  const header = new ChatHeader(headerRoot);
  const toolbar = new ChatToolbar(toolbarRoot);
  const messageList = new ChatMessageList(messagesRoot, chatState);
  const input = new ChatInput(inputRoot);

  const detachTheme = chatState.subscribe((state) => {
    document.body.setAttribute("data-theme", state.theme);
  });

  window.addEventListener("beforeunload", () => {
    sidebar.destroy();
    header.destroy();
	toolbar.destroy();
    messageList.destroy();
    input.destroy();
    detachTheme();
  });
}

main();