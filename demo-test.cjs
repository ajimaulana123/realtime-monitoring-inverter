#!/usr/bin/env node
"use strict";

// ============================================================
// DEMO — TEST ENDPOINT GROWATT (api-plts-inverter.pdf / .txt)
// ============================================================
//
// Server demo TERPISAH dari server.cjs (produksi):
//
//   - Base URL : http://test.growatt.com/v1        (environment test)
//   - Token    : 6eb6f069523055a339d71e5b1f6c88cc  (test token, dari PDF)
//   - SN demo  : dari /plant/list + /device/list test env
//
// Endpoint yang dipakai (persis seperti di api-plts-inverter.txt):
//   1. GET /plant/list                          → temukan plant demo
//   2. GET /device/list?plant_id=...            → temukan SN inverter demo
//   3. GET /device/inverter/last_new_data       → data realtime (per SN)
//   4. POST /device/inverter/invs_data          → batch (dipakai jika ada
//      banyak SN demo; pola dari PDF, fallback ke per-device bila gagal)
//
// Kalau test environment Growatt tidak merespons / menolak (10012, dsb.),
// demo TIDAK mati: otomatis fallback ke simulator lokal per device
// (ditandai "simulated: true" di snapshot & label di dashboard).
//
// Pemakaian:
//   node demo-test.cjs                → port 8899
//   node demo-test.cjs --port=9000
//   node demo-test.cjs --force-sim    → paksa simulator tanpa sentuh API
//
// Dashboard: http://localhost:8899  (terpisah dari :8787 milik server.cjs)
// ============================================================

const http = require("http");
const path = require("path");
const fs = require("fs");

// ------------------------------------------------------------
// KONFIGURASI DEMO — hardcode sesuai PDF, TIDAK membaca config.json
// ------------------------------------------------------------

const TEST_BASE_URL = "http://test.growatt.com/v1";
const TEST_TOKEN = "6eb6f069523055a339d71e5b1f6c88cc"; // test token (PDF)

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const i = a.indexOf("=");

      return i === -1 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)];
    })
);

const PORT = Number(args.port) || 8899;

const FORCE_SIM = !!args["force-sim"];

// Timeout request ke test env — test.growatt.com terkenal lambat/diam.

const API_TIMEOUT_MS = 20000;

// Jeda minimal antar-request ke API (jaga-jaga rate limit test env).

const MIN_API_GAP_MS = 3000;

let lastApiCallAtMs = 0;

// ------------------------------------------------------------
// STATE DEMO
// ------------------------------------------------------------

const HISTORY_MAX = 720;

const state = {
  mode: FORCE_SIM ? "demo-sim" : "demo-test",
  dataSource: FORCE_SIM ? "simulator" : "growatt-test-env",
  pollCount: 0,
  lastPollAtMs: 0,
  lastPollOk: false,
  lastError: null,
  devices: new Map(), // sn -> { data, history: [{t, pac, ppv}] }
};

function ensureDevice(sn) {
  if (!state.devices.has(sn)) {
    state.devices.set(sn, { data: null, history: [] });
  }

  return state.devices.get(sn);
}

// ------------------------------------------------------------
// HTTP helper — timeout SELURUH request (header + body)
// ------------------------------------------------------------

async function apiGet(pathname, params) {
  const qs = new URLSearchParams(params || {}).toString();

  const url = TEST_BASE_URL + pathname + (qs ? "?" + qs : "");

  // Jeda antar-request (seriap kalau perlu, jangan menabrak 10012).

  const gap = Date.now() - lastApiCallAtMs;

  if (lastApiCallAtMs && gap < MIN_API_GAP_MS) {
    await new Promise((r) => setTimeout(r, MIN_API_GAP_MS - gap));
  }

  lastApiCallAtMs = Date.now();

  const work = (async () => {
    const res = await fetch(url, {
      method: "GET",
      headers: { token: TEST_TOKEN, Accept: "application/json" },
    });

    // Bisa jadi test env mengembalikan HTML/empty (layanan lama) —
    // normalisasi supaya body selalu objek, dan catat preview-nya.

    const raw = await res.text().catch(() => "");

    let body;

    try {
      body = JSON.parse(raw);
    } catch {
      body = { error_code: -1, error_msg: "respons bukan JSON", _raw: raw.slice(0, 120) };
    }

    if (body == null || typeof body !== "object") {
      body = { error_code: -1, error_msg: "respons kosong/tak dikenal", _raw: String(raw).slice(0, 120) };
    }

    return { httpStatus: res.status, body };
  })(); // PENTING: IIFE harus dipanggil! (dulu kurang "()" → apiGet
        // mengembalikan FUNGSI, bukan hasil request)

  const hasil = await Promise.race([
    work,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("Timeout " + API_TIMEOUT_MS + "ms: " + pathname)),
        API_TIMEOUT_MS
      )
    ),
  ]);

  return hasil;
}

// ------------------------------------------------------------
// DISCOVERY — plant/list + device/list → SN inverter demo
// ------------------------------------------------------------

async function discoverDemoDevices() {
  const sns = [];

  // 1) plant/list

  const plantRes = await apiGet("/plant/list", { page: 1, perpage: 10 });

  if (Number(plantRes.body.error_code) !== 0) {
    throw new Error(
      "plant/list error_code " + plantRes.body.error_code + ": " +
        (plantRes.body.error_msg || "?")
    );
  }

  const plants = (plantRes.body.data && plantRes.body.data.plants) || [];

  if (plants.length === 0) {
    throw new Error("plant/list sukses tapi 0 plant (test env flaky/kosong)");
  }

  // 2) device/list per plant (maks 2 plant biar hemat kuota)

  for (const plant of plants.slice(0, 2)) {
    const devRes = await apiGet("/device/list", {
      plant_id: plant.plant_id,
      page: 1,
      perpage: 50,
    });

    if (Number(devRes.body.error_code) !== 0) continue;

    const devices = (devRes.body.data && devRes.body.data.devices) || [];

    for (const d of devices) {
      // type 1 = inverter (dari PDF); satu SN cukup untuk demo.

      if (Number(d.type) === 1 && d.device_sn) {
        sns.push(String(d.device_sn));
      }
    }

    if (sns.length >= 3) break;
  }

  return sns;
}

// ------------------------------------------------------------
// SIMULATOR (fallback) — sama polanya dengan server.cjs
// ------------------------------------------------------------

function round1(v) { return Math.round(v * 10) / 10; }
function round2(v) { return Math.round(v * 100) / 100; }

function formatLocal(d) {
  const p = (n) => String(n).padStart(2, "0");

  return (
    d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
    " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds())
  );
}

function simulateDevice(sn, nowMs) {
  const VIRTUAL_DAY_MS = 12 * 60 * 1000;

  const phase = (nowMs % VIRTUAL_DAY_MS) / VIRTUAL_DAY_MS;

  const hour = 6 + phase * 12;

  const t = (hour - 6) / 12;

  const bell = Math.sin(Math.PI * t);

  const noise = 0.92 + Math.random() * 0.16;

  const ratedW = 3000;

  const ppv = Math.max(0, bell * ratedW * noise);

  const pac = ppv * (0.94 + Math.random() * 0.05);

  const fault = Math.random() < 0.025;

  const sunUp = bell > 0.02;

  const vacr = sunUp ? 228 + Math.random() * 6 : 0;

  return {
    device_sn: sn,
    dataloggerSn: "DEMO-DL-" + String(sn).slice(-4),

    data: {
      status: fault ? 3 : sunUp ? 1 : 0,
      statusText: fault ? "Fault" : sunUp ? "Normal" : "Standby",

      ppv: round1(ppv),
      pac: round1(pac),
      fac: round2(49.9 + Math.random() * 0.2),
      vacr: round1(vacr),
      iacr: pac > 0 ? round2(pac / Math.max(vacr, 1)) : 0,
      vpv1: sunUp ? round1(200 + bell * 90 + Math.random() * 10) : 0,
      vpv2: sunUp ? round1(190 + bell * 85 + Math.random() * 10) : 0,
      ipv1: ppv > 0 ? round2((ppv / 2) / Math.max(200 + bell * 90, 1)) : 0,
      ipv2: ppv > 0 ? round2((ppv / 2) / Math.max(190 + bell * 85, 1)) : 0,
      temperature: round1(28 + bell * 24 + Math.random() * 3),
      powerToday: round1((ppv * (hour - 6)) / 12 / 2),
      powerTotal: round1(15234.5 + ppv / 5000),
      warnCode: 0,
      time: formatLocal(new Date(nowMs)),
    },
  };
}

// ------------------------------------------------------------
// FETCH DATA per SN (test env, fallback simulator per device)
// ------------------------------------------------------------

async function fetchLastData(sn) {
  const res = await apiGet("/device/inverter/last_new_data", {
    device_sn: sn,
  });

  // DEFENSIVE: body dijamin objek apa pun yang terjadi.

  const body = (res && res.body && typeof res.body === "object")
    ? res.body
    : { error_code: -1, error_msg: "apiGet mengembalikan struktur tak dikenal: " + JSON.stringify(res) };

  if (Number(body.error_code) !== 0) {
    throw new Error(
      "error_code " + body.error_code + ": " + (body.error_msg || "?")
    );
  }

  return {
    device_sn: res.body.device_sn || sn,
    dataloggerSn: res.body.dataloggerSn || "",
    data: res.body.data || {},
    simulated: false,
  };
}

// Setelah test env gagal total berkali-kali, demo berhenti menembak API
// dan lanjut full-simulator (stabil untuk presentasi).

let useTestApi = !FORCE_SIM;

let allSimStreak = 0;

const ALL_SIM_GIVE_UP = 8;

async function fetchLastDataWithFallback(sn, nowMs) {
  if (!useTestApi) {
    const sim = simulateDevice(sn, nowMs);

    sim.simulated = true;

    sim.fallbackReason = "full-simulator (test env tidak merespons)";

    return sim;
  }

  try {
    return await fetchLastData(sn);
  } catch (e) {
    const sim = simulateDevice(sn, nowMs);

    // PENTING: tandai sebagai simulasi — jangan sampai data palsu
    // dianggap data API asli di snapshot/dashboard.

    sim.simulated = true;

    sim.fallbackReason = String(e.message || e);

    return sim;
  }
}

// ------------------------------------------------------------
// POLL CYCLE
// ------------------------------------------------------------

const POLL_MS = 15000; // demo: 15 dtk (test env lebih toleran daripada produksi)

async function pollCycle() {
  state.pollCount++;
  state.lastPollAtMs = Date.now();

  const sns = Array.from(state.devices.keys());

  // Berurutan (bukan paralel) — test env sensitif rate limit.

  for (const sn of sns) {
    const entry = ensureDevice(sn);

    const result = await fetchLastDataWithFallback(sn, Date.now());

    entry.data = result;

    const pac = Number(
      result.data.pac != null ? result.data.pac : result.data.power
    ) || 0;

    const ppv = Number(result.data.ppv) || 0;

    entry.history.push({ t: Date.now(), pac, ppv });

    if (entry.history.length > HISTORY_MAX) entry.history.shift();

    if (result.simulated && useTestApi) {
      console.log(
        "⚠️ [" + sn + "] API gagal (" + result.fallbackReason + ") → data simulasi"
      );
    }
  }

  const simCount = sns.filter(
    (sn) => state.devices.get(sn).data && state.devices.get(sn).data.simulated
  ).length;

  if (sns.length > 0 && simCount === sns.length) {
    allSimStreak++;
  } else {
    allSimStreak = 0;
  }

  if (useTestApi && allSimStreak >= ALL_SIM_GIVE_UP) {
    useTestApi = false;

    state.mode = "demo-sim";

    state.dataSource = "simulator";

    state.lastError = null;

    console.log(
      "🎬 Test env gagal " + allSimStreak + "x berturut-turut → " +
        "demo lanjut FULL-SIMULATOR."
    );
  }

  if (!useTestApi) {
    // Full-simulator adalah perilaku normal demo, bukan error.

    state.lastPollOk = true;

    state.lastError = null;
  } else {
    state.lastPollOk = simCount === 0;

    state.lastError = state.lastPollOk
      ? null
      : "fallback simulator aktif untuk " + simCount + "/" + sns.length +
        " device (API test env gagal)";
  }

  broadcast();
}

// ------------------------------------------------------------
// SSE + SNAPSHOT (pola sama dengan server.cjs)
// ------------------------------------------------------------

const sseClients = new Set();

function broadcast() {
  if (sseClients.size === 0) return;

  const chunk = "data: " + JSON.stringify(buildSnapshot()) + "\n\n";

  for (const res of sseClients) {
    try {
      res.write(chunk);
    } catch {
      sseClients.delete(res);
    }
  }
}

function num(v) {
  const n = Number(v);

  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function buildSnapshot() {
  const devices = [];

  for (const [sn, entry] of state.devices) {
    const d = entry.data ? entry.data.data : null;

    devices.push({
      sn,
      dataloggerSn: entry.data ? entry.data.dataloggerSn : "",
      simulated: entry.data ? !!entry.data.simulated : null,
      online: !!(d && Date.now() - state.lastPollAtMs < POLL_MS * 4),
      status: d ? d.status : -1,
      statusText: d ? d.statusText || "—" : "MENUNGGU DATA",
      pac: num(d && d.pac),
      ppv: num(d && d.ppv),
      powerToday: num(d && (d.powerToday != null ? d.powerToday : d.epv1Today)),
      powerTotal: num(d && (d.powerTotal != null ? d.powerTotal : d.epv1Total)),
      vacr: num(d && d.vacr),
      iacr: num(d && d.iacr),
      vpv1: num(d && d.vpv1),
      vpv2: num(d && d.vpv2),
      ipv1: num(d && d.ipv1),
      ipv2: num(d && d.ipv2),
      fac: num(d && d.fac),
      temperature: num(d && d.temperature),
      time: d ? d.time || "" : "",
      history: entry.history.slice(-180),
    });
  }

  const totalPac = devices.reduce((s, d) => s + (d.pac || 0), 0);

  return {
    mode: state.mode,
    pollCount: state.pollCount,
    lastPollAtMs: state.lastPollAtMs,
    lastPollOk: state.lastPollOk,
    lastError: state.lastError,
    serverTime: Date.now(),
    dataSource: state.dataSource,
    totalPac: Math.round(totalPac * 10) / 10,
    devices,
  };
}

// ------------------------------------------------------------
// HTTP SERVER — static + API (dashboard dipinjam dari /public)
// ------------------------------------------------------------

const PUBLIC_DIR = path.join(__dirname, "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

function sendJson(res, code, obj) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });

  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/api/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    res.write("data: " + JSON.stringify(buildSnapshot()) + "\n\n");

    sseClients.add(res);

    const ping = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        // noop — cleanup di close
      }
    }, 15000);

    req.on("close", () => {
      clearInterval(ping);

      sseClients.delete(res);
    });

    return;
  }

  if (url.pathname === "/api/snapshot") {
    sendJson(res, 200, buildSnapshot());

    return;
  }

  let filePath = url.pathname === "/"
    ? "/index.html"
    : decodeURIComponent(url.pathname);

  filePath = path.normalize(path.join(PUBLIC_DIR, filePath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);

    res.end("Forbidden");

    return;
  }

  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });

      res.end("404 Not Found");

      return;
    }

    const ext = path.extname(filePath).toLowerCase();

    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-store",
    });

    res.end(buf);
  });
});

// ------------------------------------------------------------
// START — discovery SN demo, lalu poll
// ------------------------------------------------------------

server.listen(PORT, () => {
  console.log("");
  console.log("======================================");
  console.log("🧪 DEMO — GROWATT TEST ENVIRONMENT");
  console.log("======================================");
  console.log("🌐 Dashboard : http://localhost:" + PORT);
  console.log("📡 Mode      : " + state.mode);
  console.log("🔗 Base URL  : " + TEST_BASE_URL);
  console.log("⏱️  Poll      : " + POLL_MS + " ms");
  console.log("======================================");
  console.log("");
});

// Jangan jadi zombie: kalau port dipakai proses lain, keluar jelas.

server.on("error", (e) => {
  console.error("❌ Gagal bind port " + PORT + ": " + e.message);

  process.exit(1);
});

async function startDemo() {
  if (FORCE_SIM) {
    console.log("🎬 --force-sim: memakai simulator lokal (tanpa API).");

    ["DEMOINV001", "DEMOINV002"].forEach(ensureDevice);

    setInterval(() => {
      pollCycle().catch((e) => {
        state.lastError = String(e.message || e);
      });
    }, POLL_MS);

    pollCycle().catch(() => {});

    return;
  }

  console.log("🔎 Discovery: /plant/list + /device/list di test env …");

  const DISCOVERY_TRIES = 3;

  let sns = [];

  for (let attempt = 1; attempt <= DISCOVERY_TRIES; attempt++) {
    try {
      sns = await discoverDemoDevices();

      if (sns.length > 0) break;

      throw new Error("tidak ada inverter (type=1) di test env");
    } catch (e) {
      console.log(
        "⚠️ Discovery percobaan " + attempt + "/" + DISCOVERY_TRIES +
          " gagal: " + (e.message || e)
      );

      if (attempt < DISCOVERY_TRIES) {
        await new Promise((r) => setTimeout(r, 20000));
      }
    }
  }

  try {
    if (sns.length === 0) throw new Error("gagal setelah " + DISCOVERY_TRIES + " percobaan");

    sns.forEach(ensureDevice);

    console.log("✅ SN inverter demo: " + sns.join(", "));
  } catch (e) {
    console.log(
      "⚠️ Discovery gagal (" + (e.message || e) + ") → fallback SN demo dummy."
    );

    // SN dummy: request last_new_data akan gagal → simulator per device jalan.

    ["DEMODUMMY01", "DEMODUMMY02"].forEach(ensureDevice);
  }

  setInterval(() => {
    pollCycle().catch((e) => {
      state.lastError = String(e.message || e);

      console.error("❌ Poll demo gagal:", state.lastError);
    });
  }, POLL_MS);

  pollCycle().catch(() => {});
}

startDemo();

// Penjaga proses (sama seperti server.cjs).

process.on("uncaughtException", (e) => {
  console.error("⚠️ uncaughtException (ditahan):", e.message);
});

process.on("unhandledRejection", (e) => {
  console.error("⚠️ unhandledRejection (ditahan):", e);
});
