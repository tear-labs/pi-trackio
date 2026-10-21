#!/usr/bin/env python3
# pyright: reportMissingImports=false
"""Run the local Trackio dashboard, API, and MCP server under systemd."""
from __future__ import annotations

import os
import signal
import sys

import trackio
import trackio.utils


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def main() -> int:
    host = os.environ.get("TRACKIO_HOST", "127.0.0.1")
    port = int(os.environ.get("TRACKIO_PORT", "30143"))
    mcp_server = _env_bool("GRADIO_MCP_SERVER", True)
    footer = _env_bool("TRACKIO_FOOTER", False)

    # Keep TRACKIO_WRITE_TOKEN in ~/.config/trackio.env (0600) rather than
    # printing the tokenized URL into the user's systemd journal.
    trackio.utils.print_write_token_instructions = lambda *_a, **_kw: None

    app, local_url, _share_url, _full_url = trackio.show(
        host=host,
        server_port=port,
        mcp_server=mcp_server,
        footer=footer,
        open_browser=False,
        block_thread=False,
    )

    def _shutdown(signum: int, _frame: object) -> None:
        print(f"Received signal {signum}, shutting down Trackio server...", flush=True)
        app.close(verbose=False)
        sys.exit(0)

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)
    print(
        f"Trackio server ready at {local_url} (data_dir={trackio.utils.TRACKIO_DIR}, mcp={mcp_server})",
        flush=True,
    )
    signal.pause()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
