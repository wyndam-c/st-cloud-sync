# Changelog · 变更记录

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)（语义化版本 `MAJOR.MINOR.PATCH`）。

## [v1.2.0] — 2026-09-25

插件能自己更新了 🎉

- 🔄 **一键更新 / 自动拉取**：面板新增「检查更新」与「⬆️ 一键更新」。检查会用 `git fetch` 比对远端，告诉你落后几个提交、新版是什么；一键更新执行 `git pull --ff-only`，并自动把 `extension/` 三件套一起刷到酒馆扩展目录（否则浏览器还是旧界面），完成后提示**重启酒馆**生效。
  - 新增配置：`updateBranch`(默认 `main`)、`autoUpdateCheckMinutes`(默认 `0`=关)、`autoUpdate`(默认 `false`)。
  - 新增 API：`GET /update`、`POST /update/check`、`POST /update/apply`；`GET /status` 也会带上更新状态。
- 📦 **`install.sh --git`**：直接把本仓库 `git clone` 到 `plugins/st-cloud-sync/`，插件目录成为 git 工作区 → 酒馆自带的「更新插件」按钮也能用；已有 `config.json` 会自动保留。
- 🆕 **`update.sh`**：命令行一键更新（pull + 刷新扩展 + 提示重启）。
- 🧯 非 git 安装会在面板里明确提示「不是 git 安装，跑一次 `./install.sh --git` 即可」，不会静默失败。
- 📚 文档：README / `docs/INSTALL.md` 新增「自动更新」与 `--git` 安装说明。
## [v1.1.0] — 2026-09-25

增量/定向同步 + 实时进度，都在面板里点。

- 🚦 **增量 / 全量可选**：面板新增「增量同步」开关。开（默认）= 按「大小 + 修改时间」快速判断，只传真正变了的；关 = 关掉 `fastcheck`，按内容校验做**全量比对**（慢一点，但最保险）。对应 Unison profile 的 `fastcheck = true|false`。
- 🎛️ **一键定方向**：面板新增两个按钮 ——「☁️ 按云酒馆同步」(云端→本地) 与「💻 按本地酒馆同步」(本地→云端)。走的是**一次性方向覆盖**：本次按它跑，**不动你保存的配置**，跑完自动把 profile 恢复成配置里的方向。
- 📊 **实时进度弹窗**：手动发起同步时自动弹出，含进度条、当前正在传的文件、已完成/传输/跳过/失败计数、耗时、实时日志；支持**中止**与**后台运行**；收尾给出汇总。自动同步（每 N 分钟那次）默认**不弹窗打扰**，需要时点「查看进度」。
- 🟡 **「文件正在使用」不再误报**：酒馆正在写的文件（`settings.json`、正在聊的 `.jsonl`、世界书…）被 Unison 拒绝传输时，会单独标成「正在被酒馆使用，已跳过，下一轮自动补」，**不计入失败**，状态栏也是黄色提醒而非红色报错。
- 🐛 **修 `Synchronization incomplete` 解析**：有失败时 Unison 的汇总行写的是 `incomplete`（不是 `complete`），旧代码只认后者 → 导致失败数一直是空。
- 🐛 **修前端崩溃**：`setInterval` 返回的是数字，旧代码往返回值上挂属性，严格模式下直接 `TypeError`。
- 🧹 服务端日志 `last-sync.log` 超过 4 MB 自动只留尾部，不再无限膨胀。

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
