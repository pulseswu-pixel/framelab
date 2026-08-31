#!/bin/bash
# FrameLab 一键启动脚本 (Mac / Linux)
cd "$(dirname "$0")"
NODE_BIN=""
for candidate in node /opt/homebrew/bin/node /usr/local/bin/node; do
  if command -v "$candidate" >/dev/null 2>&1; then NODE_BIN="$candidate"; break; fi
done
if [ -z "$NODE_BIN" ]; then
  echo "未检测到 Node.js，请先安装：https://nodejs.org"
  read -p "按回车键关闭..."
  exit 1
fi
PORT=${PORT:-4173}
echo "FrameLab 启动中... http://localhost:$PORT"
(sleep 2 && open "http://localhost:$PORT" 2>/dev/null || xdg-open "http://localhost:$PORT" 2>/dev/null) &
exec "$NODE_BIN" server.js
