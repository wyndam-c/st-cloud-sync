# ST Cloud Sync · 酒馆云同步

在**两台 SillyTavern** 之间**双向**同步整个 `data` 目录（多用户），基于 **Unison over SSH**。

A SillyTavern **server plugin + extension** that **bidirectionally** syncs the whole `data` directory (all users) between two taverns, powered by **Unison over SSH**.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.0.0-brightgreen.svg)](CHANGELOG.md)
[![SillyTavern](https://img.shields.io/badge/SillyTavern-server%20plugin-7c3aed.svg)](https://github.com/SillyTavern/SillyTavern)
[![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20Docker%20%7C%20macOS%20%7C%20Windows-lightgrey.svg)](docs/INSTALL.md)

---

## ✨ 特性

- 🔁 **双向同步**：云端改的落本地，本地改的推云端，删除同样双向传播（真·镜像）。
- 👥 **多用户**：同步根是 `data/` 整个目录，**所有用户目录自动纳入**，无需逐个配置。
- ⚖️ **冲突安全**：冲突时「较新者赢」，被覆盖的一方保留为 `xxx (conflict_on_日期)` 副本，**不静默丢数据**；Unison 还会为改动/删除的文件留旧版本备份。
- ⏰ **定时 + 手动**：可设每 N 分钟自动同步（默认 10），也能在酒馆「扩展」面板里一键「立即同步 / 中止 / 试运行」。
- ⚙️ **面板可配**：主机、端口、两边 data 路径、SSH 私钥、同步方向、冲突策略、排除项、定时间隔，全在 UI 里改。
- 🧩 **零第三方运行时依赖**：插件只用 Node 内置模块；引擎是系统的 `unison` + `ssh`。
- 🧯 **默认不动服务端私有文件**：`_storage`(账号库) / `cookie-secret.txt` / 日志 / 构建产物自动排除。

## 🧠 工作原理

```
┌─────────────────┐        Unison over SSH        ┌─────────────────┐
│  云端 SillyTavern │  <──────────────────────────▶ │  本地 SillyTavern │
│  /…/SillyTavern  │   (双向, 冲突较新者赢)          │  /…/SillyTavern  │
│  data/ + all users│                               │  data/ + all users│
└─────────────────┘                                └─────────────────┘
        ▲                                                   ▲
        │ 远端只需装 unison                                    │ 服务端插件负责调度
        └───────────────────────────────────────────────────┘
```

- **服务端插件**（`plugins/st-cloud-sync/`）：真正的同步引擎。生成 Unison profile、跑 `unison -batch`、管理定时器、暴露 HTTP API。
- **前端扩展**（`data/<user>/extensions/st-cloud-sync/`）：扩展面板里的操作 UI，调用插件 API。

> 为什么不用 rsync？rsync 无法安全双向——两边会互相覆盖，且删除会「复活」。双向必须用能判断冲突的同步器，Unison 是经典方案。

## 📋 环境要求

| 项 | 要求 |
| --- | --- |
| 两端酒馆 | 支持服务端插件（`config.yaml` 里 `enableServerPlugins: true`），建议 1.12+ |
| **两端都要装 `unison`** | **版本必须完全一致**（Unison 硬性要求，不一致直接拒连）|
| 本机 | `ssh`、可达远端 22 端口、一把能免密登录远端的 SSH 私钥 |
| 系统 | Linux→Linux 最顺；Docker / Windows / macOS 见 [INSTALL.md](docs/INSTALL.md) |

安装 unison（Debian/Ubuntu）：`sudo apt-get install -y unison`

## 🚀 快速开始

```bash
git clone https://github.com/wyndam-c/st-cloud-sync.git
cd st-cloud-sync
./install.sh /path/to/SillyTavern        # 默认会自动探测常见路径
```

然后：

1. 确认远端也装了**同版本** unison：`unison -version`（两边输出要一致）。
2. **准备一把免密登录远端的 SSH 私钥**（没有就现生成一把，见下方「🔑 生成并安装 SSH 私钥」）。
3. 酒馆 `config.yaml` 设 `enableServerPlugins: true` 并重启酒馆。
4. 打开酒馆 →「扩展」→ **云同步 (Cloud Sync)** → 填远端主机/用户/data 路径/私钥 → **保存配置** → 先点 **试运行**（可选）→ 再点 **立即同步**。

> 首次同步务必先看日志；要删本地多余文件请确认「同步方向/删除」策略符合预期。

### 🔑 生成并安装 SSH 私钥（免密登录远端）

在**本地**（跑酒馆插件的那台）执行：

```bash
# 1) 生成一把专用密钥： -N "" = 不设密码（免密）；-f 指定私钥文件路径
ssh-keygen -t ed25519 -f ~/.ssh/cloud_sync_ed25519 -N "" -C "st-cloud-sync@$(hostname)"
#   → 生成两个文件：
#      ~/.ssh/cloud_sync_ed25519      私钥（留在本地，面板里填这个路径）
#      ~/.ssh/cloud_sync_ed25519.pub  公钥（下面要装到远端）

# 2) 把【公钥】装到远端（会提示输入一次远端账户密码）
ssh-copy-id -i ~/.ssh/cloud_sync_ed25519.pub root@REMOTE_HOST

#    ✔ 等价的手动做法（没有 ssh-copy-id 时用，例如 Windows/PowerShell）：
#    cat ~/.ssh/cloud_sync_ed25519.pub | ssh root@REMOTE_HOST \
#      'mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys'

# 3) 验证免密：**不再提示输入密码** 就是成功（能打印远端主机名）
ssh -i ~/.ssh/cloud_sync_ed25519 root@REMOTE_HOST hostname
```

要点：

- **私钥**（`…ed25519`，无 `.pub`）→ 只留本地，面板「SSH 私钥」填它的**绝对路径**。
- **公钥**（`…ed25519.pub`）→ 装到远端 `~/.ssh/authorized_keys`（远端用哪个账户登录，就装到哪个账户的 `~` 下；非 `root` 时换成对应用户）。
- 已经有现成密钥？把上面的 `-f` 换成你的路径即可；想看公钥内容用 `cat ~/.ssh/你的密钥.pub`。
- 远端 `~/.ssh` 权限要 `700`、`authorized_keys` 要 `600`，否则 sshd 会**拒绝**该公钥。
- 本地酒馆若跑在 **Docker** 里，私钥得挂载进容器，面板填**容器内**路径。

> 更细的手动排错（权限、非 root 用户、Docker/Windows）见 [docs/INSTALL.md](docs/INSTALL.md#1-准备-ssh-免密)。

## ⚙️ 配置项

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `profile` | `st-cloud-sync` | Unison profile 名（生成于 `~/.unison/<name>.prf`）|
| `unicmd` | `unison` | unison 可执行文件路径 |
| `localDataRoot` | `/root/SillyTavern/data` | 本地 data 根 |
| `remoteUser` / `remoteHost` / `remotePort` | `root` / *(必填)* / `22` | 远端 SSH 信息 |
| `remoteDataRoot` | `/root/SillyTavern/data` | 远端 data 根 |
| `sshKey` | `/root/.ssh/cloud_sync_ed25519` | 免密登录远端的私钥 |
| `direction` | `both` | `both` 双向 / `to_local` 云→本 / `to_remote` 本→云 |
| `prefer` | `newer` | 冲突策略：`newer` / `local` / `remote` |
| `autoSyncMinutes` | `10` | 自动同步间隔分钟；`0` = 关 |
| `excludes` | 见下 | 忽略项（按 basename 匹配）|

默认忽略：`cookie-secret.txt`、`access.log`、`content.log`、`_cache`、`_css`、`_webpack`、`_errors`、`_storage`、`node_modules`、`backups`、`extensions`。

> ⚠️ **`_storage` 不要同步**：那是账号库，Unison 的冲突副本会被 ST 误认成「多了个用户」，导致登录异常。账号请各机单独管理。

## 🔌 HTTP API

挂载于 `/api/plugins/st-cloud-sync`（受 ST 登录会话 + CSRF 保护）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/status` | 状态 + 配置 + 用户列表 + 日志尾部 |
| GET | `/config` | 读配置 |
| POST | `/config` | 存配置（同时重写 Unison profile）|
| POST | `/test` | 测 SSH + 远端 unison 版本 |
| POST | `/sync` | 开始同步 |
| POST | `/abort` | 中止 |

## 🧰 常见问题

见 [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)（unison 版本不一致、403、`_storage`、Docker/Windows 等）。

## 📄 License

[MIT](LICENSE) © 2026 WhiteCrow

## 🏷️ 版本

当前版本 **v1.0.0**。变更记录见 [CHANGELOG.md](CHANGELOG.md)。

- 扩展面板显示的版本来自 `extension/manifest.json` 的 `version`
- 服务端插件版本来自 `plugin/index.mjs` 的 `info.version`
- GitHub 页面上的“版本”来自 **Releases / Tag**（当前 tag：`v1.0.0`）
