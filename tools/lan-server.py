#!/usr/bin/env python3
"""
局域网服务器：让手机能用 http 和 https 打开这个圣诞树。

用法：
    python3 tools/lan-server.py            # 同时起 http://:8770 和 https://:8443
    python3 tools/lan-server.py --http-only

为什么需要它：
- 127.0.0.1 在手机上指的是手机自己，必须用 Mac 的局域网 IP
- 默认 http.server 只监听 127.0.0.1，要显式绑 0.0.0.0 手机才连得进来
- https 那一档用自签证书，目的是试探浏览器肯不肯给摄像头权限
"""

import argparse
import http.server
import os
import ssl
import sys
import threading

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVE_DIR = os.path.join(ROOT, "dist")
CERT = os.path.join(ROOT, "tools", ".lan-cert.pem")
KEY = os.path.join(ROOT, "tools", ".lan-key.pem")


CA_PATH = os.path.join(ROOT, "tools", "ca.pem")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=SERVE_DIR, **kwargs)

    def do_GET(self):
        # 手机装证书用：/ca.crt 返回我们的根证书，MIME 要给对，
        # iOS 才会当成描述文件来安装
        if self.path.split("?")[0] in ("/ca.crt", "/holo-tree-ca.crt"):
            if not os.path.exists(CA_PATH):
                self.send_error(404, "CA not found")
                return
            data = open(CA_PATH, "rb").read()
            self.send_response(200)
            self.send_header("Content-Type", "application/x-x509-ca-cert")
            self.send_header("Content-Disposition", 'attachment; filename="holo-tree-ca.crt"')
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        super().do_GET()

    def end_headers(self):
        # 手机端调试时别让缓存骗你
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("[lan] %s\n" % (fmt % args))


def serve_http(port):
    httpd = http.server.ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"  http  →  http://<你的局域网IP>:{port}/", flush=True)
    httpd.serve_forever()


def serve_https(port):
    if not (os.path.exists(CERT) and os.path.exists(KEY)):
        print("  跳过 https：缺少自签证书（先跑 tools/make-cert.sh）", flush=True)
        return
    httpd = http.server.ThreadingHTTPServer(("0.0.0.0", port), Handler)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(CERT, KEY)
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
    print(f"  https →  https://<你的局域网IP>:{port}/  （浏览器会警告证书，选继续）", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--http-port", type=int, default=8770)
    parser.add_argument("--https-port", type=int, default=8443)
    parser.add_argument("--http-only", action="store_true")
    args = parser.parse_args()

    print(f"服务目录：{SERVE_DIR}", flush=True)
    threading.Thread(target=serve_http, args=(args.http_port,), daemon=True).start()
    if not args.http_only:
        threading.Thread(target=serve_https, args=(args.https_port,), daemon=True).start()

    threading.Event().wait()  # 主线程挂着，别让进程退出
