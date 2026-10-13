"use strict";

// ============================================================
// REALTIME INVERTER DASHBOARD — server
// ============================================================
// Zero-dependency Node.js server:
//
//   1. POLLER  — ambil data inverter dari Growatt API
//      (/device/inverter/last_new_data per device, paralel)
//      atau dari simulator (mode "simulate", tanpa token).
//   2. BROADCAST — SSE /api/stream: push snapshot tiap poll
//      ke semua browser yang terbuka.
//   3. STATIC — sajikan /public (dashboard).
//
// Konsep dari PDF Growatt:
//   - error_code 0 = sukses
//   - token dikirim via request header "token"
//   - power dalam W, energy dalam kWh, suhu °C
// ============================================================

const http = require("http");
const fs = require("fs");
const path = require("path");

// ============================================================
// CONFIG
// ============================================================

const CONFIG_PATH = path.join(__dirname, "config.json");

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");

  const base = JSON.parse(raw);

  /*
   * config.local.json (opsional, di-gitignore) menimpa
   * config.json — dipakai untuk token & SN asli supaya
   * kredensial tidak ikut ter-commit.
   */

  const localPath = path.join(__dirname, "config.local.json");

  if (fs.existsSync(localPath)) {
    const local = JSON.parse(fs.readFileSync(localPath, "utf8"));

    for (const [key, value] of Object.entries(local)) {
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        base[key] &&
        typeof base[key] === "object" &&
        !Array.isArray(base[key])
      ) {
        base[key] = { ...base[key], ...value };
      } else {
        base[key] = value;
      }
    }
  }

  return base;
}

const config = loadConfig();

const PORT = Number(config.server && config.server.port) || 8787;

const MODE =
  process.argv.includes("--live")
    ? "growatt"
    : process.argv.includes("--simulate")
      ? "simulate"
      : String(config.mode || "simulate");

const GROWATT = config.growatt || {};

const BASE_URL = String(GROWATT.baseUrl || "http://test.growatt.com/v1").replace(/\/+$/, "");

const TOKEN = String(GROWATT.token || "");

const DEVICES = Array.isArray(GROWATT.devices) && GROWATT.devices.length
  ? GROWATT.devices.map(String)
  : ["2033022963"];

const POLL_INTERVAL_MS = Number(GROWATT.pollIntervalMs) || 5000;

// Di mode growatt, interval dipaksa min. 30 dtk — API Growatt
// membalas 10012 "error_frequently_access" kalau di-poll lebih
// cepat (terbukti saat test live: poll 5 dtk langsung ditolak).

const EFFECTIVE_POLL_MS =
  MODE === "growatt" ? Math.max(POLL_INTERVAL_MS, 30000) : POLL_INTERVAL_MS;

const REQUEST_TIMEOUT_MS = Number(GROWATT.requestTimeoutMs) || 10000;

const SIM_DEVICE_COUNT = Number((config.simulate || {}).deviceCount) || 3;

// ============================================================
// STATE — snapshot terakhir + riwayat kurva per device
// ============================================================

const HISTORY_MAX = 720; // 720 titik x 5 dtk = 1 jam

const state = {
  pollCount: 0,
  lastPollAtMs: 0,
  lastPollOk: false,
  lastError: null,
  devices: new Map(), // deviceSn -> { data, history: [{t, pac, ppv}] }
};

for (const sn of DEVICES) {
  state.devices.set(sn, {
    data: null,
    history: [],
  });
}

if (MODE === "simulate") {
  // Simulator butuh daftar SN palsu yang stabil.

  for (let i = 0; i < SIM_DEVICE_COUNT; i++) {
    const sn = `SIM${String(i + 1).padStart(10, "0")}`;

    if (!state.devices.has(sn)) {
      state.devices.set(sn, { data: null, history: [] });
    }
  }
}

// ============================================================
// SIMULATOR — data realistis mengikuti siklus matahari
// ============================================================
//
// Pac mengikuti kurva lonceng antara 06:00–18:00 lokal,
// dengan noise; status Normal di siang hari, kadang Fault
// (1 dari ~40 poll) supaya LED merah bisa diuji.

function simulateDevice(sn, nowMs) {
  const now = new Date(nowMs);

  /*
   * HARI VIRTUAL (mode simulasi):
   * satu siklus matahari 06:00–18:00 diputar cepat dalam
   * 12 menit nyata — kurva selalu bergerak & dashboard
   * selalu menunjukkan produksi, apa pun jam lokal.
   * (Kalau mau ikut jam nyata, ganti virtualHour di bawah
   * dengan jam lokal biasa.)
   */

  const VIRTUAL_DAY_MS = 12 * 60 * 1000;

  const phase = (nowMs % VIRTUAL_DAY_MS) / VIRTUAL_DAY_MS;

  const hour = 6 + phase * 12; // 6.00 – 18.00 virtual

  // Kurva matahari: naik 06:00, puncak ~12:00, tenggelam 18:00.

  const t = (hour - 6) / 12; // 0..1

  const bell = Math.sin(Math.PI * t);

  const noise = 0.92 + Math.random() * 0.16;

  const ratedW = 3000;

  const ppv = Math.max(0, bell * ratedW * noise);

  const pac = ppv * (0.94 + Math.random() * 0.05); // loss konversi

  const fault = Math.random() < 0.025;

  const sunUp = bell > 0.02;

  const vacr = sunUp ? 228 + Math.random() * 6 : 0;

  return {
    device_sn: sn,
    dataloggerSn: "SIM-DL-" + sn.slice(-4),

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
      powerToday: round1((ppv * (hour - 6)) / 12 / 2), // aproksimasi kWh
      powerTotal: round1(15234.5 + ppv / 5000),
      warnCode: 0,
      time: formatLocal(now),
    },
  };
}

function round1(v) { return Math.round(v * 10) / 10; }
function round2(v) { return Math.round(v * 100) / 100; }

function formatLocal(d) {
  const p = (n) => String(n).padStart(2, "0");

  return (
    d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
    " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds())
  );
}

// ============================================================
// GROWATT CLIENT — panggil API asli
// ============================================================
//
// Pola keandalan (diwarisi project bot):
//   - Timeout SEMUA hal (Promise.race)
//   - Verifikasi error_code === 0, bukan sekadar HTTP 200
//   - Satu device gagal tidak menjatuhkan device lain

function fetchWithTimeout(url, options, timeoutMs) {
  return Promise.race([
    fetch(url, options),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("Timeout " + timeoutMs + "ms: " + url)),
        timeoutMs
      )
    ),
  ]);
}

async function fetchGrowattLastData(deviceSn) {
  const url =
    BASE_URL +
    "/device/inverter/last_new_data?device_sn=" +
    encodeURIComponent(deviceSn);

  const response = await fetchWithTimeout(
    url,
    {
      method: "GET",
      headers: {
        token: TOKEN,
        "Accept": "application/json",
      },
    },
    REQUEST_TIMEOUT_MS
  );

  if (!response.ok) {
    throw new Error("HTTP " + response.status + " dari Growatt");
  }

  const body = await response.json();

  // Verifikasi efek: error_code 0 = sukses (dari PDF).

  if (Number(body.error_code) !== 0) {
    throw new Error(
      "Growatt error_code " + body.error_code + ": " + (body.error_msg || "?")
    );
  }

  return {
    device_sn: body.device_sn || deviceSn,
    dataloggerSn: body.dataloggerSn || "",
    data: body.data || {},
  };
}

// ============================================================
// POLL CYCLE
// ============================================================

async function pollCycle() {
  state.pollCount++;
  state.lastPollAtMs = Date.now();

  const sns = Array.from(state.devices.keys());

  const results = await Promise.allSettled(
    sns.map(async (sn) => {
      if (MODE === "growatt") {
        return fetchGrowattLastData(sn);
      }

      // Hindari busy-loop synchronous — tetap async.

      await new Promise((r) => setTimeout(r, 5));

      return simulateDevice(sn, Date.now());
    })
  );

  let okCount = 0;

  for (let i = 0; i < sns.length; i++) {
    const sn = sns[i];

    const result = results[i];

    if (result.status === "fulfilled") {
      const entry = state.devices.get(sn);

      entry.data = result.value;

      const pac = Number(
        result.value.data.pac != null
          ? result.value.data.pac
          : result.value.data.power
      ) || 0;

      const ppv = Number(result.value.data.ppv) || 0;

      entry.history.push({
        t: Date.now(),
        pac,
        ppv,
      });

      if (entry.history.length > HISTORY_MAX) {
        entry.history.shift();
      }

      okCount++;
    } else {
      console.log(
        "⚠️ Poll gagal [" + sn + "]:",
        String(result.reason && result.reason.message || result.reason)
      );
    }
  }

  state.lastPollOk = okCount > 0;

  if (okCount === 0) {
    state.lastError = "semua device gagal pada poll #" + state.pollCount;
  } else {
    state.lastError = null;
  }

  if (state.pollCount % 12 === 0) {
    console.log(
      "📊 Poll #" + state.pollCount + " — " + okCount + "/" + sns.length + " device OK"
    );
  }

  broadcast();
}

// ============================================================
// SSE — broadcast snapshot ke semua browser
// ============================================================

const sseClients = new Set();

function broadcast() {
  if (sseClients.size === 0) return;

  const payload = buildSnapshot();

  const chunk = "data: " + JSON.stringify(payload) + "\n\n";

  for (const res of sseClients) {
    try {
      res.write(chunk);
    } catch {
      sseClients.delete(res);
    }
  }
}

function buildSnapshot() {
  const devices = [];

  for (const [sn, entry] of state.devices) {
    const data = entry.data ? entry.data.data : null;

    devices.push({
      sn,
      dataloggerSn: entry.data ? entry.data.dataloggerSn : "",
      online: !!(data && Date.now() - state.lastPollAtMs < EFFECTIVE_POLL_MS * 4),
      status: data ? data.status : -1,
      statusText: data ? data.statusText || "—" : "MENUNGGU DATA",
      pac: num(data && data.pac),
      ppv: num(data && data.ppv),
      powerToday: num(data && (data.powerToday != null ? data.powerToday : data.epv1Today)),
      powerTotal: num(data && (data.powerTotal != null ? data.powerTotal : data.epv1Total)),
      vacr: num(data && data.vacr),
      iacr: num(data && data.iacr),
      vpv1: num(data && data.vpv1),
      vpv2: num(data && data.vpv2),
      ipv1: num(data && data.ipv1),
      ipv2: num(data && data.ipv2),
      fac: num(data && data.fac),
      temperature: num(data && data.temperature),
      time: data ? data.time || "" : "",
      history: entry.history.slice(-180),
    });
  }

  const totalPac = devices.reduce((s, d) => s + (d.pac || 0), 0);

  return {
    mode: MODE,
    pollCount: state.pollCount,
    lastPollAtMs: state.lastPollAtMs,
    lastPollOk: state.lastPollOk,
    lastError: state.lastError,
    serverTime: Date.now(),
    totalPac: Math.round(totalPac * 10) / 10,
    devices,
  };
}

function num(v) {
  const n = Number(v);

  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

// ============================================================
// HTTP SERVER — static + API
// ============================================================

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
  const body = JSON.stringify(obj);

  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });

  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  // ---------------------------------------------
  // SSE STREAM
  // ---------------------------------------------

  if (url.pathname === "/api/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    // Snapshot pertama langsung, tanpa nunggu poll.

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

  // ---------------------------------------------
  // API SNAPSHOT (fallback polling)
  // ---------------------------------------------

  if (url.pathname === "/api/snapshot") {
    sendJson(res, 200, buildSnapshot());

    return;
  }

  // ---------------------------------------------
  // STATIC
  // ---------------------------------------------

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

// ============================================================
// START
// ============================================================

server.listen(PORT, () => {
  console.log("");
  console.log("======================================");
  console.log("⚡ REALTIME INVERTER DASHBOARD");
  console.log("======================================");
  console.log("🌐 Dashboard : http://localhost:" + PORT);
  console.log("📡 Mode      : " + MODE + (MODE === "growatt" ? "" : " (tanpa token asli)"));
  console.log("🔌 Device    : " + Array.from(state.devices.keys()).join(", "));
  console.log("⏱️ Poll      : " + EFFECTIVE_POLL_MS + " ms");
  console.log("======================================");
  console.log("");
});

// Poll pertama langsung, lalu interval.

pollCycle().catch((e) => {
  state.lastError = String(e.message || e);

  console.error("❌ Poll pertama gagal:", state.lastError);
});

setInterval(() => {
  pollCycle().catch((e) => {
    state.lastError = String(e.message || e);

    state.lastPollOk = false;

    console.error("❌ Poll gagal:", state.lastError);
  });
}, EFFECTIVE_POLL_MS);

// Penjaga proses (pola WorkReportBot): jangan mati karena error tak terduga.

process.on("uncaughtException", (e) => {
  console.error("⚠️ uncaughtException (ditahan):", e.message);
});

process.on("unhandledRejection", (e) => {
  console.error("⚠️ unhandledRejection (ditahan):", e);
});
