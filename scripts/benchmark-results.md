# PI WEB Performance Benchmark: Bun vs Node

- Node v24.19.0 · Bun 1.4.2 · 30 samples per metric · localhost loopback
- Terminal PTY: bundled Terminal plugin backend (BunPTYBackend under bun, NodePTYBackend under node)
- Plugin channel open: Fastify 5 + @fastify/websocket 11 with one open→ready handshake per sample

| Metric | Bun | Node | Winner |
|---|---:|---:|---|
| WS open/close mean | 1.615 | 3.255 | bun 2.02x faster |
| WS open/close p95 | 6.437 | 3.988 | node 1.61x faster |
| WS open/close p99 | 10.629 | 19.733 | bun 1.86x faster |
| WS throughput (server/s) | 334,728 | 62,607 | bun 5.35x faster |
| PTY create | 0.957 | 2.250 | bun 2.35x faster |
| PTY write | 0.009 | 0.118 | bun 13.11x faster |
| PTY kill | 0.032 | 0.035 | bun 1.09x faster |
| HTTP round-trip mean | 1.037 | 5.994 | bun 5.78x faster |
| HTTP round-trip p95 | 2.398 | 4.953 | bun 2.07x faster |
| Channel open mean | 2.139 | 3.062 | bun 1.43x faster |
| Channel open p95 | 3.271 | 5.018 | bun 1.53x faster |

## Notes

- Higher is better only for throughput; lower is better everywhere else.
- PTY write measures the synchronous write() call, not shell echo latency.
- p99 values are tail-noise sensitive at n=30; mean/p95 are the stable signals.
- Under bun the plugin channel never touches node-pty; the WS payload-limit seam now skips transports without ws internals (fix in 9989d385).

<details><summary>Raw JSON</summary>

```json
{
  "bun": {
    "ws_latency": {
      "mean": 1.615,
      "p50": 1.043,
      "p95": 6.437,
      "p99": 10.629,
      "min": 0.647,
      "max": 10.629,
      "samples": 30
    },
    "ws_throughput": {
      "sent": 335094,
      "client_rate_per_s": 334728,
      "server_received": 335094,
      "server_rate_per_s": 334728
    },
    "terminal": {
      "create": "0.957",
      "write": "0.009",
      "kill": "0.032"
    },
    "http": {
      "mean": 1.037,
      "p50": 0.471,
      "p95": 2.398,
      "p99": 13.249,
      "min": 0.301,
      "max": 13.249,
      "samples": 30
    },
    "channel_open": {
      "mean": 2.139,
      "p50": 1.117,
      "p95": 3.271,
      "p99": 25.467,
      "min": 0.664,
      "max": 25.467,
      "samples": 30
    }
  },
  "node": {
    "ws_latency": {
      "mean": 3.255,
      "p50": 2.658,
      "p95": 3.988,
      "p99": 19.733,
      "min": 1.944,
      "max": 19.733,
      "samples": 30
    },
    "ws_throughput": {
      "sent": 62611,
      "client_rate_per_s": 62607,
      "server_received": 62611,
      "server_rate_per_s": 62607
    },
    "terminal": {
      "create": "2.250",
      "write": "0.118",
      "kill": "0.035"
    },
    "http": {
      "mean": 5.994,
      "p50": 2.707,
      "p95": 4.953,
      "p99": 95.744,
      "min": 1.313,
      "max": 95.744,
      "samples": 30
    },
    "channel_open": {
      "mean": 3.062,
      "p50": 1.923,
      "p95": 5.018,
      "p99": 29.062,
      "min": 0.993,
      "max": 29.062,
      "samples": 30
    }
  }
}
```
</details>
