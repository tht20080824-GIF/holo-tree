#!/usr/bin/env python3
"""
把单文件圣诞树一键发布到 GitHub Pages（永久 https 地址）。

用法：
    GH_TOKEN=ghp_xxx python3 tools/deploy-github.py

需要 token 的权限：经典 token 勾 `repo` 即可（仓库 + Pages）。
脚本不会把 token 写进任何文件，只从环境变量读。
"""

import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request

TOKEN = os.environ.get("GH_TOKEN", "").strip()
REPO = os.environ.get("GH_REPO", "holo-tree")
SOURCE = os.environ.get("GH_SOURCE", "dist/index.html")  # 单文件成品
API = "https://api.github.com"


def call(method, path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        API + path,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
            "User-Agent": "holo-tree-deploy",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            body = r.read()
            return r.status, (json.loads(body) if body else {})
    except urllib.error.HTTPError as e:
        body = e.read()
        try:
            parsed = json.loads(body)
        except Exception:
            parsed = {"raw": body[:300].decode("utf-8", "replace")}
        return e.code, parsed


def fail(msg, detail=""):
    print(f"✗ {msg}")
    if detail:
        print(f"  {detail}")
    sys.exit(1)


if not TOKEN:
    fail("缺少 GH_TOKEN", "用法：GH_TOKEN=ghp_xxx python3 tools/deploy-github.py")

status, user = call("GET", "/user")
if status != 200:
    fail(f"token 无效（HTTP {status}）", str(user)[:300])
login = user["login"]
print(f"✓ 已认证：{login}")

# 1) 仓库（已存在就继续）
status, repo = call("POST", "/user/repos", {
    "name": REPO,
    "private": False,          # Pages 免费版要求公开仓库
    "auto_init": True,
    "description": "手势控制的 3D 粒子圣诞树",
})
if status == 201:
    print(f"✓ 创建仓库 {login}/{REPO}")
elif status == 422:
    print(f"· 仓库已存在，直接用 {login}/{REPO}")
    status, repo = call("GET", f"/repos/{login}/{REPO}")
    if status != 200:
        fail("读取仓库失败", str(repo)[:300])
else:
    fail(f"创建仓库失败（HTTP {status}）", str(repo)[:300])

branch = repo.get("default_branch") or "main"

# 2) 上传 HTML（已存在就更新）
with open(SOURCE, "rb") as f:
    content = base64.b64encode(f.read()).decode()

existing_sha = None
status, info = call("GET", f"/repos/{login}/{REPO}/contents/index.html?ref={branch}")
if status == 200:
    existing_sha = info.get("sha")

payload = {"message": "deploy: holo tree", "content": content, "branch": branch}
if existing_sha:
    payload["sha"] = existing_sha

status, res = call("PUT", f"/repos/{login}/{REPO}/contents/index.html", payload)
if status not in (200, 201):
    fail(f"上传失败（HTTP {status}）", str(res)[:400])
print(f"✓ 已上传 {SOURCE}（{len(content) * 3 // 4 // 1024} KB）")

# 3) 打开 Pages
status, pages = call("POST", f"/repos/{login}/{REPO}/pages", {
    "source": {"branch": branch, "path": "/"},
})
if status == 201:
    print("✓ 已开启 GitHub Pages")
elif status == 409:
    print("· Pages 已经开着")
else:
    # 没开成功就再试一次显式更新
    status, pages = call("PUT", f"/repos/{login}/{REPO}/pages", {
        "source": {"branch": branch, "path": "/"},
    })
    if status not in (200, 204):
        fail(f"开启 Pages 失败（HTTP {status}）", str(pages)[:300])

url = f"https://{login}.github.io/{REPO}/"

# 4) 等构建
print("· 等待 Pages 构建", end="", flush=True)
for _ in range(60):
    time.sleep(5)
    status, pages = call("GET", f"/repos/{login}/{REPO}/pages")
    state = pages.get("status")
    print(".", end="", flush=True)
    if status == 200 and state in ("built", "null"):
        break
print()

# 5) 实测
for attempt in range(12):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "holo-tree-deploy"})
        with urllib.request.urlopen(req, timeout=30) as r:
            if r.status == 200:
                print(f"\n✓ 上线成功：{url}")
                print(f"  体积 {len(r.read()) // 1024} KB")
                sys.exit(0)
    except Exception:
        pass
    time.sleep(10)

print(f"\n· 构建可能还没完成，地址是：{url}")
print("  过一分钟刷新试试；仓库设置里能看到 Pages 状态。")
