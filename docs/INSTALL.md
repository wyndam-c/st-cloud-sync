# 安装与部署指南

## 0. 总览

同步发生在 **本地那台酒馆**（跑插件的那台）和 **远端那台酒馆** 之间。插件只在**本地**一侧运行，通过 SSH 去操作远端，所以：

- 本地：装插件 + `unison` + `ssh` + 一把免密登录远端的私钥。
- 远端：**只需装 `unison`（版本必须与本地一致）**，并把本地那把公钥加进 `~/.ssh/authorized_keys`。

---

## 1. 准备 SSH 免密

同步靠 SSH 免密：**私钥留在本地**（跑插件的那台），**公钥装到远端**。没有现成密钥就按下面现生成一把。

### 1.1 生成密钥对（在本地执行）

```bash
# -N "" = 不设密码（免密）；-f 指定私钥路径；-C 只是备注
ssh-keygen -t ed25519 -f ~/.ssh/cloud_sync_ed25519 -N "" -C "st-cloud-sync@$(hostname)"
```

会生成：

| 文件 | 内容 | 去向 |
| --- | --- | --- |
| `~/.ssh/cloud_sync_ed25519` | **私钥**（保密）| 留在本地；面板「SSH 私钥」填它的绝对路径 |
| `~/.ssh/cloud_sync_ed25519.pub` | **公钥** | 装到远端 `~/.ssh/authorized_keys` |

> 已有密钥（如 `~/.ssh/id_ed25519`）？跳过这一步，把它当私钥用即可；公钥就是同目录的 `.pub` 文件，或 `ssh-keygen -y -f 私钥` 反推。
>
> 私钥文件权限建议 `chmod 600 ~/.ssh/cloud_sync_ed25519`。

### 1.2 把公钥装到远端

**便捷方式**（推荐，会提示输入一次远端账户密码）：

```bash
ssh-copy-id -i ~/.ssh/cloud_sync_ed25519.pub root@REMOTE_HOST
```

**手动方式**（没有 `ssh-copy-id`，如 Windows / 精简系统）：

```bash
cat ~/.ssh/cloud_sync_ed25519.pub | ssh root@REMOTE_HOST \
  'mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys'
```

也可以手动把 `~/.ssh/cloud_sync_ed25519.pub` 的内容粘到远端 `~/.ssh/authorized_keys` 末尾（一行一个公钥）。

> - 远端用**哪个账户**跑酒馆/被登录，就装到那个账户的 `~` 下（上面示例是 `root`）。
> - 权限必须对：远端 `~/.ssh` = `700`，`~/.ssh/authorized_keys` = `600`；否则 sshd 会**静默拒绝**。
> - 远端 `sshd_config` 一般默认就允许公钥登录；若不行，确认 `PubkeyAuthentication yes`。

### 1.3 验证免密

```bash
ssh -i ~/.ssh/cloud_sync_ed25519 -o BatchMode=yes root@REMOTE_HOST hostname
```

能直接打印远端主机名、**不再问密码** = 成功。`BatchMode=yes` 强制不交互，失败会直接报错，便于排查。

> 若本地酒馆是 Docker 跑的，这把私钥要放在**容器内**能访问到的位置（建议挂载进容器，如 `-v ~/.ssh:/home/node/.ssh:ro`），面板里填**容器内**路径。

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
