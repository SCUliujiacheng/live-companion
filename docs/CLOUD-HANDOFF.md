# 云端续做：Windows 直播搭子

更新时间：2026-10-12。分支：`wip/windows-desktop`。

## 最新工作边界

用户要求后续开发、下载模型和测试放到 dot / 云端，避免占用个人电脑；做好后推到 GitHub，再由用户下载安装验收。不要重新在用户电脑启动 Electron、浏览器测试、语音识别或构建。本机进程已停止，代码保存为待完成的检查点。

当前本地会话没有直接调度 dot 或将自己迁移到云端的接口；上传此记录不代表 dot 已经接手。GitHub Actions 可执行仓库里的云端验证与 Windows 打包。dot 续做时应使用它自己的云电脑或已配置此仓库的 Codex 云环境，不要调用用户的个人电脑。

## 要交付的产品

- Windows 安装包和便携版；朋友安装后登录 B站即可配置使用。
- 使用观众账号，根据主播语音和新弹幕自然接话；先支持 B站。
- 两种 AI 接入：优先 ChatGPT 官方账号授权 + 本地语音识别，也支持可配置 Base URL、Key、模型的聊天/转写 API。
- 账号授权先实现 ChatGPT；其他厂商以后通过各自正式支持的授权方式扩展。
- 保留人工确认、自动发送倒计时、暂停、停止、冷却、去重、自身消息过滤及超时后不重发。
- 公开源码与安装包到本仓库，无需 Chrome 商店。真实登录和实际直播间验收由用户稍后在自己的电脑完成。

## 已保存的实现

- Electron 隔离直播 WebContentsView、本地面板、受控 IPC、持久化设置与 safeStorage 加密。
- `desktop/capture-permission.js`：单次、短期、精确匹配来源和接收窗口的音频捕获授权，解决 source session 权限拒绝；远程网页仍不获得通用麦克风权限。
- `desktop/chatgpt-client.js`：独立实现官方 OSS Sign in with ChatGPT 协议，PKCE、state、nonce、JWT 验证、加密账号、多账号切换、刷新、退出与取消；不复制第三方浏览器 Cookie。
- `desktop/local-speech.js` / `local-speech-worker.js`：worker 中运行 CPU Whisper，首次显式下载、固定 revision、模型权重 SHA-256 校验、离线缓存及取消。
- `desktop/ai-router.js`：ChatGPT + 本地识别与原 API 路线分流；main/controller/preload 已接入。
- 桌面 UI：账号授权、共享额度状态、模型/账号选择、本地模型下载状态、API 设置与共享聊天偏好。
- Windows NSIS/portable 配置，256px 图标源码与 ICO 构建；`.github/workflows/ci.yml` 包含 Linux 验证和 Windows EXE 构建。

## 停止前的验证证据

以下为分项结果，**不是最终整套回归或可发布证明**：

- 实际 Electron 目标网页音频捕获通过：1 条音轨、0 条视频轨；440Hz 目标音源与 880Hz 非目标音源隔离；停止释放资源；无效、重复、取消令牌被拒绝。
- 实际 Electron + 隔离 B站页面 fixture + 假 API 的手动发送、回显、暂停和停止链路通过。真实 WAV multipart 到达假转写服务（768516 字节）。未在真实直播间发送消息。
- ChatGPT 协议单测 16/16 通过，包括真实签名 JWT 校验、刷新与 SSE 错误处理，以及取消登录持久化竞态回归。未进行真实账号授权或推理。
- 本地识别单测 6/6 通过。真实模型下载最后确认到 90%，未取得真实中文识别结果；不能称 ASR smoke 通过。
- 桌面主进程单测 7/7 通过；controller / preload / 权限测试有通过的分项结果；新 AI router 测试尚未运行。
- UI 在 1500×940、1120×760 的 mock 状态流程检查通过；原侧栏测试 3/3。登录、模型和下载状态在这些 UI 检查中为模拟值。
- 升级到 `@huggingface/transformers` 4.3.1 后生产依赖审计为 0 个漏洞；开发依赖仍有审计项待评估。
- Windows 打包曾因图标只有 128px 失败，已增加 256px 源图与 ICO 构建；修改后未重跑打包。
- 自动发送/暂停取消扩展、AI router 集成及整个最新工作区尚未完整回归。旧 `dist-desktop` 输出不可交付。

## 云端优先事项

1. 从本分支拉取最新提交，运行完整单测和检查，处理现有失败。不要用旧 main 覆盖桌面工作。
2. 对照最新官方文档复核 ChatGPT 动态注册返回的 client ID 是否在换取令牌前持久化，以及取消/磁盘写入/切换账号之间的竞态、刷新与 scope 检查。
3. 检查 AI router 登录回调后是否及时拉取模型列表并更新 UI；首次测试或开始时会尝试拉取，但当前回调通知本身未必加载目录。
4. 验证首次无 API Key 的 ChatGPT 路线和 API 路线。模拟协议与真实授权分别记录，缺少真实凭据时不可宣称已通过。
5. 运行真实 Whisper 中文音频、取消后下一次识别、重启离线缓存；确认 worker 和 ONNX 原生依赖在 Electron 打包后仍可加载。当前 smoke 使用 Windows SAPI 的 Microsoft Huihui Desktop；云 Windows 可能没有该语音，需要可分发的公开合成测试音频或明确跳过理由。
6. 运行 Electron integration smoke 新增的自动倒计时发送与暂停后不得迟发检查。无适当桌面或音频设备的 runner 不能代替 Windows 原生音频验收。
7. 构建 NSIS 和 portable，检验安装、启动、卸载和全新用户数据目录；评估 ONNX 包中其他平台二进制是否应从 Windows 分发包排除。
8. 通过可执行检查后发布标注限制的 Windows 测试版，给出下载链接和用户验收步骤；不把流水线 artifact 或旧扩展 ZIP 描述成已验证的 Windows 正式版。

## 云端命令参考

```sh
npm ci
npm test
npm run check
npx playwright install --with-deps chromium
node scripts/browser-smoke.mjs
node scripts/config-smoke.mjs
npm run desktop:build
node scripts/desktop-audio-smoke.mjs
node scripts/desktop-integration-smoke.mjs
node scripts/desktop-local-speech-smoke.mjs
npm run desktop:dist
```

Electron 和语音 smoke 需要相应平台的桌面/音频支持；最后一条使用 Windows runner。首次语音模型下载仅在云端执行。不要把模型缓存、浏览器资料、账号令牌、API Key、用户录音或本机测试日志提交到仓库。

## 已知实现细节

- 官方账号路线文档：https://developers.openai.com/siwc/token-sharing-open-source/sign-in 、https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference 。使用独立实现，不复制受不同许可证约束的示例代码。
- 账号额度状态页为 `https://chatgpt.com/settings/usage`；此路线不提供音频转写，使用本地 Whisper。
- Whisper：`onnx-community/whisper-base`，revision `1846881b6b3a3024392c1eea3ad983695bc23925`，q8 CPU。
- 音频 permission 请求发生在 source session；custom origin 的实际值为 `companion://app/`。不要重新开放远程会话的通用 media 权限。
- Electron integration fixture 使用 ASCII User-Agent，避免带中文产品名的默认 UA 被测试用 WHATWG Request header ByteString 拒绝。该修复仅用于 fixture，不代表需要修改真实 B站网络。
- 本机临时 profile 与下载缓存已保留且未上传；云端应使用新隔离 profile，不继承用户登录。

## 可直接发给 dot 的续做请求

> 请在你自己的云电脑或已配置的 Codex 云环境继续开发 https://github.com/SCUliujiacheng/live-companion 的 `wip/windows-desktop` 分支。先读 `docs/CLOUD-HANDOFF.md`。不要使用或启动我个人电脑上的程序、测试、下载和构建。完成 Windows B站直播聊天软件的 ChatGPT 账号授权 + 本地语音识别与自填 API 两种接入，修复并跑完云端能完成的测试，用 GitHub Windows runner 构建安装包。完成后推回这个 GitHub 仓库并发布标注验证范围的测试版，我稍后在本机做真实登录和直播间验收。
