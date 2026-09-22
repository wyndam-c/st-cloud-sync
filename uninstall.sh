#!/usr/bin/env bash
# ST Cloud Sync — 卸载脚本
# 用法: ./uninstall.sh [/path/to/SillyTavern]
set -euo pipefail

ST_DIR="${1:-${ST_DIR:-}}"
USER_DIR="${USER_DIR:-default-user}"

if [ -z "$ST_DIR" ]; then
  for c in /root/SillyTavern "$HOME/SillyTavern" /opt/SillyTavern ./SillyTavern /app; do
    if [ -f "$c/server.js" ]; then ST_DIR="$c"; break; fi
  done
fi

if [ -z "$ST_DIR" ] || [ ! -f "$ST_DIR/server.js" ]; then
  echo "✗ 找不到 SillyTavern 目录，请传入路径： ./uninstall.sh /path/to/SillyTavern" >&2
  exit 1
fi

rm -rf "$ST_DIR/plugins/st-cloud-sync" \
       "$ST_DIR/data/$USER_DIR/extensions/st-cloud-sync" \
       "$ST_DIR/public/scripts/extensions/third-party/st-cloud-sync"
echo "✓ 已移除插件与扩展（$ST_DIR）"
echo "ℹ ~/.unison/<profile>.prf 及同步状态未删除；如需彻底清理请手动删除 ~/.unison 下对应文件。"
echo "→ 记得重启酒馆。"
