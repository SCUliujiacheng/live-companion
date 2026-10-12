# 续做记录：Windows 版

最新状态（2026-10-12）：用户已恢复开发，随后要求后续开发、测试和模型下载移到 dot / 云端，避免占用个人电脑。本机进程已停止。**请先读 [CLOUD-HANDOFF.md](CLOUD-HANDOFF.md)，它取代下方旧记录中的待办和状态。** 当前上传为未完成的检查点，不代表 dot 已接手或 Windows 安装包已可交付。

以下保留 2026-09-14 的历史记录，不能当作当前验证结论。

## 用户要什么

- 自己和朋友在 Windows 本机安装，登录 B站，填写 API 后能在直播间挂着陪聊。
- 根据主播声音和新弹幕自然接话；使用自己的观众账号。用户已授权拿自己的 B站账号测试。
- 优先本地 EXE 安装包，不需要付费注册 Chrome 商店。现有公开 GitHub 仓库保留。
- 默认 OpenAI，聊天与转写各自支持 Base URL、Key、模型配置。
- 用户要求申请新 OpenAI API Key，但 OpenAI Platform 连接器当前未连接；没有创建任何密钥、没有充值或调用真实 OpenAI。

## 已保存的实现

- `desktop/main.js`：Electron BrowserWindow 本地界面 + 隔离 WebContentsView 直播网页、受控 IPC、来源校验、关闭清理。
- `desktop/controller.js`：复用现有策略和模型接口，处理音频转写队列、候选回复、人工或自动发送、取消与停止。
- `desktop/storage.js`：默认密钥在进程内存；主动记住时通过 safeStorage 加密写入当前用户数据目录。
- `desktop/ui/`：72px 工具栏、420px 侧栏，打开房间、设置、刷新、退出 B站。
- `desktop/room-preload.cjs` + `extension/content.js`：构建时拼接到 `desktop/generated/room-preload.cjs`；远程页面不暴露 Node 或密钥接口。
- `extension/audio/capture.js` 增加第三参 `{monitorPlayback:false}`，桌面版避免再次播放捕获音频。
- 已安装 npm 开发依赖 Electron 44.3.0、electron-builder 26.15.3、Playwright 1.63.0，版本锁在 package-lock.json。
- `electron-builder.yml` 配置 NSIS 当前用户安装与便携版。

## 验证边界

- 暂停前最终 `npm test`：88/88 通过，0 跳过；`npm run check` 和桌面 JS 语法检查通过。
- 已读取用户当前 Chrome 中真实 B站直播间 DOM，确认弹幕 `.chat-item.danmaku-item`、dataset.uname/danmaku 和 `#chat-control-panel-vm` 输入区匹配现有适配器。没有发送测试弹幕，没有改动用户正在写的内容。
- 隔离浏览器已验证桌面界面布局、设置保存、音频回调取消逻辑。
- `npm run desktop:pack` 曾成功生成 `dist-desktop/win-unpacked/直播搭子.exe`，但这是较早的开发构建，后续主进程已有修改。不能当成当前可交付安装包。
- **尚未完成真实 Electron 音频捕获、实际桌面整体联调、真实 OpenAI 转写与聊天、真实 B站账号发送。** 没有构建/发布最终 NSIS 安装包。

## 下次优先解决

1. 音频权限：运行 `node scripts/desktop-audio-smoke.mjs`。目前 `getUserMedia` 返回 `NotAllowedError: Permission denied`。探针已确认：`source.webContents.getMediaSourceId(receiver.webContents)` 的 media 权限请求发生在 **source 的 session**，details.securityOrigin 是可信 receiver，mediaTypes 为 `[]`。当前 source session 全拒绝导致失败。应仅在本次已授权捕获期间，精确校验源 WebContents、可信 origin 和请求类型后放行；不开放远程页面通用麦克风权限。
2. 上述脚本准备了两个分区中的 440Hz/880Hz 测试音源；完成后验证只捕获目标网页、静音目标后不捕获另一网页、停止释放资源、源网页仍能播放。当前还未取得有效 WAV/频谱结果。
3. 运行 `node scripts/desktop-integration-smoke.mjs`。真实应用 UI、IPC、设置已能启动；隔离 HTTPS 页面 fixture 出现 `chrome-error://chromewebdata/`，导致无法找到 `#play`。需要调查测试协议响应/加载错误。不要把它误报为真实 B站适配失败或成功。
4. Playwright Electron 启动不要显式填写裸 electron.exe 路径；本机 `_electron.launch({args:[...]})` 能启动，显式 executablePath 曾导致 startup loader 超时。
5. 用户连接 OpenAI Platform 后，按 openai-platform-api-key 技能继续新密钥流程。此前 `open_codex_api_key_setup({})` 返回 USER_NOT_LOGGED_IN，尚未打开 picker，也未确认本机保存位置。密钥不得进入源码、截图、日志或安装包。
6. 实际应用需要用户在内置 B站网页重新登录，不能复制现有 Chrome Profile/Cookie。真实发送前保留用户正在填写的文本，只发送必要的少量测试消息。
7. 完成实际集成与密钥测试后再运行 `npm run desktop:dist`、安装验证、更新说明及发布新测试版。当前公开版本仍是 v0.1.1-beta.1 扩展版，桌面0.2.0尚未发布。

## 命令与输出

```powershell
npm test
npm run check
npm run desktop:build
npm run desktop:start
node scripts/desktop-audio-smoke.mjs
node scripts/desktop-integration-smoke.mjs
npm run desktop:dist
```

开发测试使用临时用户数据目录，退出后已清理测试 Electron 进程及本轮临时 profile。不要删除真实用户的浏览器或应用数据。
