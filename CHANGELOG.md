# Changelog · 变更记录

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)（语义化版本 `MAJOR.MINOR.PATCH`）。

## [v1.0.0] — 2026-09-23

首个公开版本 🎉

- 🔁 **双向同步**整个 `data/` 目录（Unison over SSH）；删除同样双向传播（真·镜像）
- ⚖️ **冲突安全**：冲突时「较新者赢」，被覆盖一方保留 `xxx (conflict_on_日期)` 副本，不静默丢数据
- 👥 **多用户**：同步根为 `data/` 整个目录，所有用户目录自动纳入
- ⏰ **定时 + 手动**：可设每 N 分钟自动同步（默认 10），也可在面板一键「立即同步 / 中止 / 试运行」
- ⚙️ **面板可配**：主机 / 端口 / 两边 data 路径 / SSH 私钥 / 同步方向 / 冲突策略 / 排除项 / 定时间隔
- 🧯 **默认排除服务端私有文件**：`_storage`(账号库) / `cookie-secret.txt` / 日志 / 构建产物
- 🧩 **零第三方运行时依赖**：插件仅用 Node 内置模块；引擎为系统 `unison` + `ssh`
- 📦 服务端插件 + 前端扩展；`install.sh` / `uninstall.sh` 一键装卸
- 📚 文档：`README.md` / `docs/INSTALL.md`（Linux/Docker/macOS/Windows）/ `docs/TROUBLESHOOTING.md`
