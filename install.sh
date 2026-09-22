#!/usr/bin/env bash
# ST Cloud Sync — 安装脚本
#
# 用法:
#   ./install.sh [/path/to/SillyTavern]
#
# 环境变量:
#   ST_DIR              指定酒馆目录（含 server.js）
#   USER_DIR            用户目录名（默认 default-user）
#   INSTALL_GLOBAL_EXT=1 扩展装到全局第三方目录而非用户目录
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ST_DIR="${1:-${ST_DIR:-}}"
USER_DIR="${USER_DIR:-default-user}"
INSTALL_GLOBAL_EXT="${INSTALL_GLOBAL_EXT:-0}"

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
mkdir -p "$PLUG"
install -m 644 "$SRC/plugin/index.mjs" "$PLUG/index.mjs"
echo "✓ 服务端插件 → $PLUG"

# 2) 前端扩展
if [ "$INSTALL_GLOBAL_EXT" = "1" ]; then
  EXT="$ST_DIR/public/scripts/extensions/third-party/st-cloud-sync"
else
  EXT="$ST_DIR/data/$USER_DIR/extensions/st-cloud-sync"
fi
mkdir -p "$EXT"
install -m 644 "$SRC/extension/manifest.json" "$SRC/extension/index.js" "$SRC/extension/style.css" "$EXT/"
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
