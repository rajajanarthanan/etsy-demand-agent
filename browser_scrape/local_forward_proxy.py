"""
Local HTTP CONNECT forwarder that injects DataImpulse Proxy-Authorization.

Chrome can then use --proxy-server=127.0.0.1:PORT with no auth extension
(MV2 proxy-auth extensions often fail on modern Chrome).
"""
from __future__ import annotations

import base64
import logging
import select
import socket
import socketserver
import threading
from typing import Callable
from urllib.parse import urlparse

log = logging.getLogger("etsy_fwd_proxy")


class _ForwardHandler(socketserver.BaseRequestHandler):
    upstream_host: str = ""
    upstream_port: int = 823
    proxy_auth_b64: str = ""

    def handle(self) -> None:
        try:
            data = self._recv_headers()
            if not data:
                return
            first = data.split(b"\r\n", 1)[0].decode("latin1", errors="replace")
            parts = first.split()
            if len(parts) < 2:
                return
            method, target = parts[0].upper(), parts[1]

            up = self._connect_upstream()
            if up is None:
                self.request.sendall(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
                return

            auth_line = (
                f"Proxy-Authorization: Basic {self.proxy_auth_b64}\r\n".encode()
            )

            if method == "CONNECT":
                # Rebuild CONNECT with auth for upstream
                hostport = target.encode()
                req = (
                    b"CONNECT " + hostport + b" HTTP/1.1\r\n"
                    b"Host: " + hostport + b"\r\n"
                    + auth_line
                    + b"Proxy-Connection: keep-alive\r\n\r\n"
                )
                up.sendall(req)
                resp = self._recv_headers_sock(up)
                if b" 200 " not in resp.split(b"\r\n", 1)[0]:
                    self.request.sendall(
                        b"HTTP/1.1 502 Bad Gateway\r\n\r\n" + resp[:200]
                    )
                    up.close()
                    return
                self.request.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                self._tunnel(self.request, up)
            else:
                # Absolute-form HTTP request — inject auth header
                if b"\r\nProxy-Authorization:" in data:
                    body = data
                else:
                    # Insert after first line
                    nl = data.find(b"\r\n")
                    body = data[: nl + 2] + auth_line + data[nl + 2 :]
                up.sendall(body)
                self._tunnel(self.request, up)
        except Exception as e:
            log.debug("forward handler error: %s", e)

    def _connect_upstream(self) -> socket.socket | None:
        try:
            s = socket.create_connection(
                (self.upstream_host, self.upstream_port), timeout=30
            )
            s.settimeout(60)
            return s
        except OSError as e:
            log.warning("upstream connect failed: %s", e)
            return None

    def _recv_headers(self) -> bytes:
        buf = b""
        self.request.settimeout(30)
        while b"\r\n\r\n" not in buf and len(buf) < 65536:
            chunk = self.request.recv(4096)
            if not chunk:
                break
            buf += chunk
        return buf

    @staticmethod
    def _recv_headers_sock(sock: socket.socket) -> bytes:
        buf = b""
        while b"\r\n\r\n" not in buf and len(buf) < 65536:
            chunk = sock.recv(4096)
            if not chunk:
                break
            buf += chunk
        return buf

    @staticmethod
    def _tunnel(a: socket.socket, b: socket.socket) -> None:
        sockets = [a, b]
        try:
            while True:
                r, _, x = select.select(sockets, [], sockets, 60)
                if x or not r:
                    break
                for s in r:
                    other = b if s is a else a
                    data = s.recv(65536)
                    if not data:
                        return
                    other.sendall(data)
        except OSError:
            return
        finally:
            for s in (a, b):
                try:
                    s.close()
                except OSError:
                    pass


class LocalForwardProxy:
    def __init__(
        self,
        upstream_server: str,
        username: str,
        password: str,
        listen_host: str = "127.0.0.1",
        listen_port: int = 0,
    ) -> None:
        parsed = urlparse(
            upstream_server
            if "://" in upstream_server
            else f"http://{upstream_server}"
        )
        self.upstream_host = parsed.hostname or "gw.dataimpulse.com"
        self.upstream_port = int(parsed.port or 823)
        token = base64.b64encode(f"{username}:{password}".encode()).decode()
        self.listen_host = listen_host
        self._preferred_port = listen_port
        self._server: socketserver.ThreadingTCPServer | None = None
        self._thread: threading.Thread | None = None
        self._auth = token

    @property
    def listen_port(self) -> int:
        if not self._server:
            return 0
        return int(self._server.server_address[1])

    @property
    def proxy_server_arg(self) -> str:
        return f"http://{self.listen_host}:{self.listen_port}"

    def start(self) -> int:
        handler = type(
            "BoundHandler",
            (_ForwardHandler,),
            {
                "upstream_host": self.upstream_host,
                "upstream_port": self.upstream_port,
                "proxy_auth_b64": self._auth,
            },
        )
        socketserver.ThreadingTCPServer.allow_reuse_address = True
        self._server = socketserver.ThreadingTCPServer(
            (self.listen_host, self._preferred_port), handler
        )
        self._server.daemon_threads = True
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        log.info(
            "Local forward proxy on %s → %s:%s",
            self.proxy_server_arg,
            self.upstream_host,
            self.upstream_port,
        )
        return self.listen_port

    def stop(self) -> None:
        if self._server:
            try:
                self._server.shutdown()
                self._server.server_close()
            except Exception:
                pass
        self._server = None
        self._thread = None
