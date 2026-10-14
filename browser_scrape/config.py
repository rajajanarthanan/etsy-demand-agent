"""Load gitignored config and build DataImpulse proxy URLs."""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any
from urllib.parse import quote

ROOT = Path(__file__).resolve().parent.parent  # portfolio/etsy-demand-agent (repo root)
OUT_DIR = ROOT / "data"
OUT_DIR.mkdir(exist_ok=True)

KEYWORDS = ["teak", "acacia", "hardwood", "mahogany"]
DEFAULT_COUNTRIES = ["us", "ca"]
DEFAULT_PAGES = 2

# Etsy ship_to + DataImpulse __cr.XX both use ISO-ish codes; accept aliases.
_COUNTRY_ALIASES = {
    "uk": "gb",
    "britain": "gb",
}


def normalize_country(country: str) -> str:
    cc = (country or "").lower().strip()
    return _COUNTRY_ALIASES.get(cc, cc)


def load_config() -> dict[str, Any]:
    cfg_path = ROOT / "config.json"
    if not cfg_path.exists():
        raise SystemExit(
            f"Missing {cfg_path}. Copy config.example.json → config.json "
            "and fill in DataImpulse credentials."
        )
    data = json.loads(cfg_path.read_text())
    di = data.get("dataimpulse") or {}
    for key in ("login", "password", "host", "port"):
        if not di.get(key):
            raise SystemExit(
                f"config.json missing dataimpulse.{key}. "
                "See config.example.json."
            )
        if str(di[key]).startswith("YOUR_"):
            raise SystemExit(f"Replace placeholder dataimpulse.{key} in config.json")
    return data


def dataimpulse_proxy_parts(
    country: str,
    sessid: str = "",
    cfg: dict[str, Any] | None = None,
    *,
    sticky: bool = True,
) -> dict[str, str]:
    """
    Playwright-friendly proxy parts.

    DataImpulse (port 823):
    - sticky=True  → LOGIN__cr.CC;sessid.NAME  (same IP ~30 min for that sessid)
    - sticky=False → LOGIN__cr.CC              (new IP each TCP connection)

    Rotate IP by changing sessid (sticky) or opening a new connection (rotating).
    """
    cfg = cfg or load_config()
    di = cfg["dataimpulse"]
    cc = normalize_country(country)
    if not re.fullmatch(r"[a-z]{2}", cc):
        raise ValueError(f"invalid country code: {country}")
    if sticky and sessid:
        sess = re.sub(r"[^a-zA-Z0-9_-]", "_", sessid)[:48] or "default"
        user = f"{di['login']}__cr.{cc};sessid.{sess}"
    else:
        # Rotating: omit sessid so each connection can get a new exit IP
        user = f"{di['login']}__cr.{cc}"
    return {
        "server": f"http://{di['host']}:{int(di['port'])}",
        "username": user,
        "password": str(di["password"]),
        "sticky": sticky,
        "sessid": sessid if sticky else "",
        "country": cc,
    }


def probe_egress_ip(parts: dict[str, str], timeout: int = 25) -> str:
    """Hit ipify through the proxy; returns IP string or empty on failure."""
    import urllib.request

    proxy = (
        f"http://{quote(parts['username'], safe='')}:{quote(parts['password'], safe='')}"
        f"@{parts['server'].split('://', 1)[-1]}"
    )
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({"http": proxy, "https": proxy})
    )
    try:
        with opener.open("https://api.ipify.org?format=json", timeout=timeout) as r:
            data = json.loads(r.read().decode())
            return str(data.get("ip") or "")
    except Exception:
        return ""


def dataimpulse_proxy_url(
    country: str,
    sessid: str,
    cfg: dict[str, Any] | None = None,
) -> str:
    """Full proxy URL (for logging without password use parts instead)."""
    parts = dataimpulse_proxy_parts(country, sessid, cfg)
    user_q = quote(parts["username"], safe="")
    pass_q = quote(parts["password"], safe="")
    # server is http://host:port
    hostport = parts["server"].split("://", 1)[-1]
    return f"http://{user_q}:{pass_q}@{hostport}"


def build_search_url(keyword: str, page: int, ship_to: str | None = None) -> str:
    from urllib.parse import quote as q

    url = (
        f"https://www.etsy.com/search?q={q(keyword)}"
        f"&is_best_seller=true&explicit=1"
        f"&ref=pagination&page={page}"
    )
    if ship_to:
        url += f"&ship_to={normalize_country(ship_to).upper()}"
    return url


def write_run_state(patch: dict[str, Any]) -> None:
    path = OUT_DIR / "run_state.json"
    state: dict[str, Any] = {}
    if path.exists():
        try:
            state = json.loads(path.read_text())
        except json.JSONDecodeError:
            state = {}
    state.update(patch)
    path.write_text(json.dumps(state, indent=2), encoding="utf-8")
