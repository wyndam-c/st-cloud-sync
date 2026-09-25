#!/usr/bin/env bash
# ST Cloud Sync — 一键更新（git 安装模式）
#
# 用法:
#   ./update.sh [/path/to/SillyTavern]
#
# 作用:
#   1) 在插件目录里 git pull 最新代码
#   2) 把 extension/ 三件套重新刷到酒馆的扩展目录
#   3) 提示重启酒馆
#
# 前提: 当初是用 ./install.sh --git 装的（插件目录是个 git 工作区）
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ST_DIR="${1:-${ST_DIR:-}}"
USER_DIR="${USER_DIR:-default-user}"
GIT_BRANCH="${GIT_BRANCH:-main}"

if [ -z "$ST_DIR" ]; then
  for c in /root/SillyTavern "$HOME/SillyTavern" /opt/SillyTavern ./SillyTavern /app; do
    if [ -f "$c/server.js" ]; then ST_DIR="$c"; break; fi
  done
fi
if [ -z "$ST_DIR" ] || [ ! -f "$ST_DIR/server.js" ]; then
  echo "✗ 找不到 SillyTavern 目录（需含 server.js）。请传入路径： ./update.sh /path/to/SillyTavern" >&2
  exit 1
fi

PLUG="$ST_DIR/plugins/st-cloud-sync"
if [ ! -d "$PLUG/.git" ]; then
  echo "✗ $PLUG 不是 git 安装，没法自动更新。"
  echo "  → 跑一次 ./install.sh --git \"$ST_DIR\" 重装即可（会把现有 config.json 保留）"
  exit 1
fi

echo "→ 插件目录: $PLUG"
BEFORE="$(git -C "$PLUG" rev-parse --short HEAD)"
echo "→ 当前: $BEFORE"

git -C "$PLUG" fetch --quiet origin "$GIT_BRANCH" || true
git -C "$PLUG" pull --ff-only origin "$GIT_BRANCH"

AFTER="$(git -C "$PLUG" rev-parse --short HEAD)"

# 酒馆入口壳（万一丢了就补回来；它是未跟踪文件，pull 不会动它）
if [ ! -f "$PLUG/index.mjs" ]; then
  printf 'export * from "./plugin/index.mjs";   // 酒馆插件入口（未跟踪）\n' > "$PLUG/index.mjs"
  echo "✓ 已补回酒馆入口 index.mjs"
fi

# 刷新前端扩展（插件代码更新不会自动改扩展目录）
EXT="$ST_DIR/data/$USER_DIR/extensions/st-cloud-sync"
if [ -d "$EXT" ]; then
  install -m 644 "$PLUG/extension/manifest.json" "$PLUG/extension/index.js" "$PLUG/extension/style.css" "$EXT/"
  echo "✓ 前端扩展已刷新 → $EXT"
fi
GEXT="$ST_DIR/public/scripts/extensions/third-party/st-cloud-sync"
if [ -d "$GEXT" ]; then
  install -m 644 "$PLUG/extension/manifest.json" "$PLUG/extension/index.js" "$PLUG/extension/style.css" "$GEXT/"
  echo "✓ 全局扩展已刷新 → $GEXT"
fi

echo
if [ "$BEFORE" != "$AFTER" ]; then
  echo "✅ 已更新 $BEFORE → $AFTER"
  echo "→ 重启酒馆生效，然后刷新浏览器页面（Ctrl+F5）"
else
  echo "✅ 已经是最新（$AFTER）"
fi
