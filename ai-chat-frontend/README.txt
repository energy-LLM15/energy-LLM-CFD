
ai-chat-frontend/
├── index.html                # 页面骨架，挂载各个 UI 区域并引入入口脚本
├── styles.css                # 全局样式，包含深浅色主题、响应式布局与动效
├── js/
│   ├── config/
│   │   └── modelPresets.js   # 模型与 API 端点定义，集中维护 base_url、模型 ID、密钥
│   ├── app.js                # 应用入口，实例化组件并同步主题状态
│   ├── state/
│   │   └── chatState.js      # 聊天状态管理，负责会话列表、消息流和主题切换
│   ├── components/
│   │   ├── ChatHeader.js     # 顶部信息区，包含标题、模型选择与主题切换
│   │   ├── ChatInput.js      # 底部输入区，处理消息发送与输入框交互
│   │   ├── ChatMessageList.js  # 中部消息流，渲染气泡、Markdown 与滚动逻辑
│   │   └── ChatSidebar.js    # 左侧栏，展示会话列表与新建按钮
│   ├── services/
│   │   └── chatApi.js        # 对接推理模型的通用 fetch 封装，兼容 OpenAI/DeepSeek 接口
│   └── utils/
│       ├── icons.js          # 常用图标的 SVG 片段，统一注入按钮与状态
│       └── markdown.js       # 极简 Markdown 渲染，支持加粗、代码与列表```

## 功能亮点

- **界面结构**：复刻 Open WebUI 式的三段布局（侧边栏 / 消息主区 / 输入区），并提供移动端侧边栏折叠方案。
- **动态状态**：状态管理模块模拟消息流和模型回复，包含流式输出动画、会话预览和主题切换。
- **样式设计**：使用 CSS 变量维护深浅色主题，搭配玻璃质感与光标动效，方便后续自定义。
- **本地持久化**：会话与生成的意图 JSON 自动保存在浏览器 localStorage，刷新页面不会丢失，并可直接复制或下载 JSON。
- **模型提示**：每条意图消息会标记“由哪个模型生成”，并提供“查看 / 复制 / 下载 JSON”三个操作按钮。
   ```

- `js/config/modelPresets.js` 仍保留四个模型的前端配置，但前端实际会在启动时调用后端的 `/llm/providers`（定义于 `cfd-orchestrator/server/app.py`），以确认哪些模型已在服务器完成密钥配置，并同步下拉框。
- `/intent/fill` 请求会携带 `model_id`，后端据此从 `server/model_registry.py` 中选择合适的 base_url / model / api key 并向真实推理服务发起请求。
- 如果想扩展模型，只需在 `MODEL_PRESETS` 中新增一项，同时在服务器端按相同 ID 添加环境变量前缀配置，即可完整打通前后端。

“新建对话”按钮继续通过 ChatSidebar.js 中的 <img src="./assets/new-conversation-car.png"> 加载汽车缩略图，可在此处查找资源引用。“新建对话”按钮继续通过 ChatSidebar.js 中的 <img src="./assets/new-conversation-car.png"> 加载汽车缩略图，可在此处查找资源引用。

