# 安装与部署指南

## 0. 总览

同步发生在 **本地那台酒馆**（跑插件的那台）和 **远端那台酒馆** 之间。插件只在**本地**一侧运行，通过 SSH 去操作远端，所以：

- 本地：装插件 + `unison` + `ssh` + 一把免密登录远端的私钥。
- 远端：**只需装 `unison`（版本必须与本地一致）**，并把本地那把公钥加进 `~/.ssh/authorized_keys`。

---

## 1. 准备 SSH 免密

在**本地**（跑插件的那台）生成一把专用钥匙：

```bash
ssh-keygen -t ed25519 -f ~/.ssh/cloud_sync_ed25519 -N "" -C "st-cloud-sync@$(hostname)"
ssh-copy-id -i ~/.ssh/cloud_sync_ed25519.pub user@REMOTE_HOST
# 验证：
ssh -i ~/.ssh/cloud_sync_ed25519 user@REMOTE_HOST hostname
```

> 如果本地酒馆是 Docker 跑的，这把钥匙要放在**容器内**能访问到的位置（建议挂载进容器）。

## 2. 在两端安装 unison（版本要一致）

Debian / Ubuntu：

```bash
sudo apt-get update && sudo apt-get install -y unison
unison -version        # 两边输出必须一致，例如 2.53.3 (ocaml 4.14.1)
```

> ⚠️ Unison 要求两端版本**完全一致**。若源里版本不同，可考虑用相同发行版，或用 Unison 官方的静态二进制（需自行保证版本号一致）。
>
> 若远端 `unison` 不在默认 PATH，可在 profile 里加一行 `servercmd = /绝对路径/unison`（编辑 `~/.unison/<profile>.prf`，但注意——改配置会被插件覆盖，建议在插件配置里扩展或改用同名软链到 PATH）。

## 3. 装插件

```bash
git clone https://github.com/wyndam-c/st-cloud-sync.git
cd st-cloud-sync
./install.sh /path/to/SillyTavern
```

脚本会：

1. 安装服务端插件到 `<ST>/plugins/st-cloud-sync/`
2. 安装前端扩展到 `<ST>/data/<user>/extensions/st-cloud-sync/`
3. 检查 `unison` / `ssh`
4. 确保 `config.yaml` 里 `enableServerPlugins: true`（会先备份）

自定义：

```bash
USER_DIR=myuser ./install.sh /srv/SillyTavern      # 指定用户目录
INSTALL_GLOBAL_EXT=1 ./install.sh /srv/SillyTavern # 扩展装全局第三方目录
```

重启酒馆。

## 4. 面板配置

酒馆 →「扩展」→ **云同步 (Cloud Sync)**：

| 字段 | 示例 |
| --- | --- |
| 远端主机 | `203.0.113.10` 或域名 |
| 端口 | `22` |
| 远端用户 | `root` |
| 远端 data 根 | `/root/SillyTavern/data` |
| 本地 data 根 | `/root/SillyTavern/data` |
| SSH 私钥 | `/root/.ssh/cloud_sync_ed25519` |
| 同步方向 | 双向 / 云端→本地 / 本地→云端 |
| 冲突策略 | 较新者赢 / 本地赢 / 云端赢 |
| 自动同步(分钟) | `10`（0=关） |

保存后点 **测试连接** →（可选）**立即同步** 前先看日志。

---

## 5. 各环境要点

### Linux 原生（最顺）
按上面步骤走即可。

### Docker
插件跑在容器里，因此：

- **容器内**必须有 `unison` 和 `ssh`。用官方镜像的话通常没有 `unison`，需要：
  - 自建镜像（`RUN apt-get update && apt-get install -y unison openssh-client`），或
  - 把宿主机（同版本）的 unison 二进制挂载进容器，例如 `-v /usr/bin/unison:/usr/bin/unison:ro`，或
  - 用 [LinuxServer.io 版镜像](https://docs.linuxserver.io/images/docker-sillytavern/) 自行加装。
- `localDataRoot` 要填**容器内**的 data 路径（官方镜像常见 `/home/node/app/data`；LinuxServer 版常见 `/config` 下的 data）。
- SSH 私钥要挂载进容器并在面板里填容器内路径。
- 远端那台若是同一台宿主机，注意端口/路径别搞混。

### Windows
- 装 Windows 版 Unison（官方二进制），并把它放进 `PATH`。
- 插件用 `spawn('unison')`，因此 `unicmd` 可填 `unison` 或 `unison.exe` 的绝对路径。
- data 路径用 Windows 写法（如 `C:\SillyTavern\data`）。SSH 私钥路径同理。
- 建议把「本地」放在 Linux 侧，Windows 作为「远端」，最省心。

### macOS
- `brew install unison`，并与远端保持一致版本（Homebrew 版本可能与 Ubuntu 源不同，注意对齐）。

### 远端只跑酒馆、不跑插件
远端**不需要**装插件，只要 `unison` 在 PATH、且接受本地那把私钥即可。

---

## 6. 卸载

```bash
./uninstall.sh /path/to/SillyTavern
```
