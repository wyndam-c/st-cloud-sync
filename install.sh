#!/usr/bin/env bash
# ST Cloud Sync — 安装脚本
#
# 用法:
#   ./install.sh [/path/to/SillyTavern]           # 普通安装（复制文件）
#   ./install.sh --git [/path/to/SillyTavern]     # git 安装（可自动更新，推荐）
#
# 环境变量:
#   ST_DIR              指定酒馆目录（含 server.js）
#   USER_DIR            用户目录名（默认 default-user）
#   INSTALL_GLOBAL_EXT=1 扩展装到全局第三方目录而非用户目录
#   REPO_URL            --git 模式用的仓库地址（默认本项目的 GitHub）
#   GIT_BRANCH          --git 模式用的分支（默认 main）
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USER_DIR="${USER_DIR:-default-user}"
INSTALL_GLOBAL_EXT="${INSTALL_GLOBAL_EXT:-0}"
GIT_MODE=0
REPO_URL="${REPO_URL:-https://github.com/wyndam-c/st-cloud-sync.git}"
GIT_BRANCH="${GIT_BRANCH:-main}"
ST_DIR="${ST_DIR:-}"

# ---- 解析参数 ----
for a in "$@"; do
  case "$a" in
    --git) GIT_MODE=1 ;;
    --git-url=*) REPO_URL="${a#*=}" ;;
    --git-branch=*) GIT_BRANCH="${a#*=}" ;;
    -h|--help)
      sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    -*) ;;
    *) ST_DIR="$a" ;;
  esac
done

# 自动探测酒馆目录
if [ -z "$ST_DIR" ]; then
  for c in /root/SillyTavern "$HOME/SillyTavern" /opt/SillyTavern ./SillyTavern /app; do
    if [ -f "$c/server.js" ]; then ST_DIR="$c"; break; fi
  done
fi

if [ -z "$ST_DIR" ] || [ ! -f "$ST_DIR/server.js" ]; then
  echo "✗ 找不到 SillyTavern 目录（需包含 server.js）。请传入路径： ./install.sh /path/to/SillyTavern" >&2
  exit 1
fi

echo "→ SillyTavern: $ST_DIR"

# 1) 服务端插件
PLUG="$ST_DIR/plugins/st-cloud-sync"
SHIM='export * from "./plugin/index.mjs";   // 酒馆插件入口（安装脚本生成，未跟踪）'
if [ "$GIT_MODE" = "1" ]; then
  if ! command -v git >/dev/null 2>&1; then
    echo "✗ --git 模式需要 git，但本机没装" >&2; exit 1
  fi
  if [ -d "$PLUG/.git" ]; then
    echo "→ 已有 git 安装，拉取最新…"
    git -C "$PLUG" fetch --quiet origin "$GIT_BRANCH"
    git -C "$PLUG" checkout -q -B "$GIT_BRANCH" "origin/$GIT_BRANCH" 2>/dev/null \
      || git -C "$PLUG" merge --ff-only "origin/$GIT_BRANCH"
    echo "✓ 服务端插件已更新 → $PLUG（$(git -C "$PLUG" rev-parse --short HEAD)）"
  else
    OLDCFG=""; OLDLOG=""
    if [ -f "$PLUG/config.json" ]; then OLDCFG="$(mktemp)"; cp -a "$PLUG/config.json" "$OLDCFG"; fi
    if [ -f "$PLUG/last-sync.log" ]; then OLDLOG="$(mktemp)"; cp -a "$PLUG/last-sync.log" "$OLDLOG"; fi
    if [ -d "$PLUG" ] && [ -n "$(ls -A "$PLUG" 2>/dev/null)" ]; then
      BK="$PLUG.bak.stcs-$(date +%Y%m%d-%H%M%S)"
      mv "$PLUG" "$BK"
      echo "⚠ 已有旧安装，先挪到 $BK"
    fi
    git clone --quiet --branch "$GIT_BRANCH" "$REPO_URL" "$PLUG"
    if [ -n "$OLDCFG" ] && [ -f "$OLDCFG" ]; then
      mkdir -p "$PLUG/plugin"; cp -a "$OLDCFG" "$PLUG/plugin/config.json"
      echo "✓ 已恢复原 config.json（你之前的配置没丢）"
    fi
    if [ -n "$OLDLOG" ] && [ -f "$OLDLOG" ]; then cp -a "$OLDLOG" "$PLUG/plugin/last-sync.log"; fi
    echo "✓ 服务端插件（git 模式，可自动更新）→ $PLUG（$(git -C "$PLUG" rev-parse --short HEAD)）"
    echo "  以后更新：./update.sh，或在酒馆面板点「检查更新 / 一键更新」"
  fi
  # 酒馆入口壳（未跟踪，git pull 不会动它）
  if [ ! -f "$PLUG/index.mjs" ]; then
    printf '%s\n' "$SHIM" > "$PLUG/index.mjs"
  fi
else
  mkdir -p "$PLUG"
  install -m 644 "$SRC/plugin/index.mjs" "$PLUG/index.mjs"
  echo "✓ 服务端插件 → $PLUG"
fi

# 2) 前端扩展
EXT_SRC="$SRC/extension"
if [ "$GIT_MODE" = "1" ] && [ -d "$PLUG/extension" ]; then EXT_SRC="$PLUG/extension"; fi
if [ "$INSTALL_GLOBAL_EXT" = "1" ]; then
  EXT="$ST_DIR/public/scripts/extensions/third-party/st-cloud-sync"
else
  EXT="$ST_DIR/data/$USER_DIR/extensions/st-cloud-sync"
fi
mkdir -p "$EXT"
install -m 644 "$EXT_SRC/manifest.json" "$EXT_SRC/index.js" "$EXT_SRC/style.css" "$EXT/"
echo "✓ 前端扩展   → $EXT"

# 3) 依赖检查
if command -v unison >/dev/null 2>&1; then
  echo "✓ 本机 unison: $(unison -version)"
else
  echo "⚠ 本机未装 unison（sudo apt-get install -y unison）；远端也要装【同版本】"
fi
command -v ssh >/dev/null 2>&1 && echo "✓ ssh 可用" || echo "⚠ 未找到 ssh"

# 4) 开启 enableServerPlugins
CFG="$ST_DIR/config.yaml"
if [ -f "$CFG" ]; then
  if grep -qE '^enableServerPlugins:[[:space:]]*true' "$CFG"; then
    echo "✓ enableServerPlugins 已开启"
  elif grep -qE '^enableServerPlugins:' "$CFG"; then
    cp "$CFG" "$CFG.bak.stcs-$(date +%Y%m%d-%H%M%S)"
    sed -i -E 's/^enableServerPlugins:.*/enableServerPlugins: true/' "$CFG"
    echo "✓ 已把 enableServerPlugins 改为 true（原文件已备份）"
  else
    printf '\nenableServerPlugins: true\n' >> "$CFG"
    echo "✓ 已在 config.yaml 追加 enableServerPlugins: true"
  fi
  echo "→ 记得重启酒馆让插件生效"
else
  echo "⚠ 未找到 config.yaml，请手动设 enableServerPlugins: true 后重启"
fi

echo
echo "完成 ✅  接下来：打开酒馆『扩展 → 云同步』填远端信息 → 保存 → 试运行 → 立即同步。"
