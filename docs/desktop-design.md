# Windows 本地版

用户流程：安装 EXE → 在程序内登录 B站 → 填聊天和转写 API → 打开直播间 → 开始陪聊。无需开发者模式、Chrome 商店、Node.js 或部署服务器。分享安装包即可，API Key 和 B站登录状态均由每位用户自行提供。

界面由本地面板和隔离的 B站 WebContentsView 组成。网页不能调用设置、文件、密钥或模型 API。主进程负责设置、模型请求和发送调度；网页预加载仅转发新的弹幕与受控发送结果，沿用已有 DOM 适配器。

仅捕获内置直播网页的声音：webContents.getMediaSourceId(本地面板 WebContents) 配合现有 AudioWorklet 分段。不开麦、不抓取系统其他应用声音。Electron 保留源网页声音，所以桌面捕获关闭额外监听回放。

默认密钥仅驻留进程内存。主动记住时用 Electron safeStorage 加密保存到当前 Windows 用户的数据目录。直播页面 Cookie 由独立 Chromium 会话保存，不读写用户现有 Chrome Profile。清除 AI 配置不注销 B站，另设退出 B站登录按钮。

安装采用 electron-builder NSIS 当前用户安装，不要求管理员权限；同时提供便携版。先验证真实 Electron 的页面加载、捕获和本机模拟 API 全链路，再用用户自行申请的 OpenAI Key 和已授权 B站账号验证实际互动。没有凭据时不得把模拟测试说成真实 API 测试。
