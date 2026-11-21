#!/usr/bin/env bash
# 一条命令同步到 GitHub：
#   1) 重新打包（单文件 + CDN 版）
#   2) 提交源码改动
#   3) 推送到 GitHub，Pages 会自动重建
#
# 用法：
#   bash tools/sync-github.sh "改了什么"
#   首次需要先设置远端：
#   git remote add origin https://github.com/<用户名>/holo-tree.git

set -euo pipefail
cd "$(dirname "$0")/.."

MSG="${1:-chore: 同步更新}"
NODE_BIN="${NODE_BIN:-node}"

echo "① 打包"
"$NODE_BIN" tools/bundle.mjs | tail -2
"$NODE_BIN" tools/bundle.mjs --cdn | tail -2

echo "② 提交"
git add -A
if git diff --cached --quiet; then
  echo "   没有改动，跳过提交"
else
  git commit -q -m "$MSG"
  echo "   已提交：$MSG"
fi

echo "③ 推送"
if ! git remote get-url origin >/dev/null 2>&1; then
  echo "   ✗ 还没设置远端。先执行："
  echo "     git remote add origin https://github.com/<你的用户名>/holo-tree.git"
  exit 1
fi

git push -u origin HEAD
echo "✓ 完成。GitHub Pages 大约 30~60 秒后自动重新发布，地址不变。"
