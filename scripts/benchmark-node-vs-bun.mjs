#!/usr/bin/env node
/**
 * Benchmark: PI WEB on Node.js vs Bun
 *
 * Runs multiple iterations per endpoint like hyperfine, computes statistics,
 * and outputs a terminal-friendly comparison table.
 *
 * Usage:
 *   node scripts/benchmark-node-vs-bun.mjs [--runs 10] [--warmup 3]
 */

import { spawn } from "node:child_process";
import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? Number(args[i + 1]) : fallback;
}
const RUNS = flag("runs", 10);
const WARMUP = flag("warmup", 3);
const NODE_PORT = 3100;
const BUN_PORT = 3200;
const TIMEOUT = 15_000;

// ── ANSI colors ──────────────────────────────────────────────────────────────

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  bg: {
    blue: "\x1b[44m",
    green: "\x1b[42m",
    yellow: "\x1b[43m",
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function fetch(url) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode, ms: performance.now() - start, body }));
      })
      .on("error", reject);
  });
}

async function waitReady(port) {
  const deadline = performance.now() + TIMEOUT;
  while (performance.now() < deadline) {
    try {
      const r = await fetch(`http://localhost:${port}/api/pi-web/version`);
      if (r.status === 200) return true;
    } catch {}
    await sleep(250);
  }
  return false;
}

function rss(pid) {
  try {
    return Math.round(parseInt(execSync(`ps -o rss= -p ${pid}`, { encoding: "utf8" }).trim(), 10) / 1024);
  } catch {
    return null;
  }
}

function stats(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const variance = sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const stddev = Math.sqrt(variance);
  const median = n % 2 ? sorted[Math.floor(n / 2)] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const min = sorted[0];
  const max = sorted[n - 1];
  const p95 = sorted[Math.floor(n * 0.95)];
  const p99 = sorted[Math.floor(n * 0.99)];
  return { mean, median, min, max, stddev, p95, p99, n };
}

function fmt(ms) {
  return ms < 1 ? `${(ms * 1000).toFixed(0)}µs` : ms < 100 ? `${ms.toFixed(1)}ms` : `${ms.toFixed(0)}ms`;
}

function fmtStd(ms) {
  return `±${ms < 100 ? ms.toFixed(1) : ms.toFixed(0)}ms`;
}

function pct(a, b) {
  if (!b || !a) return "";
  const diff = ((b - a) / b) * 100;
  if (Math.abs(diff) < 1) return `${c.dim}~0%${c.reset}`;
  return diff > 0
    ? `${c.green}▼${Math.abs(diff).toFixed(0)}%${c.reset}`
    : `${c.red}▲${Math.abs(diff).toFixed(0)}%${c.reset}`;
}

function bar(ms, maxMs) {
  const width = 30;
  const filled = Math.round((ms / maxMs) * width);
  return "█".repeat(Math.max(1, filled)) + "░".repeat(width - Math.max(1, filled));
}

// ── Server lifecycle ─────────────────────────────────────────────────────────

function startServer(runtime, port) {
  return new Promise((resolve, reject) => {
    const serverPath = join(ROOT, "dist", "server", "index.js");
    const child = spawn(runtime === "bun" ? "bun" : "node", [serverPath], {
      env: { ...process.env, PI_WEB_RUNTIME: runtime, PI_WEB_PORT: String(port), PI_WEB_HOST: "127.0.0.1", NODE_ENV: "production" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    child.on("error", reject);
    resolve(child);
  });
}

function kill(child) {
  try { process.kill(-child.pid, "SIGTERM"); } catch {}
  setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 1000);
}

// ── Benchmark runner ─────────────────────────────────────────────────────────

async function benchEndpoint(runtime, port, endpoint, runs, warmup) {
  const url = `http://localhost:${port}${endpoint}`;
  // Warmup
  for (let i = 0; i < warmup; i++) await fetch(url).catch(() => {});
  // Measure
  const times = [];
  for (let i = 0; i < runs; i++) {
    const r = await fetch(url).catch(() => null);
    if (r && r.status === 200) times.push(r.ms);
  }
  return stats(times);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const nodeVersion = execSync("node --version", { encoding: "utf8" }).trim();
  const bunVersion = execSync("bun --version", { encoding: "utf8" }).trim();

  console.log();
  console.log(`${c.bold}${c.cyan}  ╔══════════════════════════════════════════════════════╗${c.reset}`);
  console.log(`${c.bold}${c.cyan}  ║         PI WEB — Node.js vs Bun Benchmark          ║${c.reset}`);
  console.log(`${c.bold}${c.cyan}  ╚══════════════════════════════════════════════════════╝${c.reset}`);
  console.log();
  console.log(`  ${c.dim}Node ${nodeVersion}  ·  Bun ${bunVersion}  ·  ${RUNS} runs  ·  ${WARMUP} warmup${c.reset}`);
  console.log(`  ${c.dim}${"─".repeat(55)}${c.reset}`);

  const endpoints = [
    "/api/pi-web/version",
    "/api/pi-web/status",
    "/api/plugins",
    "/",
  ];

  // ── Start Node ───────────────────────────────────────────────────────────

  console.log(`\n  ${c.bold}${c.blue}● Starting Node.js server...${c.reset}`);
  const nodeChild = await startServer("node", NODE_PORT);
  const nodeReady = await waitReady(NODE_PORT);
  if (!nodeReady) {
    console.log(`  ${c.red}✗ Node.js failed to start${c.reset}`);
    kill(nodeChild);
    return;
  }
  const nodeMem = rss(nodeChild.pid);
  console.log(`  ${c.green}✓ Ready${c.reset}  ${c.dim}(${nodeMem} MB RSS)${c.reset}`);

  const nodeResults = {};
  for (const ep of endpoints) {
    process.stdout.write(`  ${c.dim}Benchmarking ${ep}...${c.reset}`);
    nodeResults[ep] = await benchEndpoint("node", NODE_PORT, ep, RUNS, WARMUP);
    console.log(` ${c.green}done${c.reset}`);
  }
  kill(nodeChild);

  await sleep(1000);

  // ── Start Bun ────────────────────────────────────────────────────────────

  console.log(`\n  ${c.bold}${c.yellow}● Starting Bun server...${c.reset}`);
  const bunChild = await startServer("bun", BUN_PORT);
  const bunReady = await waitReady(BUN_PORT);
  if (!bunReady) {
    console.log(`  ${c.red}✗ Bun failed to start${c.reset}`);
    kill(bunChild);
    return;
  }
  const bunMem = rss(bunChild.pid);
  console.log(`  ${c.green}✓ Ready${c.reset}  ${c.dim}(${bunMem} MB RSS)${c.reset}`);

  const bunResults = {};
  for (const ep of endpoints) {
    process.stdout.write(`  ${c.dim}Benchmarking ${ep}...${c.reset}`);
    bunResults[ep] = await benchEndpoint("bun", BUN_PORT, ep, RUNS, WARMUP);
    console.log(` ${c.green}done${c.reset}`);
  }
  kill(bunChild);

  // ── Results ──────────────────────────────────────────────────────────────

  const maxMedian = Math.max(...endpoints.map((ep) => Math.max(nodeResults[ep]?.median ?? 0, bunResults[ep]?.median ?? 0)));

  console.log();
  console.log(`${c.bold}  ╔══════════════════════════════════════════════════════════════════════╗${c.reset}`);
  console.log(`${c.bold}  ║                            RESULTS                                  ║${c.reset}`);
  console.log(`${c.bold}  ╚══════════════════════════════════════════════════════════════════════╝${c.reset}`);

  // Summary box
  console.log();
  console.log(`  ${c.bold}Memory Usage${c.reset}`);
  console.log(`    Node.js  ${c.blue}${bar(nodeMem, Math.max(nodeMem, bunMem) * 1.1)}${c.reset}  ${c.bold}${nodeMem} MB${c.reset}`);
  console.log(`    Bun      ${c.yellow}${bar(bunMem, Math.max(nodeMem, bunMem) * 1.1)}${c.reset}  ${c.bold}${bunMem} MB${c.reset}  ${pct(bunMem, nodeMem)}`);
  console.log();

  // Per-endpoint table
  console.log(`  ${c.bold}API Response Latency${c.reset}  ${c.dim}(median ± stddev, ${RUNS} runs)${c.reset}`);
  console.log();
  console.log(`    ${c.dim}${"Endpoint".padEnd(28)} ${"Node.js".padEnd(22)} ${"Bun".padEnd(22)} ${"Δ".padEnd(10)}${c.reset}`);
  console.log(`    ${c.dim}${"─".repeat(82)}${c.reset}`);

  for (const ep of endpoints) {
    const n = nodeResults[ep];
    const b = bunResults[ep];
    if (!n || !b) continue;

    const nStr = `${fmt(n.median)} ${c.dim}${fmtStd(n.stddev)}${c.reset}`;
    const bStr = `${fmt(b.median)} ${c.dim}${fmtStd(b.stddev)}${c.reset}`;
    const diff = ((n.median - b.median) / n.median) * 100;
    const dStr =
      diff > 0
        ? `${c.green}Bun ${Math.abs(diff).toFixed(0)}% faster${c.reset}`
        : diff < 0
          ? `${c.red}Node ${Math.abs(diff).toFixed(0)}% faster${c.reset}`
          : `${c.dim}tie${c.reset}`;

    console.log(`    ${ep.padEnd(28)} ${nStr.padEnd(42)} ${bStr.padEnd(42)} ${dStr}`);
  }

  console.log(`    ${c.dim}${"─".repeat(82)}${c.reset}`);

  // Verdict
  console.log();
  const fasterStartup = nodeResults[endpoints[0]]?.median > bunResults[endpoints[0]]?.median;
  const lessMem = nodeMem > bunMem;
  const fasterApi = Object.keys(nodeResults).every((ep) => (bunResults[ep]?.median ?? Infinity) <= (nodeResults[ep]?.median ?? 0) * 1.05);

  if (fasterStartup && lessMem && fasterApi) {
    console.log(`  ${c.bold}${c.green}✓ Bun wins across the board: faster startup, less memory, lower latency.${c.reset}`);
  } else if (fasterStartup && lessMem) {
    console.log(`  ${c.bold}${c.yellow}⚡ Bun: faster startup and less memory. Latency is comparable.${c.reset}`);
  } else {
    console.log(`  ${c.bold}${c.cyan}📊 Mixed results — see detailed numbers above.${c.reset}`);
  }

  console.log(`  ${c.dim}Run with --runs 50 for higher confidence.${c.reset}`);
  console.log();
}

main().catch(console.error);
