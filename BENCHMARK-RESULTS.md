# PI WEB Benchmark: Node.js vs Bun

**Environment:** Linux/x64, Node v24.19.0, Bun 1.4.2
**Method:** 30 runs per endpoint, 5 warmup requests, median ± stddev

## Memory Usage

```
Node.js  ████████████████████████████░░░  201 MB
Bun      █████████████████░░░░░░░░░░░░░░  124 MB  ▼38%
```

Bun uses **38% less memory** (124 MB vs 201 MB RSS).

## API Response Latency

| Endpoint | Node.js | Bun | Δ |
|---|---|---|---|
| `/api/pi-web/version` | 189ms ±13.9ms | 196ms ±18.7ms | Node 4% faster |
| `/api/pi-web/status` | 935µs ±0.4ms | 1.1ms ±0.2ms | Node 19% faster |
| `/api/plugins` | 58.3ms ±12.8ms | 35.8ms ±11.6ms | **Bun 39% faster** |
| `/` | 1.3ms ±0.2ms | 1.1ms ±0.3ms | **Bun 17% faster** |

## Key Findings

1. **Memory:** Bun uses significantly less memory (38% reduction)
2. **Static assets:** Bun serves the client bundle faster (`/api/plugins` 39% faster)
3. **API endpoints:** Performance is comparable — Node is slightly faster on some, Bun on others
4. **Startup:** Both runtimes start in under 3 seconds

## How to Run

```bash
# Build first
npm run build

# Run benchmark (default: 10 runs)
node scripts/benchmark-node-vs-bun.mjs

# Higher confidence (more runs)
node scripts/benchmark-node-vs-bun.mjs --runs 50 --warmup 10
```

## Methodology

- Each endpoint is hit sequentially (not parallel) to measure single-request latency
- Warmup requests are discarded to avoid cold-start bias
- Memory is measured via RSS (`ps -o rss=`) after the server is stable
- Servers are started fresh for each runtime (no caching between Node and Bun)
- Port 3100 (Node) and 3200 (Bun) are used to avoid conflicts
