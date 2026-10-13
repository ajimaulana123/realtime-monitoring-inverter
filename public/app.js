"use strict";

// ============================================================
// DASHBOARD CLIENT — konsumsi SSE /api/stream
// ============================================================
// - Kartu inverter dibuat sekali per SN, lalu di-update
//   (tanpa re-render DOM penuh — hemat & tidak flicker).
// - Kurva digambar manual di canvas (tanpa library).
// - Kalau SSE putus: reconnect otomatis + fallback ke
//   polling /api/snapshot.
// ============================================================

const $ = (id) => document.getElementById(id);

const els = {
  clock: $("clock"),
  led: $("led"),
  feedText: $("feed-text"),
  modeLabel: $("mode-label"),
  totalPac: $("total-pac"),
  totalPacUnit: $("total-pac-unit"),
  totalPacMax: $("total-pac-max"),
  totalToday: $("total-today"),
  pollCount: $("poll-count"),
  capacityMeter: $("capacity-meter"),
  capacityText: $("capacity-text"),
  heroNote: $("hero-note"),
  rack: $("rack"),
  chart: $("power-chart"),
  sbMode: $("sb-mode"),
  sbPoll: $("sb-poll"),
  sbError: $("sb-error"),
  sbClients: $("sb-clients"),
};

// ------------------------------------------------------------
// STATE CLIENT
// ------------------------------------------------------------

// Kapasitas terpasang total (W) — untuk meter beban.
// Sesuaikan dengan kapasitas PLTS nyata di lapangan.
// (Mode simulasi: 5 inverter x 3.000 W = 15 kW)

const INSTALLED_CAPACITY_W = 15000;

const cards = new Map(); // sn -> { root, refs }

let peakPac = 0;

let lastServerTime = 0;

// ------------------------------------------------------------
// FORMAT HELPER
// ------------------------------------------------------------

function fmtW(w) {
  if (w == null) return "—";

  // Watt penuh — untuk kartu & teks kecil.

  return Math.round(w).toLocaleString("id-ID");
}

// Angka besar hero: otomatis pilih skala + satuan.

function fmtBigW(w) {
  if (w == null) return { value: "—", unit: "W" };

  if (w >= 1000000) {
    return { value: (w / 1000000).toFixed(2), unit: "MW" };
  }

  if (w >= 10000) {
    return { value: (w / 1000).toFixed(2), unit: "kW" };
  }

  return { value: Math.round(w).toLocaleString("id-ID"), unit: "W" };
}

function fmtKwh(v) {
  if (v == null) return "—";

  return Number(v).toFixed(1) + " kWh";
}

function fmtVal(v, unit) {
  if (v == null) return "—";

  const n = Number(v);

  return (Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(1)) + (unit ? " " + unit : "");
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ------------------------------------------------------------
// JAM LOKAL
// ------------------------------------------------------------

function tickClock() {
  const d = new Date();

  const p = (n) => String(n).padStart(2, "0");

  els.clock.textContent =
    p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

setInterval(tickClock, 1000);

tickClock();

// ------------------------------------------------------------
// KARTU INVERTER — create once, update in place
// ------------------------------------------------------------

function statusClass(statusText) {
  const t = String(statusText || "").toLowerCase();

  if (t.includes("normal")) return "st-normal";
  if (t.includes("fault") || t.includes("error")) return "st-fault";
  if (t.includes("standby") || t.includes("lost")) return "st-standby";

  return "st-wait";
}

function buildCard(dev) {
  const root = document.createElement("article");

  root.className = "inv-card st-wait";

  root.innerHTML = `
    <div class="inv-head">
      <span class="inv-sn">${esc(dev.sn)}</span>
      <span class="inv-status"><span class="dot"></span><span class="st-text">MENUNGGU</span></span>
    </div>

    <div class="inv-pac">
      <span class="val">0</span>
      <span class="unit">W · PAC</span>
    </div>

    <div class="inv-rows">
      <div class="inv-row"><span class="k">PPV (DC)</span><span class="v" data-k="ppv">—</span></div>
      <div class="inv-row"><span class="k">VAC / IAC</span><span class="v" data-k="vaci">—</span></div>
      <div class="inv-row"><span class="k">VPV1 / VPV2</span><span class="v" data-k="vpv">—</span></div>
      <div class="inv-row"><span class="k">IPV1 / IPV2</span><span class="v" data-k="ipv">—</span></div>
      <div class="inv-row"><span class="k">FREKUENSI</span><span class="v" data-k="fac">—</span></div>
      <div class="inv-row"><span class="k">SUHU</span><span class="v" data-k="temp">—</span></div>
    </div>

    <div class="inv-spark"><canvas></canvas></div>

    <div class="inv-foot">
      <span class="foot-dl">DL —</span>
      <span class="foot-time">—</span>
    </div>
  `;

  const canvas = root.querySelector("canvas");

  const refs = {
    root,
    stText: root.querySelector(".st-text"),
    pacVal: root.querySelector(".inv-pac .val"),
    ppv: root.querySelector('[data-k="ppv"]'),
    vaci: root.querySelector('[data-k="vaci"]'),
    vpv: root.querySelector('[data-k="vpv"]'),
    ipv: root.querySelector('[data-k="ipv"]'),
    fac: root.querySelector('[data-k="fac"]'),
    temp: root.querySelector('[data-k="temp"]'),
    dl: root.querySelector(".foot-dl"),
    time: root.querySelector(".foot-time"),
    canvas,
    ctx: canvas.getContext("2d"),
  };

  els.rack.appendChild(root);

  return refs;
}

function updateCard(dev) {
  let refs = cards.get(dev.sn);

  if (!refs) {
    refs = buildCard(dev);

    cards.set(dev.sn, refs);
  }

  const cls = statusClass(dev.statusText) + (dev.online ? "" : " st-wait");

  refs.root.className = "inv-card " + cls;

  refs.stText.textContent = dev.online
    ? String(dev.statusText || "—").toUpperCase()
    : "OFFLINE";

  refs.pacVal.textContent = fmtW(dev.pac);

  refs.ppv.textContent = fmtVal(dev.ppv, "W");

  refs.vaci.textContent =
    dev.vacr != null ? fmtVal(dev.vacr, "V") + " / " + fmtVal(dev.iacr, "A") : "—";

  refs.vpv.textContent =
    dev.vpv1 != null ? fmtVal(dev.vpv1, "V") + " / " + fmtVal(dev.vpv2, "V") : "—";

  refs.ipv.textContent =
    dev.ipv1 != null ? fmtVal(dev.ipv1, "A") + " / " + fmtVal(dev.ipv2, "A") : "—";

  refs.fac.textContent = fmtVal(dev.fac, "Hz");

  refs.temp.textContent = fmtVal(dev.temperature, "°C");

  refs.dl.textContent = "DL " + (dev.dataloggerSn || "—");

  refs.time.textContent = dev.time || "—";

  drawSpark(refs, dev.history || []);
}

// ------------------------------------------------------------
// SPARKLINE per kartu
// ------------------------------------------------------------

function drawSpark(refs, history) {
  const { canvas, ctx } = refs;

  const rect = canvas.getBoundingClientRect();

  const w = Math.max(rect.width, 10);

  const h = Math.max(rect.height, 10);

  const dpr = window.devicePixelRatio || 1;

  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.clearRect(0, 0, w, h);

  if (!history || history.length < 2) return;

  const pts = history.slice(-90);

  const max = Math.max(...pts.map((p) => p.pac || 0), 100);

  const isFault = refs.root.classList.contains("st-fault");

  ctx.beginPath();

  for (let i = 0; i < pts.length; i++) {
    const x = (i / (pts.length - 1)) * w;

    const y = h - ((pts[i].pac || 0) / max) * (h - 4) - 2;

    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }

  ctx.strokeStyle = isFault ? "#ff4d4d" : "#38e07b";

  ctx.lineWidth = 1.6;

  ctx.stroke();

  // area fill halus

  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();

  ctx.fillStyle = isFault
    ? "rgba(255,77,77,0.08)"
    : "rgba(56,224,123,0.08)";

  ctx.fill();
}

// ------------------------------------------------------------
// KURVA UTAMA (canvas)
// ------------------------------------------------------------

function drawMainChart(devices) {
  const canvas = els.chart;

  if (!canvas) return;

  const rect = canvas.getBoundingClientRect();

  const w = Math.max(rect.width, 10);

  const h = Math.max(rect.height, 10);

  const dpr = window.devicePixelRatio || 1;

  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }

  const ctx = canvas.getContext("2d");

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.clearRect(0, 0, w, h);

  // grid

  ctx.strokeStyle = "rgba(255,255,255,0.05)";

  ctx.lineWidth = 1;

  for (let gy = 0; gy <= 4; gy++) {
    const y = (gy / 4) * h;

    ctx.beginPath();

    ctx.moveTo(0, y);

    ctx.lineTo(w, y);

    ctx.stroke();
  }

  // Gabungkan history semua device per waktu → total PAC & PPV.

  const series = [];

  const maps = devices.map((d) => ({
    hist: d.history || [],
  }));

  const maxLen = Math.max(1, ...maps.map((m) => m.hist.length));

  if (maxLen < 2) {
    ctx.fillStyle = "rgba(125,138,151,0.6)";

    ctx.font = "12px 'IBM Plex Mono', monospace";

    ctx.fillText("menunggu data kurva…", 12, h / 2);

    return;
  }

  // pakai history terpanjang sebagai acuan sumbu waktu

  const base = maps.reduce((a, b) => (b.hist.length > a.hist.length ? b : a)).hist;

  for (let i = 0; i < base.length; i++) {
    const t = base[i].t;

    let pac = 0;

    let ppv = 0;

    for (const m of maps) {
      const p = m.hist.find((q) => Math.abs(q.t - t) < 4000);

      if (p) {
        pac += p.pac || 0;

        ppv += p.ppv || 0;
      }
    }

    series.push({ t, pac, ppv });
  }

  const max = Math.max(
    ...series.map((s) => Math.max(s.pac, s.ppv)),
    500
  );

  const t0 = series[0].t;

  const t1 = series[series.length - 1].t || t0 + 1;

  const X = (t) => ((t - t0) / Math.max(t1 - t0, 1)) * (w - 8) + 4;

  const Y = (v) => h - (v / max) * (h - 14) - 6;

  // label max

  ctx.fillStyle = "rgba(125,138,151,0.7)";

  ctx.font = "10px 'IBM Plex Mono', monospace";

  ctx.fillText(Math.round(max) + " W", 6, 12);

  // ---- garis PPV (amber, di belakang) ----

  ctx.beginPath();

  series.forEach((s, i) => {
    const x = X(s.t);

    const y = Y(s.ppv);

    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });

  ctx.strokeStyle = "#ffb020";

  ctx.lineWidth = 1.4;

  ctx.setLineDash([4, 3]);

  ctx.stroke();

  ctx.setLineDash([]);

  // ---- garis PAC (hijau) + area ----

  ctx.beginPath();

  series.forEach((s, i) => {
    const x = X(s.t);

    const y = Y(s.pac);

    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });

  ctx.strokeStyle = "#38e07b";

  ctx.lineWidth = 2;

  ctx.stroke();

  ctx.lineTo(X(t1), h);

  ctx.lineTo(X(t0), h);

  ctx.closePath();

  const grad = ctx.createLinearGradient(0, 0, 0, h);

  grad.addColorStop(0, "rgba(56,224,123,0.18)");

  grad.addColorStop(1, "rgba(56,224,123,0)");

  ctx.fillStyle = grad;

  ctx.fill();

  // titik terakhir PAC

  const last = series[series.length - 1];

  ctx.beginPath();

  ctx.arc(X(last.t), Y(last.pac), 3.2, 0, Math.PI * 2);

  ctx.fillStyle = "#38e07b";

  ctx.fill();
}

// ------------------------------------------------------------
// APPLY SNAPSHOT
// ------------------------------------------------------------

function applySnapshot(snap) {
  lastServerTime = snap.serverTime;

  setFeed(true, "LIVE · " + snap.mode.toUpperCase());

  els.modeLabel.textContent =
    snap.mode === "growatt" ? "MODE GROWATT API" : "MODE SIMULASI";

  els.sbMode.textContent = "MODE " + snap.mode.toUpperCase();

  els.sbPoll.textContent =
    "POLL #" + snap.pollCount + " · " + new Date(snap.lastPollAtMs).toLocaleTimeString();

  els.sbError.textContent = snap.lastError ? "ERR: " + snap.lastError : "";

  els.pollCount.textContent = "#" + snap.pollCount;

  // ---- total ----

  const total = snap.totalPac || 0;

  const big = fmtBigW(total);

  peakPac = Math.max(peakPac, total);

  els.totalPac.textContent = big.value;

  els.totalPacUnit.textContent = big.unit;

  els.totalPac.classList.toggle("night", total < 5);

  els.totalPacMax.textContent = Math.round(peakPac) + " W";

  const totalToday = snap.devices.reduce(
    (s, d) => s + (d.powerToday || 0),
    0
  );

  els.totalToday.textContent = fmtKwh(totalToday);

  // ---- meter kapasitas ----

  const pct = Math.min(100, (total / INSTALLED_CAPACITY_W) * 100);

  els.capacityMeter.style.width = pct.toFixed(1) + "%";

  els.capacityText.textContent = pct.toFixed(0) + "% dari " + (INSTALLED_CAPACITY_W / 1000) + " kW";

  // ---- catatan hero ----

  if (snap.lastError) {
    els.heroNote.textContent = "⚠️ " + snap.lastError;
  } else if (total < 5) {
    els.heroNote.textContent =
      "Output nol — inverter standby (malam hari / belum ada data telemetry).";
  } else {
    els.heroNote.textContent =
      "Sistem memproduksi " + Math.round(total) + " W dari " +
      snap.devices.filter((d) => d.online).length + " inverter online.";
  }

  // ---- kartu & kurva ----

  for (const dev of snap.devices) {
    updateCard(dev);
  }

  drawMainChart(snap.devices);
}

// ------------------------------------------------------------
// SSE + FALLBACK
// ------------------------------------------------------------

let sse = null;

let fallbackTimer = null;

function setFeed(ok, text) {
  els.led.className = "led " + (ok ? "ok" : "err");

  els.feedText.textContent = text;
}

function startFallbackPolling() {
  if (fallbackTimer) return;

  fallbackTimer = setInterval(async () => {
    try {
      const res = await fetch("/api/snapshot");

      const snap = await res.json();

      applySnapshot(snap);
    } catch {
      setFeed(false, "KONEKSI TERPUTUS");
    }
  }, 3000);
}

function stopFallbackPolling() {
  if (fallbackTimer) {
    clearInterval(fallbackTimer);

    fallbackTimer = null;
  }
}

function connectSSE() {
  try {
    sse = new EventSource("/api/stream");
  } catch {
    startFallbackPolling();

    return;
  }

  sse.onopen = () => {
    stopFallbackPolling();

    setFeed(true, "LIVE");
  };

  sse.onmessage = (ev) => {
    try {
      const snap = JSON.parse(ev.data);

      applySnapshot(snap);
    } catch {
      // payload rusak — abaikan, tunggu snapshot berikutnya
    }
  };

  sse.onerror = () => {
    setFeed(false, "RECONNECT…");

    sse.close();

    startFallbackPolling();

    setTimeout(connectSSE, 4000);
  };
}

connectSSE();

// ------------------------------------------------------------
// REDRAW saat resize
// ------------------------------------------------------------

window.addEventListener("resize", () => {
  // sparkline & chart digambar ulang pada snapshot berikutnya;
  // ini trigger cepat tanpa menunggu poll.
});

// Simpan jumlah client (hanya estetika statusbar)

els.sbClients.textContent = "SSE · STREAM AKTIF";
