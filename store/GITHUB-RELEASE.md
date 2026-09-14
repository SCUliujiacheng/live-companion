直播搭子首个公开测试版：结合 B站直播声音和新弹幕，为观众生成简短接话，提供人工确认与可取消的自动发送。

### 下载

- **普通用户**：下载 `live-companion.zip`，解压后在 Chrome 扩展页面开启开发者模式，加载包含 `manifest.json` 的文件夹。
- **商店发布准备**：`live-companion-chrome-web-store.zip` 是根目录含 manifest 的商店上传包，不代表已在商店上架。

### 已包含

- 可独立填写聊天 / 语音转写的 API 地址、Key 与模型，默认 OpenAI。
- 发言冷却、防复读、自我回声处理、过期回复作废、输入框保护。
- 暂停、唱歌暂停、发送前取消及发送结果不确定时不重试。
- 默认会话密钥、可选本机保存、一键清除本机数据与 API 站点授权。
- MIT 许可证、隐私政策及商店提交资料。

### 使用前了解

这是早期测试版。隔离浏览器、模拟页面和本机模拟 API 测试已经覆盖主要流程；真实直播间页面适配、真实 OpenAI 转写、聊天质量和账号发送仍需用户填 Key 后验证。Edge 尚未实机验证。尚未提交 Chrome Web Store 审核。

每位使用者需自行提供 API Key；程序不附带共享密钥，API 用量由所选服务商计费。音频片段、近期弹幕和转写会发往使用者填写的服务。请阅读 [安装说明](https://github.com/SCUliujiacheng/live-companion#readme) 和 [隐私政策](https://github.com/SCUliujiacheng/live-companion/blob/main/PRIVACY.md)。
