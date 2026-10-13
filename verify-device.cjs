#!/usr/bin/env node
"use strict";

// ============================================================
// VERIFY DEVICE — cek SN inverter yang VALID untuk token ini
// ============================================================
//
// Dipakai untuk mendiagnosis:
//   - Growatt error_code 10005 (error_inverterNotExistError)
//     → SN di config tidak dikenal server → lihat SN asli di sini.
//   - Growatt error_code 10012 (error_frequently_access)
//     → rate limit; script otomatis retry (tunggu 30 dtk, 60 dtk).
//
// Pemakaian:
//   node verify-device.cjs
//   node verify-device.cjs --plant-id=123        (langsung ke device/list)
//   node verify-device.cjs --base-url=... --token=...   (override config)
//
// Token & baseUrl diambil dari config.json (+ config.local.json),
// sama seperti server.cjs — jadi hasilnya mewakili server live.
//
// Zero-dependency, butuh Node 18+ (fetch bawaan).
// ============================================================

const fs = require("fs");
const path = require("path");

// ------------------------------------------------------------
// CONFIG — merge config.json + config.local.json (spt server.cjs)
// ------------------------------------------------------------

function loadConfig() {
  const base = JSON.parse(
    fs.readFileSync(path.join(__dirname, "config.json"), "utf8")
  );

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

// CLI override: --base-url=... --token=... --plant-id=123

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const i = a.indexOf("=");

      return i === -1
        ? [a.slice(2), true]
        : [a.slice(2, i), a.slice(i + 1)];
    })
);

const BASE_URL = String(
  args["base-url"] ||
    (config.growatt && config.growatt.baseUrl) ||
    "http://test.growatt.com/v1"
).replace(/\/+$/, "");

const TOKEN = String(args.token || (config.growatt && config.growatt.token) || "");

const CONFIG_DEVICES = Array.isArray(config.growatt && config.growatt.devices)
  ? config.growatt.devices.map(String)
  : [];

const PLANT_ID_ARG = args["plant-id"] ? String(args["plant-id"]) : null;

const TIMEOUT_MS = 30000; // Growatt kadang lambat/diam saat cooldown

// ------------------------------------------------------------
// HTTP helper — GET dengan header token + timeout
// ------------------------------------------------------------

async function apiGet(pathname, params) {
  const qs = new URLSearchParams(params || {}).toString();

  const url = BASE_URL + pathname + (qs ? "?" + qs : "");

  /*
   * Timeout melindungi SELURUH request (koneksi + header + body).
   * Kalau hanya fetch-nya, res.json() bisa menggantung selamanya
   * saat server menerima koneksi tapi tidak pernah mengirim body.
   */

  const work = (async () => {
    const res = await fetch(url, {
      method: "GET",
      headers: { token: TOKEN, Accept: "application/json" },
    });

    const body = await res.json().catch(() => ({}));

    return { httpStatus: res.status, body };
  })();

  return Promise.race([
    work,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("Timeout " + TIMEOUT_MS + "ms: " + pathname)),
        TIMEOUT_MS
      )
    ),
  ]);
}

const RETRY_DELAYS_S = [30, 60]; // tunggu sebelum retry saat 10012

async function apiGetWithRetry(pathname, params, label) {
  for (let attempt = 0; ; attempt++) {
    let httpStatus, body;

    try {
      ({ httpStatus, body } = await apiGet(pathname, params));
    } catch (e) {
      // Timeout / jaringan → perlakukan seperti 10012: tunggu lalu coba lagi.

      if (attempt < RETRY_DELAYS_S.length) {
        const wait = RETRY_DELAYS_S[attempt];

        console.log(
          "⏳ " + label + " gagal (" + e.message + ") — tunggu " +
            wait + " dtk lalu coba lagi…"
        );

        await new Promise((r) => setTimeout(r, wait * 1000));

        continue;
      }

      throw e;
    }

    // 10012 = rate limit → tunggu lalu coba lagi (cooldown ±1–2 menit).

    if (Number(body.error_code) === 10012 && attempt < RETRY_DELAYS_S.length) {
      const wait = RETRY_DELAYS_S[attempt];

      console.log(
        "⏳ " + label + " kena 10012 (rate limit) — tunggu " +
          wait + " dtk lalu coba lagi…"
      );

      await new Promise((r) => setTimeout(r, wait * 1000));

      continue;
    }

    return { httpStatus, body };
  }
}

// ------------------------------------------------------------
// Utama
// ------------------------------------------------------------

function fail(msg, hint) {
  console.error("❌ " + msg);

  if (hint) console.error("   " + hint);

  process.exit(1);
}

async function main() {
  console.log("");
  console.log("======================================");
  console.log("🔎 VERIFY DEVICE — Growatt");
  console.log("======================================");
  console.log("🌐 Base URL : " + BASE_URL);
  console.log(
    "🔑 Token    : " +
      (TOKEN ? TOKEN.slice(0, 6) + "…" + TOKEN.slice(-4) : "(kosong!)")
  );
  console.log(
    "⚙️  Config SN: " + (CONFIG_DEVICES.join(", ") || "(tidak ada)")
  );
  console.log("======================================");
  console.log("");

  if (!TOKEN) {
    fail(
      "Token kosong.",
      "Isi growatt.token di config.local.json atau pakai --token=..."
    );
  }

  // ----------------------------------------------------------
  // 1) plant/list — dapatkan semua plant milik token ini
  // ----------------------------------------------------------

  let plants = [];

  if (PLANT_ID_ARG) {
    console.log("➡️  Langsung ke device/list untuk plant_id=" + PLANT_ID_ARG + "\n");

    plants = [{ plant_id: PLANT_ID_ARG, name: "(dari --plant-id)" }];
  } else {
    console.log("📡 GET /plant/list …");

    const { httpStatus, body } = await apiGetWithRetry(
      "/plant/list",
      { page: 1, perpage: 100 },
      "plant/list"
    );

    if (Number(body.error_code) !== 0) {
      fail(
        "plant/list gagal — HTTP " + httpStatus + ", error_code " +
          body.error_code + ": " + (body.error_msg || "?"),
        Number(body.error_code) === 10012
          ? "Rate limit (10012): matikan server, tunggu 5–10 menit, coba lagi."
          : "Cek token & baseUrl — harus dari environment yang sama (test vs produksi)."
      );
    }

    plants = (body.data && body.data.plants) || [];

    console.log("✅ Ditemukan " + plants.length + " plant.\n");
  }

  if (plants.length === 0) {
    fail(
      "Token ini tidak memiliki plant apa pun.",
      "Token/plant salah environment? Coba baseUrl produksi: https://open.growatt.com/v1 (atau server.growatt.com/v1 sesuai akun)."
    );
  }

  // ----------------------------------------------------------
  // 2) device/list per plant — SN inverter yang VALID
  // ----------------------------------------------------------

  const validSns = [];

  const dataloggerSns = new Set(); // SN datalogger yang muncul (utk diagnosis)

  for (const plant of plants) {
    console.log("———————————————————————————————");
    console.log(
      "🏭 plant_id=" + plant.plant_id + "  " + (plant.name || "(tanpa nama)")
    );
    console.log("———————————————————————————————");

    const { httpStatus, body } = await apiGetWithRetry(
      "/device/list",
      { plant_id: plant.plant_id, page: 1, perpage: 100 },
      "device/list"
    );

    if (Number(body.error_code) !== 0) {
      console.log(
        "⚠️  device/list gagal — HTTP " + httpStatus + ", error_code " +
          body.error_code + ": " + (body.error_msg || "?")
      );

      continue;
    }

    const devices = (body.data && body.data.devices) || [];

    if (devices.length === 0) {
      console.log("   (tidak ada device di plant ini)\n");

      continue;
    }

    for (const d of devices) {
      const sn = String(d.device_sn || "");
      const isInv = Number(d.type) === 1; // 1 = inverter (dari PDF)

      if (sn && !validSns.includes(sn)) validSns.push(sn);

      if (d.datalogger_sn) dataloggerSns.add(String(d.datalogger_sn));

      const inConfig = CONFIG_DEVICES.includes(sn);

      const mark = inConfig ? "✅ (di config)" : isInv ? "🟢" : "  ";

      console.log(
        mark +
          " SN: " + sn +
          "  type=" + d.type + (isInv ? " (inverter)" : "") +
          "  datalogger=" + (d.datalogger_sn || "-") +
          "  model=" + (d.model || "-") +
          "  update=" + (d.last_update_time || "-")
      );
    }

    console.log("");
  }

  // ----------------------------------------------------------
  // 3) Bandingkan dengan config.growatt.devices
  // ----------------------------------------------------------

  console.log("======================================");
  console.log("📋 KESIMPULAN");
  console.log("======================================");

  if (validSns.length === 0) {
    console.log("Tidak ada SN valid yang bisa dibandingkan (device/list gagal).");
  } else {
    const unknown = CONFIG_DEVICES.filter((sn) => !validSns.includes(sn));

    console.log("SN valid untuk token ini : " + validSns.join(", "));
    console.log("");

    if (unknown.length === 0) {
      console.log("✅ Semua SN di config dikenal server — kalau masih 10005,");
      console.log("   berarti masalahnya mismatch baseUrl/token environment.");
    } else {
      console.log("⚠️  SN di config yang TIDAK dikenal server (penyebab 10005):");

      for (const sn of unknown) {
        if (dataloggerSns.has(sn)) {
          console.log(
            "   - " + sn + "  ← ini SN DATALOGGER, bukan inverter!"
          );
        } else {
          console.log("   - " + sn);
        }
      }

      console.log("");
      console.log(
        "👉 Ganti growatt.devices di config.local.json dengan SN 🟢/✅ di atas."
      );
    }
  }

  console.log("======================================");
}

main().catch((e) => {
  fail(String((e && e.message) || e), "Cek koneksi internet / baseUrl.");
});
