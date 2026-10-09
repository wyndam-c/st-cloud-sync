# 星形同步方案（Syncthing）

> 这是和默认的 **Unison 点对点**（两台酒馆直连）并列的另一种部署方案。
> 多了一台**中枢服务器**，家用小鸡和东京小鸡都只跟中枢做双向同步，中枢做权威数据源。
> 适合：家用/东京随时可能重启、换网络、搬家，不想让两台直接连的场景。

## 🏗️ 架构

```
家用小鸡(192.168.31.167) ←→ 香港中枢(154.37.214.127) ←→ 东京小鸡(64.83.47.235)
                              Syncthing
                              /data/tavern-sync/
```

- **中枢**：跑 Syncthing 服务，存一份完整数据当权威源
- **家用/东京**：各自跑 Syncthing 客户端，和中枢双向同步
- **同步范围**：酒馆核心数据（角色卡/聊天/世界书/用户配置/settings.json/secrets.json）
- **冲突策略**：按文件**修改时间最新者赢**（不生成 `sync-conflict-*` 备份文件）
- **扫描间隔**：30 秒

## 📁 同步的目录/文件

在每台酒馆 `data/default-user/` 下，这些对象会**软链**到本机 `/data/tavern-sync/`：

```
characters/      ← 角色卡
chats/           ← 聊天记录
worlds/          ← 世界书
user/            ← 用户配置
settings.json     ← 酒馆设置
secrets.json     ← API 密钥
```

`extensions/`、`backups/`、`themes/` 这些**不同步**（插件程序每家自己装，备份垃圾各家清各家）。

## 🚀 快速部署

### 1. 三台都装 Syncthing

```bash
# Linux amd64 一键
VER=1.27.12
wget -q https://github.com/syncthing/syncthing/releases/download/v${VER}/syncthing-linux-amd64-v${VER}.tar.gz -O /tmp/st.tar.gz
tar xzf /tmp/st.tar.gz -C /tmp
cp /tmp/syncthing-linux-amd64-v${VER}/syncthing /usr/local/bin/
chmod +x /usr/local/bin/syncthing
```

挂 systemd：

```ini
# /etc/systemd/system/syncthing.service
[Unit]
Description=Syncthing
After=network.target

[Service]
Type=simple
User=root
ExecStart=/usr/local/bin/syncthing serve --no-browser --no-restart --home=/root/.config/syncthing
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now syncthing
```

### 2. 拿三台的 Device ID

```bash
grep -oP '<device id="\K[^"]+' /root/.config/syncthing/config.xml | head -1
```

假设：
- 中枢(香港): `HK-xxxx-...`
- 东京: `TOKYO-xxxx-...`
- 家用: `HOME-xxxx-...`

### 3. 三台互加设备 + 建共享文件夹

可以直接用 Web GUI（http://154.37.214.127:8384）手动点，也可以走 API：

```bash
# 在中枢上
HK_KEY=<api key in config.xml>

curl -X POST http://127.0.0.1:8384/rest/config/devices \
  -H "X-API-Key: $HK_KEY" -H "Content-Type: application/json" \
  -d '{"deviceID":"TOKYO-...","name":"tokyo","addresses":["tcp://64.83.47.235:22000"],"compression":"metadata"}'

curl -X POST http://127.0.0.1:8384/rest/config/devices \
  -H "X-API-Key: $HK_KEY" -H "Content-Type: application/json" \
  -d '{"deviceID":"HOME-...","name":"home","addresses":["dynamic"],"compression":"metadata"}'

curl -X POST http://127.0.0.1:8384/rest/config/folders \
  -H "X-API-Key: $HK_KEY" -H "Content-Type: application/json" \
  -d '{
    "id":"tavern-sync","label":"酒馆数据同步",
    "path":"/data/tavern-sync","type":"sendreceive",
    "rescanIntervalS":30,"maxConflicts":0,"ignorePerms":true,
    "devices":[{"deviceID":"HK-..."},{"deviceID":"TOKYO-..."},{"deviceID":"HOME-..."}]
  }'
```

东京、家用两台**反向**同样操作（把另外两台加进自己的设备列表，建同一个 `tavern-sync` 文件夹）。

### 4. 软链酒馆数据到同步目录

每台机器上：

```bash
ST=/root/SillyTavern/data/default-user
SYNC=/data/tavern-sync
mkdir -p $SYNC

for d in characters chats worlds user; do
  [ -d $ST/$d ] && [ ! -L $ST/$d ] && { mv $ST/$d $SYNC/$d; ln -s $SYNC/$d $ST/$d; }
done
for f in settings.json secrets.json; do
  [ -f $ST/$f ] && [ ! -L $ST/$f ] && { mv $ST/$f $SYNC/$f; ln -s $SYNC/$f $ST/$f; }
done
```

### 5. 防火墙开端口

```bash
ufw allow 22000/tcp
ufw allow 22000/udp
```

## 🎨 酒馆状态条（可选）

`scripts/syncthing-status.js` 是个纯前端小脚本，扔到酒馆 `public/scripts/` 下自动加载。
每 60 秒查一次 Syncthing API，右上角弹小状态条：

- 🔄 **同步中**：橙色条 `正在同步 N 个文件…`（一直显示）
- ✅ **同步完成**：绿色条 `数据已同步到最新`，停留 10 秒消失
- 空闲不弹，不打扰聊天

**反代**：为了不让浏览器拿到 Syncthing API key，在 nginx 上加一个 location：

```nginx
location = /syncthing-status {
    proxy_pass http://154.37.214.127:8384/rest/db/status?folder=tavern-sync;
    proxy_set_header Host 154.37.214.127:8384;
    proxy_set_header X-API-Key <中枢 API key>;
    add_header Access-Control-Allow-Origin *;
}
```

家用酒馆入口和东京酒馆入口各自的 nginx 都加这段，前端脚本请求相对路径 `/syncthing-status` 就行。

## 🧠 为什么不用 st-cloud-sync 的 Unison 了？

Unison 点对点要求**两台酒馆能直接 SSH 到对方**：
- 家用小鸡在 NAT 后面（家里路由器），东京小鸡要过来得先 frp 穿透
- 任何一台重启，同步就停

星形方案是**推-推模式**：
- 家用和东京都主动连中枢的公网 IP（154.37.214.127），不用打洞
- 中枢 24h 在线，任何一端重启完自己就会重新连上
- 冲突按 mtime 最新覆盖，简单粗暴

## ⚠️ 注意事项

- **三台机器 NTP 一定要开**，不然 mtime 判断会反（`timedatectl` 看 NTP service: active）
- **中枢磁盘要够**：800M 左右是酒馆核心数据，留 2-3G 余量
- **API key 别暴露**：前端只查 `/syncthing-status` 反代，key 留在 nginx 服务端
- **不要在同步目录里手动塞东西**：Syncthing 会把它同步到另外两台
