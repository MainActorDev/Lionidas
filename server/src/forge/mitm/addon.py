"""Forge MITM addon — mitmproxy owns the crypto; Forge owns the semantics.

Loaded via: mitmdump -s addon.py --set forge_state_dir=<dir> --listen-port <p>
State contract: reads <state_dir>/forge-mitm-state.json (mode + presets,
content-hashed, written by the Crucible server) and appends traffic rows to
<state_dir>/traffic.ndjson (one JSON line per request/response).

Matcher rules are ported 1:1 from the JS implementation (forge/matcher.ts) and
pinned by cross-implementation contract fixtures in CI. Seq cursors are
process-local (transport-scoped by design: a run pins ONE transport).
"""
import json
import os
import re
import time


class ForgeState:
    def __init__(self, state_dir):
        self.state_dir = state_dir
        self.mtime = 0
        self.mode = "hybrid"
        self.presets = []
        self.cursors = {}

    def reload_if_changed(self):
        path = os.path.join(self.state_dir, "forge-mitm-state.json")
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            return
        if mtime == self.mtime:
            return
        self.mtime = mtime
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            self.mode = data.get("mode", "hybrid")
            self.presets = data.get("presets", [])
        except (OSError, ValueError):
            pass  # keep last-good state


def _glob_to_regex(pattern):
    parts = pattern.split("*")
    return re.compile("^" + ".*".join(re.escape(p) for p in parts) + "$")


def path_matches(pattern, kind, path):
    if kind == "exact":
        return pattern == path
    if kind == "glob":
        return bool(_glob_to_regex(pattern).match(path))
    try:
        return bool(re.compile(pattern).search(path))
    except re.error:
        return False


def guards_pass(preset, flow):
    g = preset.get("guards") or {}
    q = g.get("query") or {}
    for k, v in q.items():
        if flow.query.get(k) != v:
            return False
    h = g.get("headers") or {}
    lower = {k.lower(): v for k, v in flow.request.headers.items()}
    for k, v in h.items():
        if lower.get(k.lower()) != v:
            return False
    return True


def match_preset(state, flow):
    candidates = [
        p for p in state.presets
        if (p.get("method", "*") == "*" or p.get("method", "*") == flow.request.method.upper())
        and path_matches(p.get("pathPattern", ""), p.get("match", "exact"), flow.request.path)
        and guards_pass(p, flow)
    ]
    if not candidates:
        return None
    candidates.sort(key=lambda p: len(p.get("pathPattern", "")), reverse=True)
    return candidates[0]


def seq_response(preset, state):
    seq = preset.get("seq") or []
    if not seq:
        return None
    key = preset["id"]
    idx = state.cursors.get(key, 0)
    idx = min(idx, len(seq) - 1)  # last repeats
    state.cursors[key] = idx + 1
    return seq[idx]


class ForgeRouter:
    def __init__(self):
        self.state = None
        self.traffic_path = None
        self.t0 = {}

    def load(self, loader):
        loader.add_option(
            "forge_state_dir", str, "/tmp/forge-mitm",
            "Directory holding forge-mitm-state.json and traffic.ndjson",
        )

    def configure(self, updated):
        from mitmproxy import ctx
        d = ctx.options.forge_state_dir
        os.makedirs(d, exist_ok=True)
        self.state = ForgeState(d)
        self.traffic_path = os.path.join(d, "traffic.ndjson")

    def request(self, flow):
        self.state.reload_if_changed()
        self.t0[flow.id] = time.time()

        if self.state.mode == "record":
            return  # pass-through; response hook logs

        preset = match_preset(self.state, flow)
        if preset is None:
            if self.state.mode == "intercept":
                from mitmproxy import http
                flow.response = http.Response.make(
                    501, json.dumps({"error": "forge intercept: no preset matched"}).encode(),
                    {"content-type": "application/json"},
                )
            return  # hybrid: pass through

        failure = preset.get("failure")
        if failure == "timeout":
            # stall: never answer (client timeout path)
            from mitmproxy import ctx
            ctx.log.info(f"forge: timeout preset {preset['id']} — stalling {flow.request.path}")
            flow.response = None
            # mark to skip response logging as success
            self.t0[flow.id] = -1
            return
        if failure == "reset":
            # hard drop: kill the connection after response headers start
            flow.client_conn.send(b"HTTP/1.1 500 forge-reset\r\ncontent-length: 0\r\n\r\n")
            self.t0[flow.id] = -2
            return

        seq_step = seq_response(preset, self.state)
        status = (seq_step or preset).get("status", preset.get("status", 200))
        delay = (seq_step or preset).get("delayMs", preset.get("delayMs", 0))
        if delay:
            time.sleep(delay / 1000.0)

        from mitmproxy import http
        body = b""
        body_path = (seq_step or preset).get("bodyPath") or preset.get("bodyPath")
        if body_path:
            try:
                with open(body_path, "rb") as f:
                    body = f.read()
            except OSError:
                body = b""
        if failure == "malformed":
            body = b"{not-json"

        headers = {"content-type": "application/json"}
        headers.update(preset.get("headers") or {})
        flow.response = http.Response.make(status, body, headers)

    def response(self, flow):
        t0 = self.t0.pop(flow.id, None)
        status = flow.response.status_code if flow.response else 0
        preset_id = None  # matched in request(); re-derive for logging only
        self.state.reload_if_changed()
        p = match_preset(self.state, flow)
        if p and self.state.mode != "record":
            preset_id = p["id"]
        row = {
            "ts": int(time.time() * 1000),
            "mode": "mitm-" + self.state.mode,
            "method": flow.request.method,
            "host": flow.request.pretty_host,
            "path": flow.request.path,
            "matched_preset_id": preset_id,
            "status": status if t0 not in (-1, -2) else (0 if t0 == -1 else 599),
            "latency_ms": int((time.time() - t0) * 1000) if t0 and t0 > 0 else 0,
            "run_id": None,
        }
        try:
            with open(self.traffic_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(row) + "\n")
        except OSError:
            pass


addons = [ForgeRouter()]
