#!/usr/bin/env node
/**
 * Benchmark: Bun vs Node runtime performance for PI WEB subsystems.
 *
 * Measures:
 * 1. WebSocket open/close latency (plugin channel handshake simulation)
 * 2. WebSocket message throughput (1s send window)
 * 3. Terminal PTY spawn + write + kill latency (BunPTYBackend vs NodePTYBackend)
 * 4. HTTP request handling latency (sequential fetch round-trips)
 * 5. Plugin channel open latency (fastify + @fastify/websocket)
 *
 * Run: node scripts/benchmark-bun-vs-node.mjs [--iterations=N]
 *
 * Servers are spawned as child processes that stay alive while the benchmark
 * runs; readiness is detected from stdout and every phase is bounded by a
 * hard timeout so a hung runtime can never wedge the benchmark.
 */

import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import fs from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const ITERATIONS = 30;
const PORT_BASE = 19850;
const PHASE_TIMEOUT_MS = 60_000;
const SERVER_READY_TIMEOUT_MS = 15_000;

const runCmd = (runtime) => (runtime === "bun" ? "bun" : "node");

/** Spawn a long-lived script; resolve { child } once it prints READY marker. */
function startServer(runtime, script, marker) {
  return new Promise((resolve, reject) => {
    const child = spawn(runCmd(runtime), ["-e", script], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`server did not print ${marker} within ${SERVER_READY_TIMEOUT_MS}ms`));
    }, SERVER_READY_TIMEOUT_MS);
    let buffered = "";
    const onData = (d) => {
      buffered += d.toString();
      if (buffered.includes(marker)) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        resolve({ child });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (d) => { buffered += d.toString(); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (code ${code}): ${buffered.slice(0, 300)}`));
    });
  });
}

/** Run a short-lived script and capture stdout. Hard timeout included. */
function runScript(runtime, script, timeoutMs = PHASE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn(runCmd(runtime), ["-e", script], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: -1, out, err: `${err}\n[timeout after ${timeoutMs}ms]` });
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out, err });
    });
  });
}

function stopServer(child) {
  if (!child) return;
  try { child.kill("SIGTERM"); } catch { /* already gone */ }
  setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 500);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function summarize(times) {
  times.sort((a, b) => a - b);
  const n = times.length;
  const mean = times.reduce((s, t) => s + t, 0) / n;
  return {
    mean: +mean.toFixed(3),
    p50: +times[Math.floor(n * 0.5)].toFixed(3),
    p95: +times[Math.floor(n * 0.95)].toFixed(3),
    p99: +times[Math.floor(n * 0.99)].toFixed(3),
    min: +times[0].toFixed(3),
    max: +times[n - 1].toFixed(3),
    samples: n,
  };
}

function clientScript(body, resultExpr) {
  return `
    import { WebSocket } from "ws";
    ${body}
    console.log("RESULT:" + JSON.stringify(${resultExpr}));
  `;
}

// ── 1. WebSocket open/close latency (sequential) ────────────────────
async function benchmarkWsLatency(runtime, port) {
  const wss = new WebSocketServer({ port, host: "127.0.0.1" });
  await new Promise((r) => wss.on("listening", r));

  const script = clientScript(
    `
    const times = [];
    const N = ${ITERATIONS};
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      await new Promise((resolveClose) => {
        const ws = new WebSocket("ws://127.0.0.1:${port}/");
        ws.on("open", () => ws.close(1000));
        ws.on("close", resolveClose);
        ws.on("error", resolveClose);
      });
      times.push(performance.now() - t0);
    }
    `,
    "times",
  );

  const result = await runScript(runtime, script);
  wss.close();
  await sleep(50);

  const line = result.out.split("\n").find((l) => l.startsWith("RESULT:"));
  if (!line) return { error: (result.err || result.out || "no output").slice(0, 300) };
  const times = JSON.parse(line.slice("RESULT:".length));
  return summarize(times);
}

// ── 2. WebSocket message throughput (1s window) ─────────────────────
async function benchmarkWsThroughput(runtime, port) {
  const wss = new WebSocketServer({ port, host: "127.0.0.1" });
  await new Promise((r) => wss.on("listening", r));

  let serverMsgs = 0;
  wss.on("connection", (ws) => { ws.on("message", () => { serverMsgs++; }); });

  const scriptFixed = `
    import { WebSocket } from "ws";
    const ws = new WebSocket("ws://127.0.0.1:${port}/");
    await new Promise((r) => ws.on("open", r));
    const frame = "x".repeat(512);
    const start = performance.now();
    let sent = 0;
    const pump = () => {
      while (performance.now() - start < 1000 && ws.bufferedAmount < 1 << 20) {
        ws.send(frame);
        sent++;
      }
      if (performance.now() - start < 1000) setImmediate(pump);
      else {
        const elapsed = performance.now() - start;
        setTimeout(() => { ws.close(); console.log("RESULT:" + JSON.stringify({ sent, elapsed })); }, 300);
      }
    };
    pump();
  `;
  const scriptToRun = scriptFixed;

  const result = await runScript(runtime, scriptToRun, PHASE_TIMEOUT_MS);
  await sleep(200);
  wss.close();
  await sleep(50);

  const line = result.out.split("\n").find((l) => l.startsWith("RESULT:"));
  if (!line) return { error: (result.err || result.out || "no output").slice(0, 300) };
  const { sent, elapsed } = JSON.parse(line.slice("RESULT:".length));
  return {
    sent,
    client_rate_per_s: Math.round((sent / elapsed) * 1000),
    server_received: serverMsgs,
    server_rate_per_s: Math.round((serverMsgs / elapsed) * 1000),
  };
}

// ── 3. Terminal PTY spawn + write + kill ────────────────────────────
async function benchmarkTerminalLatency(runtime) {
  const distPath = join(repoRoot, "dist", "pi-web-plugins", "terminal", "ptyBackend.js");
  const script = `
    import { createDefaultBackend } from ${JSON.stringify(distPath)};
    const times = { create: [], write: [], kill: [] };
    for (let i = 0; i < 20; i++) {
      const b = createDefaultBackend();
      if (!b.available()) { console.log("ERROR:backend-unavailable"); process.exit(1); }
      let t0 = performance.now();
      const { id } = b.create({ cwd: "/tmp", shell: "/bin/bash", shellArgs: ["-i"], cols: 80, rows: 24, env: process.env });
      times.create.push(performance.now() - t0);
      t0 = performance.now();
      b.write(id, "echo ok\\n");
      times.write.push(performance.now() - t0);
      t0 = performance.now();
      b.kill(id);
      times.kill.push(performance.now() - t0);
      b.dispose();
    }
    const avg = (a) => (a.reduce((s, t) => s + t, 0) / a.length).toFixed(3);
    console.log("RESULT:" + JSON.stringify({ create: avg(times.create), write: avg(times.write), kill: avg(times.kill) }));
  `;

  const result = await runScript(runtime, script, PHASE_TIMEOUT_MS);
  const line = result.out.split("\n").find((l) => l.startsWith("RESULT:"));
  if (!line) {
    const errorLine = result.out.split("\n").find((l) => l.startsWith("ERROR:"));
    return { error: (errorLine ?? result.err ?? "no output").slice(0, 300) };
  }
  return JSON.parse(line.slice("RESULT:".length));
}

// ── 4. HTTP round-trip latency ──────────────────────────────────────
async function benchmarkHttpLatency(runtime, port) {
  const { child } = await startServer(
    runtime,
    `
    import { createServer } from "node:http";
    const server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: 1, data: "x".repeat(512) }));
    });
    server.listen(${port}, "127.0.0.1", () => console.log("HTTP_READY"));
    `,
    "HTTP_READY",
  );

  try {
    const script = `
      let times = [];
      for (let i = 0; i < ${ITERATIONS}; i++) {
        const t0 = performance.now();
        const r = await fetch("http://127.0.0.1:${port}/");
        await r.json();
        times.push(performance.now() - t0);
      }
      console.log("RESULT:" + JSON.stringify(times));
    `;
    const result = await runScript(runtime, script, PHASE_TIMEOUT_MS);
    const line = result.out.split("\n").find((l) => l.startsWith("RESULT:"));
    if (!line) return { error: (result.err || "no output").slice(0, 300) };
    return summarize(JSON.parse(line.slice("RESULT:".length)));
  } finally {
    stopServer(child);
    await sleep(100);
  }
}

// ── 5. Plugin channel open (fastify + @fastify/websocket) ───────────
async function benchmarkChannelOpen(runtime, port) {
  const { child } = await startServer(
    runtime,
    `
    import Fastify from "fastify";
    import fastifyWs from "@fastify/websocket";
    const app = Fastify({ logger: false });
    await app.register(fastifyWs);
    app.get("/channel", { websocket: true }, (socket) => {
      socket.on("message", (msg) => {
        try {
          const env = JSON.parse(msg.toString());
          if (env.kind === "open") socket.send(JSON.stringify({ version: 1, kind: "ready" }));
        } catch {}
      });
    });
    await app.listen({ port: ${port}, host: "127.0.0.1" });
    console.log("CHANNEL_READY");
    `,
    "CHANNEL_READY",
  );

  try {
    const script = `
      import { WebSocket } from "ws";
      const times = [];
      for (let i = 0; i < ${ITERATIONS}; i++) {
        const ws = new WebSocket("ws://127.0.0.1:${port}/channel");
        const t0 = performance.now();
        const ready = new Promise((resolveReady) => {
          ws.on("message", (m) => { if (m.toString().includes("ready")) resolveReady(performance.now() - t0); });
          ws.on("error", () => resolveReady(-1));
        });
        ws.on("open", () => ws.send(JSON.stringify({ version: 1, kind: "open", revision: "sha256:test", input: {} })));
        const latency = await ready;
        if (latency >= 0) times.push(latency);
        ws.close(1000);
        await new Promise((r) => ws.on("close", r));
      }
      console.log("RESULT:" + JSON.stringify(times));
    `;
    const result = await runScript(runtime, script, PHASE_TIMEOUT_MS);
    const line = result.out.split("\n").find((l) => l.startsWith("RESULT:"));
    if (!line) return { error: (result.err || "no output").slice(0, 300) };
    return summarize(JSON.parse(line.slice("RESULT:".length)));
  } finally {
    stopServer(child);
    await sleep(100);
  }
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  console.log("╔═══════════════════════════════════════════════════════════════════╗");
  console.log("║  PI WEB Performance Benchmark: Bun vs Node                       ║");
  console.log("╚═══════════════════════════════════════════════════════════════════╝");
  console.log(`Iterations per measurement: ${ITERATIONS}\n`);

  const results = {};

  for (const rt of ["bun", "node"]) {
    console.log(`─── ${rt.toUpperCase()} ───`);
    const r = {};

    const phases = [
      ["ws_latency", "WebSocket open/close", (p) => benchmarkWsLatency(rt, PORT_BASE + p)],
      ["ws_throughput", "WebSocket throughput", (p) => benchmarkWsThroughput(rt, PORT_BASE + 1)],
      ["terminal", "Terminal PTY", () => benchmarkTerminalLatency(rt)],
      ["http", "HTTP round-trip", (p) => benchmarkHttpLatency(rt, PORT_BASE + 2)],
      ["channel_open", "Plugin channel open", (p) => benchmarkChannelOpen(rt, PORT_BASE + 3)],
    ];

    for (const [key, label, fn] of phases) {
      try {
        const value = await fn(0);
        r[key] = value;
        if (value.error) console.log(`  ${label}: FAILED (${value.error.slice(0, 120)})`);
        else if (key === "ws_throughput") console.log(`  ${label}: client ${value.client_rate_per_s}/s, server processed ${value.server_received} frames (${value.server_rate_per_s}/s)`);
        else if (key === "terminal") console.log(`  ${label}: create=${value.create}ms write=${value.write}ms kill=${value.kill}ms`);
        else console.log(`  ${label}: mean=${value.mean}ms p95=${value.p95}ms p99=${value.p99}ms (n=${value.samples})`);
      } catch (e) {
        r[key] = { error: String(e).slice(0, 300) };
        console.log(`  ${label}: FAILED (${String(e).slice(0, 120)})`);
      }
    }

    results[rt] = r;
    console.log("");
    await sleep(200);
  }

  // ── Summary table ──
  const num = (v) => (typeof v === "number" ? v : typeof v === "string" && v !== "" && !isNaN(parseFloat(v)) ? parseFloat(v) : NaN);
  const row = (label, bunVal, nodeVal, unit, lowerBetter = true) => {
    const b = num(bunVal), n = num(nodeVal);
    let winner = "—";
    if (!isNaN(b) && !isNaN(n) && b > 0 && n > 0) {
      if (lowerBetter) winner = b < n ? `bun ${(n / b).toFixed(2)}x faster` : `node ${(b / n).toFixed(2)}x faster`;
      else winner = b > n ? `bun ${(b / n).toFixed(2)}x faster` : `node ${(n / b).toFixed(2)}x faster`;
    }
    return { label, bunVal, nodeVal, winner };
  };

  const rows = [
    row("WS open/close mean", results.bun?.ws_latency?.mean, results.node?.ws_latency?.mean, "ms"),
    row("WS open/close p95", results.bun?.ws_latency?.p95, results.node?.ws_latency?.p95, "ms"),
    row("WS open/close p99", results.bun?.ws_latency?.p99, results.node?.ws_latency?.p99, "ms"),
    row("WS throughput (server/s)", results.bun?.ws_throughput?.server_rate_per_s, results.node?.ws_throughput?.server_rate_per_s, "msgs/s", false),
    row("PTY create", results.bun?.terminal?.create, results.node?.terminal?.create, "ms"),
    row("PTY write", results.bun?.terminal?.write, results.node?.terminal?.write, "ms"),
    row("PTY kill", results.bun?.terminal?.kill, results.node?.terminal?.kill, "ms"),
    row("HTTP round-trip mean", results.bun?.http?.mean, results.node?.http?.mean, "ms"),
    row("HTTP round-trip p95", results.bun?.http?.p95, results.node?.http?.p95, "ms"),
    row("Channel open mean", results.bun?.channel_open?.mean, results.node?.channel_open?.mean, "ms"),
    row("Channel open p95", results.bun?.channel_open?.p95, results.node?.channel_open?.p95, "ms"),
  ];

  console.log("╔═══════════════════════════════════════════════════════════════════╗");
  console.log("║  SUMMARY                                                          ║");
  console.log("╚═══════════════════════════════════════════════════════════════════╝");
  const fmt = (v) => {
    if (typeof v !== "number") return String(v ?? "N/A");
    return v >= 1000 ? Math.round(v).toLocaleString("en-US") : v.toFixed(3);
  };
  console.log(`  ${"Metric".padEnd(26)} ${"Bun".padStart(12)} ${"Node".padStart(12)}   Winner`);
  console.log(`  ${"─".repeat(26)} ${"─".repeat(12)} ${"─".repeat(12)}   ${"─".repeat(20)}`);
  for (const { label, bunVal, nodeVal, winner } of rows) {
    console.log(`  ${label.padEnd(26)} ${fmt(bunVal).padStart(12)} ${fmt(nodeVal).padStart(12)}   ${winner}`);
  }

  // Machine-readable + markdown
  const jsonPath = join(repoRoot, "scripts", "benchmark-results.json");
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));

  const mdPath = join(repoRoot, "scripts", "benchmark-results.md");
  let md = "# PI WEB Performance Benchmark: Bun vs Node\n\n";
  md += `Host: ${process.env.BENCH_HOST_NOTE ?? "local"} · Node v${process.versions.node} · ${"Bun"} runtime 1.4.2 · ${ITERATIONS} samples per metric\n\n`;
  md += "| Metric | Bun | Node | Winner |\n|---|---:|---:|---|\n";
  for (const { label, bunVal, nodeVal, winner } of rows) {
    md += `| ${label} | ${fmt(bunVal)} | ${fmt(nodeVal)} | ${winner} |\n`;
  }
  md += "\n<details><summary>Raw JSON</summary>\n\n```json\n" + JSON.stringify(results, null, 2) + "\n```\n</details>\n";
  fs.writeFileSync(mdPath, md);

  console.log(`\n📊 JSON: ${jsonPath}`);
  console.log(`📝 Markdown: ${mdPath}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });