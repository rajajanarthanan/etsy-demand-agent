"""Generate a temporary Chrome MV2 extension for authenticated HTTP proxy."""
from __future__ import annotations

import json
import shutil
from pathlib import Path

from .config import OUT_DIR, dataimpulse_proxy_parts, load_config

EXT_DIR = OUT_DIR / "chrome_proxy_ext_runtime"


def write_proxy_extension(country: str, sessid: str, cfg: dict | None = None) -> Path:
    """
    Write unpacked MV2 proxy+auth extension for DataImpulse.
    Returns path to load via --load-extension=.
    """
    parts = dataimpulse_proxy_parts(country, sessid, cfg or load_config())
    hostport = parts["server"].replace("http://", "").replace("https://", "")
    host, port_s = hostport.rsplit(":", 1)
    port = int(port_s)
    # Escape for JS string literals
    user = json.dumps(parts["username"])
    password = json.dumps(parts["password"])

    if EXT_DIR.exists():
        shutil.rmtree(EXT_DIR)
    EXT_DIR.mkdir(parents=True)

    (EXT_DIR / "manifest.json").write_text(
        json.dumps(
            {
                "version": "1.0.0",
                "manifest_version": 2,
                "name": "DataImpulse Proxy Auth",
                "permissions": [
                    "proxy",
                    "tabs",
                    "unlimitedStorage",
                    "storage",
                    "<all_urls>",
                    "webRequest",
                    "webRequestBlocking",
                ],
                "background": {"scripts": ["background.js"]},
                "minimum_chrome_version": "22.0.0",
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    (EXT_DIR / "background.js").write_text(
        f"""
var config = {{
  mode: "fixed_servers",
  rules: {{
    singleProxy: {{ scheme: "http", host: {json.dumps(host)}, port: {port} }},
    bypassList: ["localhost", "127.0.0.1"]
  }}
}};
chrome.proxy.settings.set({{value: config, scope: "regular"}}, function() {{}});
function callbackFn(details) {{
  return {{
    authCredentials: {{
      username: {user},
      password: {password}
    }}
  }};
}}
chrome.webRequest.onAuthRequired.addListener(
  callbackFn,
  {{urls: ["<all_urls>"]}},
  ["blocking"]
);
""",
        encoding="utf-8",
    )
    return EXT_DIR
