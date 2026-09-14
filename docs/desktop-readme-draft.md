> 未发布草稿：桌面 0.2.0 尚未完成验证或发布。本文中的预期安装包、0.2.0 下载链接及 Windows 指南链接目前不可用；续做时修订后再使用。

# 直播搭子

给 B 站观众使用的 **Windows 桌面陪聊助手**。在程序里登录自己的 B 站账号、填写 AI API、打开主播的直播间，结合主播声音和新弹幕生成简短接话。支持由你确认后发送，也支持可取消倒计时的自动接话。

**0.2.0 beta 1 是桌面版公开测试版本。** 程序按 [MIT 许可证](LICENSE) 免费开放，可以自己使用或把安装包分享给朋友；每个人使用自己的 B 站账号和 API Key。无需 Chrome 商店、浏览器开发者模式、Node.js 或服务器。所选 AI 服务的 API 用量仍由服务商计费，ChatGPT 订阅不代替 API 额度。

[下载 Windows 测试版](https://github.com/SCUliujiacheng/live-companion/releases/tag/v0.2.0-beta.1) · [Windows 上手指南](docs/WINDOWS-QUICKSTART.md) · [隐私说明](PRIVACY.md) · [反馈问题](https://github.com/SCUliujiacheng/live-companion/issues)

## 安装与第一次使用

在 [Release 页面](https://github.com/SCUliujiacheng/live-companion/releases/tag/v0.2.0-beta.1) 选择 Windows x64 文件：

| 文件 | 用途 |
| --- | --- |
| `LiveCompanion-Setup-0.2.0-x64.exe` | 安装版，安装到当前 Windows 用户，创建桌面和开始菜单快捷方式。 |
| `LiveCompanion-Portable-0.2.0-x64.exe` | 便携启动版，直接运行。应用数据仍保存在当前用户的应用数据目录，并非全部保存在 EXE 旁边。 |

1. 安装或运行程序，在左侧 B 站页面通过 B 站自己的登录入口登录。应用使用独立登录状态，已有 Chrome / Edge 登录不会被自动导入。
2. 在顶部粘贴 `https://live.bilibili.com/房间号`，或直接输入房间号，点击「打开直播间」。确认直播正在播放，能听到主播声音。
3. 打开右侧设置，分别填写聊天与声音转文字的 API 地址、Key 和模型，保存。两组都使用 OpenAI 时，可以填入相同的 Key。
4. 填写当前 B 站昵称。先选择「我来确认」，再点「开始陪聊」。有合适的候选回复时，确认内容后点「现在发送」。
5. 确认转写、回复和账号发送都正常后，先点「结束」，再选择「自动接话」并重新开始。发送前可点「这句不发」取消。

程序不提供预置密钥，也不会自动创建服务商账号或 API Key。当前测试包未做代码签名，Windows 可能显示发布者未知；请从本项目 Release 获取文件。

## API 怎么填

| 设置 | 默认值 |
| --- | --- |
| 聊天 Base URL | `https://api.openai.com/v1` |
| 聊天模型 | `gpt-4.1-mini` |
| 语音转写 Base URL | `https://api.openai.com/v1` |
| 语音转写模型 | `gpt-4o-mini-transcribe` |
| API Key | 在程序中自行填写，源码及发行包不包含用户密钥。 |

聊天与转写可独立使用不同服务。服务需兼容对应的 OpenAI HTTP 格式：聊天使用 `POST /chat/completions`；转写使用 `POST /audio/transcriptions`，接受 multipart WAV 文件，返回带 `text` 字段的 JSON。Base URL 填到 `/v1` 等公共前缀，不要填写完整的 `/chat/completions` 路径。支持 HTTPS，以及 localhost / 127.0.0.1 / ::1 的本机 HTTP 服务。

「保存并测试聊天」发送很短的真实测试请求，会产生少量 API 用量。「保存并检查转写连接」只检查 `/models` 认证和模型可见性，**不代表实际音频转写已经成功**。部分兼容服务不提供模型列表，需按服务文档核对；实际转写从开始陪聊后进行。

## 账号、密钥和本机数据

- **B 站登录**：由应用内独立的 Chromium 会话保存，下次启动可复用。程序不复制已有浏览器配置，不提取登录 Cookie 值，也不把登录状态交给 AI。
- **默认 API Key**：只留在本次应用运行内存，完全退出程序后需要重新填写。普通设置会保存。
- **记住 API Key**：主动勾选后，通过 Windows 系统加密保存在当前用户的数据目录。系统加密不可用时，拒绝持久保存密钥。
- **「清除本机设置与密钥」**：停止陪聊，删除 API 设置、密钥和本次上下文，**保留 B 站登录状态**。
- **顶部「退出登录」**：确认后停止陪聊，清除应用内 B 站 Cookies 和网页本地存储；保留 API 设置与密钥。

设置文件是 Electron `userData` 目录中的 `settings.json`，Windows 通常位于 `%APPDATA%\直播搭子\`。分享安装包即可，不要把自己的应用数据目录、Key 或登录信息一起分享。

声音片段和近期弹幕直接发送到你填写的 AI 服务。程序没有开发者运营的数据服务器，也不把音频写成录音文件。第三方服务的数据保存、训练和删除规则由该服务决定，详见 [隐私说明](PRIVACY.md)。

## 挂着陪聊时

- 最小化窗口可以继续运行；电脑需要保持开机联网，直播页面保持播放。关闭主窗口会结束陪聊并退出，不会隐藏到托盘继续运行。
- 系统睡眠、休眠、关机或网络中断会使陪聊中断，不能在关机后继续。恢复后检查状态，需要时重新开始。
- 默认至少间隔 45 秒，每条最多 30 字。这是发言限制，不是固定发言周期；模型可以选择安静。
- 「暂停陪聊」取消生成与待发回复；「结束」还会释放音频捕获。主播唱歌时可手动打开「主播正在唱歌」。自动判断基于转写和弹幕，不能可靠识别所有歌词、背景音乐或说话人。
- 自己的弹幕、主播念弹幕和过期话题会经过过滤，但回复质量仍需实际观察。输入框已有内容或正在获得焦点时，助手拒绝覆盖；发送结果未确认时暂停，不重复点击发送。
- 普通「结束」保留已显示文字供查看；重新开始、清除本机数据或退出应用会清除相应会话记录。

## 测试范围与已知限制

已有回归检查覆盖 API 配置和请求、密钥存储边界、冷却和复读处理、暂停取消、过期回复、模拟页面的读取与发送保护，以及桌面 UI 和捕获消息桥的隔离检查。已对真实 Chrome 中的 B 站页面做过只读 DOM 核对，这不等于桌面程序已经成功发过真实弹幕。

**本次桌面音频完整链路与最终 EXE 的安装启动验证仍在进行，最终结果以对应 Release 的发布说明为准。真实 OpenAI 转写、真实模型回复质量及桌面程序使用真实 B 站账号发送，尚未完成端到端验证。** 本版本没有为用户创建 OpenAI Key，也没有使用用户真实凭据完成这些测试。

B 站网页结构会变化，网页适配不等于官方接口。无法识别弹幕或输入框时，先结束陪聊并检查更新。直播流、音频分段和 API 请求均有延迟，因此不属于零延迟语音助手。

## 浏览器扩展仍可选用

`extension/` 保留 Chrome / Edge 侧边栏版本。可从源码加载该目录，或使用 [0.1.1 扩展测试版](https://github.com/SCUliujiacheng/live-companion/releases/tag/v0.1.1-beta.1) 的 `live-companion.zip`：打开 `chrome://extensions` 或 `edge://extensions`，启用开发者模式并「加载已解压的扩展程序」。扩展要求 Chrome 116+；Edge 实机兼容性仍需确认。

扩展本地存储未额外加密，默认 Key 使用浏览器会话存储；清除数据还会撤销可选 API 站点权限。两个版本的设置与登录独立。扩展尚未上架 Chrome Web Store；`store/` 保留先前的提交准备材料，Windows 使用和朋友之间分享安装包不需要走商店流程。

## 开发与打包

开发需要 Node.js 20+。普通使用者运行发布的 EXE 即可，无需安装这些工具。

```powershell
npm install
npm test
npm run check
npm run desktop:start
```

在 Windows 上构建安装版和便携版：

```powershell
npm run desktop:dist
```

桌面输出目录为 `dist-desktop/`；`npm run package` 继续用于扩展 ZIP。浏览器回归检查使用 Playwright，可通过 `LIVE_COMPANION_BROWSER` 指定 Chromium。缺少浏览器依赖时，相应测试会跳过或提示安装，不能视为已通过浏览器验证。

架构见 [桌面版设计](docs/desktop-design.md) 和 [原扩展设计](docs/design.md)。本项目与 B 站、Google、OpenAI 无官方隶属关系。
