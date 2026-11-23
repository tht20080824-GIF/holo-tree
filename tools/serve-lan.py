#!/usr/bin/env python3
"""把整个开发目录挂到局域网（含 vendor/ 模型），手机同 Wi-Fi 可直接测。
   python3 tools/serve-lan.py [--https] [port]
"""
import http.server, os, ssl, socketserver, sys, functools

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
https = '--https' in sys.argv
ports = [int(a) for a in sys.argv[1:] if a.isdigit()]
port = ports[0] if ports else (8443 if https else 8780)

Handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.ThreadingTCPServer(('0.0.0.0', port), Handler)
if https:
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    cert = os.path.join(ROOT, '..', '.tmp', 'live')
    ctx.load_cert_chain(os.path.join(cert, 'lan-cert.pem'), os.path.join(cert, 'lan-key.pem'))
    srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
print(f'{"https" if https else "http"}://0.0.0.0:{port}  root={ROOT}', flush=True)
srv.serve_forever()
