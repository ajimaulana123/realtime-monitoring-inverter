# ⚡ Realtime Inverter Data — PLTS Control Room

Dashboard web **realtime** untuk memantau power & status inverter PLTS
(berbasis **Growatt API** sesuai `api-plts-inverter.pdf`).

```text
realtime-inverter-data/
├── server.cjs              ← server: poller + SSE + static (zero-dependency)
├── config.json             ← konfigurasi (mode, token, device SN, interval)
├── api-plts-inverter.pdf   ← dokumentasi API Growatt (sumber)
├── api-plts-inverter.txt   ← hasil ekstraksi PDF (pdftotext)
└── public/
    ├── index.html          ← dashboard
    ├── styles.css          ← tema SCADA control-room
    └── app.js              ← client: SSE, kartu inverter, kurva canvas
```

---

## 🚀 Menjalankan

```powershell
cd D:\project-web\realtime-inverter-data

# Mode simulasi (tanpa token, langsung jalan — data palsu realistis):
node server.cjs

# Mode live (panggil API Growatt asli):
node server.cjs --live
```

Buka browser: **http://localhost:8787**

### 🔎 Verifikasi SN device (mendiagnosis 10005 / 10012)

```powershell
node verify-device.cjs
```

Script ini memanggil `/plant/list` + `/device/list` dengan token & baseUrl dari
config, lalu menampilkan SN inverter yang **valid** dan membandingkannya dengan
`growatt.devices` di config.

* Error **10005** `inverterNotExistError` → SN di config tidak dikenal server
  (sering karena SN yang dipakai adalah SN **datalogger**, bukan inverter —
  script menandainya otomatis).
* Error **10012** `error_frequently_access` → rate limit; script ini otomatis
  retry (tunggu 30 dtk lalu 60 dtk). Kalau server live masih jalan bareng,
  jalankan script saat server di-stop supaya tidak berebut kuota API.

Opsi: `--plant-id=123` (skip plant/list), `--base-url=...`, `--token=...`.

Mode juga bisa ditekan lewat `config.json` → `"mode": "simulate" | "growatt"`.
Argumen CLI menang: `--live` / `--simulate`.

---

## 🖥️ Yang ditampilkan dashboard

| Elemen | Sumber data (field Growatt) |
|---|---|
| **Total output AC** (angka besar) | Jumlah `pac` semua inverter |
| Puncak sesi & produksi hari ini | `powerToday` |
| Meter beban vs kapasitas | total `pac` / kapasitas terpasang (di `app.js`) |
| **Kurva daya 15 menit** | riwayat `pac` per poll (canvas) |
| **Kartu per inverter**: status LED, PAC, PPV, VAC/IAC, VPV, IPV, frekuensi, suhu, sparkline | `statusText`, `pac`, `ppv`, `vacr`, `iacr`, `vpv1/2`, `ipv1/2`, `fac`, `temperature`, `time` |
| Statusbar: mode, poll ke-, error, koneksi SSE | state server |

---

## 🎭 Demo terpisah — test environment Growatt (`demo-test.cjs`)

Server demo yang **independen** dari server.cjs (config & port sendiri):
memakai endpoint **test environment** persis seperti `api-plts-inverter.txt`
(`http://test.growatt.com/v1` + test token di dokumen itu).

```powershell
node demo-test.cjs                 # port 8899
node demo-test.cjs --port=9000
node demo-test.cjs --force-sim     # langsung simulator, tanpa sentuh API
```

Dashboard: **http://localhost:8899** (dipinjam dari /public, aman dibarengi
server.cjs di :8787).

Alur demo:
1. **Discovery** — `GET /plant/list` → `GET /device/list` (3× retry)
   untuk menemukan SN inverter (type=1) di test env.
2. **Poll** — `GET /device/inverter/last_new_data` per SN (berurutan,
   jeda ≥3 dtk antar-request, poll tiap 15 dtk).
3. **Fallback** — kalau API gagal (10005/10012/timeout), device otomatis
   pakai simulator lokal (`simulated: true` di snapshot). Setelah 8 poll
   gagal berturut-turut, demo pindah **full-simulator** (`mode: demo-sim`)
   supaya presentasi tetap jalan mulus.

> Catatan: test env Growatt sangat flaky — plant/device bisa muncul-hilang
> dan 10012 mudah terpicu. Fallback simulator memastikan demo tidak pernah
> mati; label `simulated` menjaga data palsu tidak tertukar dengan data API.

---

## 🔌 Arsitektur

```text
Growatt API (atau simulator)
        │  poll tiap 5 dtk (timeout 10 dtk, paralel per device)
        ▼
server.cjs ── snapshot state (data + history 15 menit)
        │  SSE push /api/stream  (event-stream, auto-reconnect)
        ▼
Browser dashboard  (fallback otomatis: polling /api/snapshot)
```

* **Zero dependency** — hanya Node.js bawaan (`http`, `fs`, `fetch` bawaan Node 18+).
* **SSE, bukan WebSocket** — satu arah, cukup untuk telemetry, auto-reconnect bawaan browser.
* **Timeout semua call eksternal** + verifikasi `error_code === 0` (bukan sekadar HTTP 200) — pola dari PDF & project bot.
* Satu device gagal tidak menjatuhkan device lain (`Promise.allSettled`).
* Dashboard **tidak flicker** — kartu dibuat sekali, di-update in-place.

---

## ⚙️ Konfigurasi (`config.json`)

```json
{
  "mode": "simulate",
  "server": { "port": 8787 },
  "growatt": {
    "baseUrl": "http://test.growatt.com/v1",
    "token": "6eb6f069523055a339d71e5b1f6c88cc",
    "devices": ["2033022963", "TL15300005"],
    "pollIntervalMs": 5000,
    "requestTimeoutMs": 10000
  },
  "simulate": { "deviceCount": 3 }
}
```

| Key | Arti |
|---|---|
| `mode` | `simulate` (data palsu) / `growatt` (API asli) |
| `growatt.token` | Token dari Growatt (di PDF: dikirim via **header `token`**) |
| `growatt.devices` | Daftar `device_sn` inverter (dapat dari `/device/list` atau `/plant/list`) |
| `pollIntervalMs` | Interval polling & push SSE |
| `simulate.deviceCount` | Jumlah inverter palsu saat simulasi |

> ⚠️ Kapasitas terpasang untuk meter beban di-hardcode di `public/app.js`
> (`INSTALLED_CAPACITY_W = 9000`) — sesuaikan dengan PLTS kamu.

---

## 📡 Endpoint server

| Endpoint | Fungsi |
|---|---|
| `/` | Dashboard |
| `/api/stream` | **SSE** — snapshot tiap poll (dipakai dashboard) |
| `/api/snapshot` | JSON snapshot terakhir (fallback polling) |

---

## 🔎 Catatan API Growatt (dari PDF)

* Sukses = `error_code: 0` di body JSON (bukan status HTTP).
* Data real-time: `GET /v1/device/inverter/last_new_data?device_sn=...`
  → field `pac` (W), `ppv` (W), `vpv*` (V), `ipv*` (A), `fac` (Hz), `temperature` (°C),
  `powerToday` (kWh), `powerTotal`, `statusText`, `time`.
* Batch banyak inverter: `POST /v1/device/inverter/invs_data` (`inverters: [SN, ...]`).
* Base URL di PDF adalah **environment test** — untuk produksi ganti `baseUrl`
  dan pakai token asli dari Growatt.
* Waktu contoh di PDF memakai `timezone_id: 8` (Asia/Shanghai, UTC+8).

---

## 🧪 Status

```text
Server + SSE             ✅
Mode simulasi realistis  ✅ (kurva matahari, fault acak)
Dashboard SCADA          ✅
Kurva + sparkline        ✅
Fallback polling         ✅
Mode live Growatt        ✅ (butuh token & device_sn valid)
WebSocket                ⏳ (tidak diperlukan)
Riwayat persisten (DB)   ⏳
```
