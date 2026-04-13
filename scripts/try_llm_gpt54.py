#!/usr/bin/env python3
"""
Smoke-test OpenAI-compatible chat completions (default model: gpt-5.4).

Reads OPENPRISM_LLM_ENDPOINT, OPENPRISM_LLM_API_KEY from environment,
or loads them from repo-root .env if unset.

Usage:
  python3 scripts/try_llm_gpt54.py
  python3 scripts/try_llm_gpt54.py "your prompt here"
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit


def load_dotenv(path: Path) -> None:
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, rest = line.partition("=")
        key = key.strip()
        val = rest.strip()
        if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
            val = val[1:-1]
        if key and key not in os.environ:
            os.environ[key] = val


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def main() -> int:
    load_dotenv(repo_root() / ".env")

    endpoint = os.environ.get("OPENPRISM_LLM_ENDPOINT", "").strip()
    api_key = os.environ.get("OPENPRISM_LLM_API_KEY", "").strip()
    # 默认 gpt-5.4；需要时可 export TRY_LLM_MODEL=...
    model = os.environ.get("TRY_LLM_MODEL", "gpt-5.4").strip() or "gpt-5.4"

    user_msg = sys.argv[1] if len(sys.argv) > 1 else "hi"

    if not endpoint:
        print("OPENPRISM_LLM_ENDPOINT missing", file=sys.stderr)
        return 1
    if not api_key:
        print("OPENPRISM_LLM_API_KEY missing", file=sys.stderr)
        return 1

    # 合并 path 中的连续 /，避免 3000//v1 命中前端 SPA
    p = urlsplit(endpoint)
    path = "/".join(x for x in p.path.split("/") if x)
    if path:
        path = "/" + path
    endpoint = urlunsplit((p.scheme, p.netloc, path or "/", p.query, p.fragment))

    body = {
        "model": model,
        "messages": [{"role": "user", "content": user_msg}],
        "temperature": 0.2,
        "max_tokens": 512,
    }
    data = json.dumps(body).encode("utf-8")

    req = urllib.request.Request(
        endpoint,
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
    )

    print(f"POST {endpoint}\nmodel={model!r}\nuser={user_msg!r}\n", file=sys.stderr)

    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            text = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")
        print(f"HTTP {e.code}: {err_body}", file=sys.stderr)
        return 1
    except OSError as e:
        print(f"Request failed: {e}", file=sys.stderr)
        return 1

    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        print("Non-JSON response:\n", text[:4000])
        return 1

    print(json.dumps(parsed, ensure_ascii=False, indent=2))

    choice0 = (parsed.get("choices") or [{}])[0]
    msg = (choice0.get("message") or {}) if isinstance(choice0, dict) else {}
    content = msg.get("content")
    reasoning = msg.get("reasoning_content")
    print("\n--- extracted ---", file=sys.stderr)
    print(f"content: {content!r}", file=sys.stderr)
    print(f"reasoning_content: {reasoning!r}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
