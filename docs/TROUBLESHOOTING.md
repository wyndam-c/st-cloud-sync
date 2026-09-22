# 常见问题 / 排错

## 1. 两边 unison 版本不一致

**现象**：`/test` 失败，或日志里出现 `Fatal error: Received unexpected header`／版本不符。

**原因**：Unison 要求两端**版本号完全一致**（连补丁级别都要一致）。

**解决**：
```bash
# 两端分别执行，输出需一致
unison -version
```
不同就统一到同一发行版 / 同一来源的二进制。

---

## 2. `/api/plugins/...` 返回 403 Forbidden

**现象**：面板提示无法连接插件；用 curl 直接访问拿 403。

**原因**：SillyTavern 对 `/api/*` 有保护：
- `GET` 403（裸 `Forbidden`）= **未登录**（`requireLoginMiddleware`）。
- `POST` 403（`Invalid CSRF token`）= **CSRF 校验失败**。

**解决**：浏览器里正常登录酒馆即可（面板走的是同样的登录会话）。命令行手测时：

```bash
CJ=/tmp/cj; rm -f $CJ
curl -sL -c $CJ -b $CJ http://127.0.0.1:8000/ >/dev/null     # 触发自动登录(单用户无密码时)
TOK=$(curl -s -c $CJ -b $CJ http://127.0.0.1:8000/csrf-token | sed -E 's/.*"token":"([^"]+)".*/\1/')
curl -s -b $CJ -H "X-CSRF-Token: $TOK" http://127.0.0.1:8000/api/plugins/st-cloud-sync/status
```

> 若酒馆是**多用户 + 有密码**，必须先用账号登录拿到会话，自动登录不生效。

---

## 3. ⚠️ 同步了 `_storage` 导致登录失灵 / 多出一个用户

**现象**：酒馆登录异常、账号列表多出奇怪的条目；或自动登录失效、`/api` 全 403。

**原因**：`data/_storage/` 是**账号库**。双向同步时 Unison 的冲突副本会在这里生成额外文件，SillyTavern 扫描后误认为存在多个用户，导致「单用户无密码自动登录」失效（该逻辑要求恰好 1 个用户）。

**解决**：
1. 把 `_storage` 加入**排除项**（本插件默认已排除）。
2. 删除 `_storage/` 下被 Unison 生成的 `* (conflict_on_*)` 副本文件。
3. 重启酒馆。

**结论**：账号请**各机单独管理**，不要跨机同步 `_storage`。

---

## 4. 远端路径写成三个斜杠 / profile 报错

**规范**：Unison 的 SSH 远端根写法是 `ssh://user@host//绝对路径`（**两个斜杠**再接绝对路径）。

```
✅ ssh://root@1.2.3.4//root/SillyTavern/data
❌ ssh://root@1.2.3.4///root/SillyTavern/data
```

本插件会自动规范化，手改 profile 时注意即可。

---

## 5. Docker：`spawn unison ENOENT`

**原因**：容器里没装 unison。

**解决**：自建镜像加装，或挂载宿主机的同版本二进制进容器（见 [INSTALL.md](INSTALL.md#docker)）。

---

## 6. 提示 `confirmbigdel` / 拒绝删除

Unison 默认在「某个 replica 整体变空」时拒绝执行删除以防误删。这是**安全网**，不是 bug。确认无误后再处理（如显式设置 `confirmbigdel = false`）。

---

## 7. 冲突副本文件

冲突时（两边都改了同一文件），按「冲突策略」选一方，另一方保留为副本，名字形如：

```
xxx.json (conflict_on_2026-09-23)
```

处理完可自行删除。想零丢失，保留默认 `prefer = newer` + `copyonconflict = true`。

---

## 8. 同步很慢 / 每次都传很多

- 首次同步要传全量，慢是正常的；之后是增量。
- `backups/`、`extensions/` 体积大且跨版本可能不兼容，**默认已排除**，别轻易加回。
- 大量小文件（缩略图/聊天）会拖慢扫描，属正常。

---

## 9. 权限 / Docker 属主

Docker 版酒馆的数据目录属主可能是 `node`(1000) 或自定义 PUID/PGID。同步后若出现权限问题，检查两侧运行用户是否一致，必要时调整 `PUID`/`PGID`。

---

## 10. 想看插件到底跑在哪、日志在哪

- Unison profile：`~/.unison/<profile>.prf`（由插件生成，改配置会覆盖）
- 同步日志：`<ST>/plugins/st-cloud-sync/last-sync.log`
- 插件配置：`<ST>/plugins/st-cloud-sync/config.json`
- 面板日志区 / `GET /status` 的 `log` 字段也有最近 300 行
