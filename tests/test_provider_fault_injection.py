from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from arforge.core.provider_fault_injection import run_provider_transport_fault_probe
from arforge.models.deepseek_adapter import DeepSeekAdapter
from arforge.models.resilience import RetryPolicy


class _ProviderHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, _format, *_args):
        return

    def do_POST(self):  # noqa: N802 - BaseHTTPRequestHandler contract
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length:
            self.rfile.read(length)
        payload = json.dumps(
            {
                "id": "chatcmpl-fault-probe",
                "object": "chat.completion",
                "created": 0,
                "model": "fault-probe-model",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "OK"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {
                    "prompt_tokens": 4,
                    "completion_tokens": 1,
                    "total_tokens": 5,
                },
            },
            separators=(",", ":"),
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def test_transport_faults_cross_http_boundary_and_recover_without_secret_leakage():
    upstream = ThreadingHTTPServer(("127.0.0.1", 0), _ProviderHandler)
    thread = threading.Thread(target=upstream.serve_forever, daemon=True)
    thread.start()
    api_key = "fault-probe-secret-must-not-appear"

    def adapter_factory(base_url: str, max_retries: int):
        adapter = DeepSeekAdapter(
            api_key=api_key,
            base_url=base_url,
            model="fault-probe-model",
        )
        adapter._retry = RetryPolicy(
            max_retries=max_retries,
            base_delay=0,
            jitter=False,
        )
        return adapter

    try:
        result = run_provider_transport_fault_probe(
            adapter_factory,
            upstream_base_url=f"http://127.0.0.1:{upstream.server_port}",
        )
    finally:
        upstream.shutdown()
        upstream.server_close()
        thread.join(timeout=5)

    assert result["passed"] is True
    assert [item["scenario"] for item in result["scenarios"]] == [
        "http_429",
        "http_503",
        "connection_drop",
    ]
    assert all(item["fault_detected"] for item in result["scenarios"])
    assert all(item["false_success"] is False for item in result["scenarios"])
    assert all(item["proxy_requests"] == 1 for item in result["scenarios"])
    assert all(item["retry_proxy_requests"] == 2 for item in result["scenarios"])
    assert all(item["automatic_retry_recovered"] for item in result["scenarios"])
    assert result["recovery"]["real_provider_request"] is True
    assert result["recovery"]["content_valid"] is True
    assert result["recovery"]["not_truncated"] is True
    retained = json.dumps(result, sort_keys=True)
    assert api_key not in retained
    assert "Reply with exactly OK" not in retained


def test_false_success_fails_the_fault_probe():
    class _IgnoresTransport:
        def generate_with_tools(self, *_args, **_kwargs):
            return type("Response", (), {"content": "OK", "finish_reason": "stop"})()

    upstream = ThreadingHTTPServer(("127.0.0.1", 0), _ProviderHandler)
    thread = threading.Thread(target=upstream.serve_forever, daemon=True)
    thread.start()
    try:
        result = run_provider_transport_fault_probe(
            lambda _base_url, _max_retries: _IgnoresTransport(),
            upstream_base_url=f"http://127.0.0.1:{upstream.server_port}",
            scenarios=("http_429",),
        )
    finally:
        upstream.shutdown()
        upstream.server_close()
        thread.join(timeout=5)

    assert result["passed"] is False
    assert result["scenarios"][0]["false_success"] is True
    assert result["scenarios"][0]["proxy_requests"] == 0
