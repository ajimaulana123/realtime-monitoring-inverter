"use strict";

// ============================================================
// DEBUG-REVIEW — inspeksi dashboard via Playwright
// ============================================================
// Cek: console error, request gagal (404), overflow layout,
// elemen kunci, dan simpan screenshot desktop + mobile.
// File sementara.
// ============================================================

const { chromium } = require("playwright");

const path = require("path");

const SHOT_DIR = path.join(__dirname, "screenshots");

require("fs").mkdirSync(SHOT_DIR, { recursive: true });

const URL = "http://localhost:8787/";

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 375, height: 720 },
];

async function main() {
  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
  });

  const problems = [];

  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
    });

    const page = await context.newPage();

    const consoleErrors = [];

    const failedRequests = [];

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });

    page.on("pageerror", (err) => {
      consoleErrors.push("pageerror: " + err.message);
    });

    page.on("requestfailed", (req) => {
      failedRequests.push(req.url() + " → " + req.failure().errorText);
    });

    page.on("response", (res) => {
      if (res.status() >= 400) {
        failedRequests.push(res.url() + " → HTTP " + res.status());
      }
    });

    await page.goto(URL, { waitUntil: "networkidle", timeout: 30000 });

    // Tunggu beberapa snapshot SSE masuk & chart tergambar.

    await page.waitForTimeout(6000);

    // ----- DOM checks -----

    const checks = await page.evaluate(() => {
      const q = (s) => document.querySelector(s);

      const totalPac = q("#total-pac");

      const cards = document.querySelectorAll(".inv-card");

      const overflowX =
        document.documentElement.scrollWidth > window.innerWidth + 2;

      // elemen yang keluar dari viewport

      const offenders = [];

      for (const el of document.querySelectorAll("body *")) {
        const r = el.getBoundingClientRect();

        if (
          r.width > 0 &&
          (r.right > window.innerWidth + 8 || r.left < -8) &&
          !el.closest(".chart-wrap")
        ) {
          offenders.push(
            el.tagName.toLowerCase() +
              "." +
              String(el.className && el.className.baseVal !== undefined
                ? el.className.baseVal
                : el.className || "").split(" ")[0] +
              ` (right=${Math.round(r.right)})`
          );

          if (offenders.length >= 5) break;
        }
      }

      return {
        title: document.title,
        totalPacText: totalPac ? totalPac.textContent.trim() : "(hilang)",
        totalPacUnit: q("#total-pac-unit")
          ? q("#total-pac-unit").textContent.trim()
          : "(hilang)",
        cardCount: cards.length,
        hasChart: !!q("#power-chart"),
        overflowX,
        offenders,
        statusbar: q("#sb-mode") ? q("#sb-mode").textContent : "(hilang)",
      };
    });

    const shot = path.join(SHOT_DIR, `dash-${vp.name}.png`);

    await page.screenshot({ path: shot, fullPage: false });

    console.log(`\n===== ${vp.name.toUpperCase()} (${vp.width}px) =====`);

    console.log("title        :", checks.title);
    console.log("totalPac     :", checks.totalPacText, checks.totalPacUnit);
    console.log("kartu inv    :", checks.cardCount);
    console.log("chart ada    :", checks.hasChart);
    console.log("statusbar    :", checks.statusbar);
    console.log("overflowX    :", checks.overflowX);

    if (checks.overflowX) {
      problems.push(`[${vp.name}] overflow horizontal terdeteksi`);
    }

    if (checks.offenders.length) {
      console.log("offenders    :", checks.offenders.join(" | "));

      problems.push(
        `[${vp.name}] elemen keluar viewport: ${checks.offenders.join(", ")}`
      );
    }

    if (consoleErrors.length) {
      console.log("console ERR  :", consoleErrors.slice(0, 5).join(" | "));

      problems.push(`[${vp.name}] console error: ${consoleErrors[0]}`);
    } else {
      console.log("console ERR  : (tidak ada)");
    }

    if (failedRequests.length) {
      console.log("req gagal    :", failedRequests.slice(0, 5).join(" | "));

      problems.push(`[${vp.name}] request gagal: ${failedRequests[0]}`);
    } else {
      console.log("req gagal    : (tidak ada)");
    }

    console.log("screenshot   :", shot);

    await context.close();
  }

  await browser.close();

  console.log("\n======================================");

  if (problems.length) {
    console.log("MASALAH (" + problems.length + "):");

    for (const p of problems) console.log("  ⚠️ " + p);

    process.exitCode = 1;
  } else {
    console.log("✅ Inspeksi bersih — tidak ada masalah.");
  }
}

main().catch((e) => {
  console.error("DEBUG: GAGAL |", e.message);

  process.exit(1);
});
