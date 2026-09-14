# 参与开发

欢迎修复 B站网页适配、改善语音分段和补充兼容 API 测试。请先提交简短 Issue 说明问题，再针对一个问题发起 Pull Request。

1. 安装 Node.js 20+，克隆仓库。
2. 直接在浏览器加载 `extension/`；运行 `npm test`、`npm run check`。
3. 浏览器集成测试可安装 Playwright：`npm install --no-save --package-lock=false playwright`，然后 `npx playwright install chromium`。运行 `node scripts/browser-smoke.mjs` 和 `node scripts/config-smoke.mjs`。测试使用隔离浏览器与本机模拟 API，不需要真实密钥。
4. 发言、取消、DOM 适配、API 和音频生命周期的修改应附带有意义的回归测试。

请勿提交 API Key、Cookie、浏览器配置文件、私人直播记录或包含隐私的截图。普通问题报告仅需浏览器版本、插件版本、错误提示和脱敏复现步骤。测试自动发送时使用模拟页面；对真实直播间的行为由测试者本人决定。

所有贡献按仓库 MIT 许可证提供。
