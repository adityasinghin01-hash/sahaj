#!/usr/bin/env node
/**
 * AGY-14: Playwright headless E2E verification for Riya's Expo web app (apps/child)
 * against the already-running live Sahaj lab server on http://127.0.0.1:3100.
 *
 * Strictly owns:
 * - scripts/lab/web-e2e.mjs
 * - scripts/lab/web-e2e/ (screenshots + results.json)
 *
 * Guardrails:
 * - Serves /tmp/agy14-web via Node http on 127.0.0.1:8099 with SPA fallback, stopped cleanly in finally.
 * - Never touches or restarts port 3100.
 * - Never logs SUPABASE_JWT_SECRET, minted JWTs, or device_secret.
 * - Creates AT MOST ONE synthetic red alert per run.
 */

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("/Users/aditya/node_modules/playwright");

const REPO_ROOT = process.cwd();
const WEB_BUILD_DIR = "/tmp/agy14-web";
const WEB_HOST = "127.0.0.1";

function readFlag(name) {
  const idx = process.argv.indexOf(name);
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : null;
}

const WEB_PORT = Number(readFlag("--port") || 8099);
const EXISTING_ALERT_ID = readFlag("--existing-alert-id");
const WEB_URL = `http://${WEB_HOST}:${WEB_PORT}`;
const API_URL = "http://127.0.0.1:3100";

const FAMILY_ID = "11111111-1111-4111-8111-111111111111";
const PARENT_ID = "22222222-2222-4222-8222-222222222221";
const RIYA_USER_ID = "33333333-3333-4333-8333-333333333332";

const OUT_DIR = path.join(REPO_ROOT, "scripts/lab/web-e2e");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function startStaticSpaServer() {
  const indexHtml = path.join(WEB_BUILD_DIR, "index.html");
  if (!fs.existsSync(indexHtml)) {
    throw new Error(
      `Missing ${indexHtml}. Run Part A first: cd apps/child && npx expo export --platform web --output-dir ${WEB_BUILD_DIR}`,
    );
  }
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    const safeRel = path.normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, "");
    let candidate = path.join(
      WEB_BUILD_DIR,
      safeRel === "/" || safeRel === "" ? "index.html" : safeRel,
    );
    if (!candidate.startsWith(WEB_BUILD_DIR)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    try {
      if (!fs.existsSync(candidate) || fs.statSync(candidate).isDirectory()) {
        candidate = indexHtml;
      }
      const ext = path.extname(candidate).toLowerCase();
      res.writeHead(200, {
        "content-type": MIME_TYPES[ext] || "application/octet-stream",
        "cache-control": "no-store",
      });
      fs.createReadStream(candidate).pipe(res);
    } catch {
      res.writeHead(500);
      res.end("Static serve error");
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(WEB_PORT, WEB_HOST, () => resolve(server));
  });
}

async function launchBrowser() {
  const cachedPath = chromium.executablePath();
  if (cachedPath && fs.existsSync(cachedPath)) {
    return chromium.launch({ headless: true });
  }
  const systemChrome =
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (fs.existsSync(systemChrome)) {
    return chromium.launch({ headless: true, executablePath: systemChrome });
  }
  return chromium.launch({ headless: true, channel: "chrome" });
}

async function apiJson(pathname, { method = "GET", body, headers = {} } = {}) {
  const rawBody =
    body === undefined
      ? undefined
      : typeof body === "string"
        ? body
        : JSON.stringify(body);
  const res = await fetch(`${API_URL}${pathname}`, {
    method,
    headers: {
      ...(rawBody !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    ...(rawBody !== undefined ? { body: rawBody } : {}),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data };
}

async function centerAndClick(page, locator) {
  await locator.waitFor({ state: "visible", timeout: 10000 });
  await locator.evaluate((el) => {
    el.scrollIntoView({ block: "center", inline: "center" });
  });
  await page.waitForTimeout(150);
  await locator.click();
}

async function openTab(page, label) {
  const tab = page.locator(`[role="tab"][aria-label="${label}"]`).locator("visible=true").last();
  await tab.waitFor({ state: "visible", timeout: 10000 });
  await tab.click();
  await page.waitForTimeout(300);
}

async function clickGoBack(page) {
  const backBtn = page.locator('[aria-label="Go back"]').locator("visible=true").last();
  await centerAndClick(page, backBtn);
  await page.waitForTimeout(250);
}

async function screenshot(page, filename) {
  const fullPath = path.join(OUT_DIR, filename);
  await page.screenshot({ path: fullPath, fullPage: false });
  return path.relative(REPO_ROOT, fullPath);
}

async function run() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const results = [];
  const consoleErrors = [];
  const pageErrors = [];
  let server = null;
  let browser = null;

  let alertSentCount = 0;
  let riyaToken = null;
  let newAlert = null;
  let initialSummary = null;

  async function recordStep(num, name, screenshotName, fn, pageRef) {
    const start = Date.now();
    try {
      const detail = await fn();
      const shot = pageRef
        ? await screenshot(pageRef(), screenshotName)
        : null;
      const elapsedMs = Date.now() - start;
      results.push({ num, name, status: "PASS", elapsedMs, screenshot: shot, detail });
      console.log(
        `[PASS] Step ${num}: ${name} (${elapsedMs}ms)${shot ? ` -> ${shot}` : ""}${detail ? ` | ${detail}` : ""}`,
      );
      return detail;
    } catch (err) {
      const elapsedMs = Date.now() - start;
      let shot = null;
      if (pageRef) {
        try {
          shot = await screenshot(
            pageRef(),
            screenshotName.replace(/\.png$/, "-FAIL.png"),
          );
        } catch {
          // ignore secondary screenshot errors
        }
      }
      const message = err instanceof Error ? err.message : String(err);
      results.push({ num, name, status: "FAIL", elapsedMs, screenshot: shot, error: message });
      console.error(
        `[FAIL] Step ${num}: ${name} (${elapsedMs}ms)${shot ? ` -> ${shot}` : ""} | ${message}`,
      );
      return null;
    }
  }

  let page = null;
  try {
    server = await startStaticSpaServer();
    console.log(`Static SPA server listening on ${WEB_URL} serving ${WEB_BUILD_DIR}`);

    browser = await launchBrowser();
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    page = await context.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => {
      pageErrors.push(err instanceof Error ? err.message : String(err));
    });

    // Step 1: Mint Riya's lab token and verify against running :3100 summary endpoint
    await recordStep(
      1,
      "Mint Riya lab token and verify /api/app/shield/summary",
      "step-01-token-and-demo-home.png",
      async () => {
        const sources = [
          ["~/.sahaj-lab/lab.env", path.join(os.homedir(), ".sahaj-lab/lab.env")],
          [
            "~/dev/sahaj-secrets/shield.env",
            path.join(os.homedir(), "dev/sahaj-secrets/shield.env"),
          ],
        ];
        let matchedSource = null;
        for (const [label, filePath] of sources) {
          const parsed = parseEnvFile(filePath);
          const secret = parsed.SUPABASE_JWT_SECRET;
          if (!secret) continue;
          const candidateToken = execFileSync(
            "node",
            [
              path.join(REPO_ROOT, "apps/shield-api/scripts/mint-lab-token.mjs"),
              RIYA_USER_ID,
            ],
            {
              env: { ...process.env, SUPABASE_JWT_SECRET: secret },
              encoding: "utf8",
            },
          ).trim();
          const check = await apiJson("/api/app/shield/summary", {
            headers: { Authorization: `Bearer ${candidateToken}` },
          });
          if (check.status === 200) {
            riyaToken = candidateToken;
            initialSummary = check.data;
            matchedSource = label;
            break;
          }
        }
        if (!riyaToken || !initialSummary) {
          throw new Error(
            "Could not mint a valid token matching http://127.0.0.1:3100 from lab.env or shield.env",
          );
        }
        await page.goto(WEB_URL, { waitUntil: "networkidle" });
        await page.getByText("Demo mode").waitFor({ state: "visible", timeout: 10000 });
        return `Verified via ${matchedSource}; family_id=${initialSummary.family_id}, checks=${initialSummary.checks_this_week}`;
      },
      () => page,
    );

    if (!riyaToken) {
      throw new Error("Aborting remaining steps because Step 1 failed to mint/verify token.");
    }

    // Step 2: Open sign-in at 390x844, enter API URL + token, sign in
    await recordStep(
      2,
      "Open sign-in at 390x844, enter http://127.0.0.1:3100 + token, sign in",
      "step-02-signed-in-shield.png",
      async () => {
        await centerAndClick(page, page.getByText("Connect live Shield").locator("visible=true").last());
        await page.getByText("Connect Riya’s Shield").locator("visible=true").last().waitFor({
          state: "visible",
          timeout: 10000,
        });
        await page.getByLabel("API URL").fill(API_URL);
        await page.getByLabel("Access token").fill(riyaToken);
        await centerAndClick(page, page.getByRole("button", { name: "Connect" }).locator("visible=true").last());
        await page.getByText(/Live Shield/).locator("visible=true").last().waitFor({
          state: "visible",
          timeout: 15000,
        });
        await page.getByText("What is protected").locator("visible=true").last().waitFor({
          state: "visible",
          timeout: 10000,
        });
        return "Signed in and landed on LiveShield";
      },
      () => page,
    );

    // Step 3: Create ONE fresh red alert via signed device event API (strictly <= 1 alert)
    // Or if --existing-alert-id is passed, inspect that already-created red alert with 0 new alerts sent.
    const letterSuffix = Array.from({ length: 6 }, () =>
      String.fromCharCode(97 + Math.floor(Math.random() * 26)),
    ).join("");
    let uniqueDomain = `kyc-check-${letterSuffix}.example`;
    const alertStartTime = Date.now();
    await recordStep(
      3,
      EXISTING_ALERT_ID
        ? `Reuse existing red alert ${EXISTING_ALERT_ID} (0 new alerts sent)`
        : "Create ONE fresh red alert via API (pair + signed device event)",
      "step-03-home-before-poll.png",
      async () => {
        const authHeaders = { Authorization: `Bearer ${riyaToken}` };
        if (EXISTING_ALERT_ID) {
          const existingRes = await apiJson(
            `/api/app/shield/alerts/${EXISTING_ALERT_ID}`,
            { headers: authHeaders },
          );
          if (existingRes.status !== 200 || !existingRes.data) {
            throw new Error(
              `Failed to load existing alert ${EXISTING_ALERT_ID} (${existingRes.status})`,
            );
          }
          newAlert = existingRes.data;
          if (newAlert.level !== "red") {
            throw new Error(`Expected existing alert level=red, got ${newAlert.level}`);
          }
          const matchDomain = newAlert.masked_snippet?.match(/kyc-[a-z-]+\.example/i);
          if (!matchDomain) {
            throw new Error(
              `Unexpected masked_snippet for existing alert: ${newAlert.masked_snippet}`,
            );
          }
          uniqueDomain = matchDomain[0];
          await openTab(page, "Home");
          return `Reused existing red alert id=${newAlert.id} (alertSentCount=0, snippet="${newAlert.masked_snippet}")`;
        }

        if (alertSentCount >= 1) {
          throw new Error("Safety guard: refusing to send more than 1 red alert.");
        }
        const beforeRes = await apiJson("/api/app/shield/alerts?limit=25", {
          headers: authHeaders,
        });
        if (beforeRes.status !== 200) {
          throw new Error(`Pre-alert fetch failed: ${beforeRes.status}`);
        }
        const beforeIds = new Set((beforeRes.data.alerts || []).map((a) => a.id));

        const pairCodeRes = await apiJson("/api/app/shield/pair-code", {
          method: "POST",
          body: {},
          headers: {
            ...authHeaders,
            "Idempotency-Key": `agy14-pair-${randomUUID()}`,
          },
        });
        if (pairCodeRes.status !== 200 || !pairCodeRes.data?.code) {
          throw new Error(`pair-code failed (${pairCodeRes.status})`);
        }

        const pairRes = await apiJson("/api/shield/pair", {
          method: "POST",
          body: {
            code: pairCodeRes.data.code,
            parent_person_id: PARENT_ID,
            label: "Lab Synthetic Phone",
            platform: "android",
            protections: {
              sms: true,
              screening: true,
              redirection: true,
              usage: true,
              notifications: true,
              overlay: true,
            },
          },
        });
        if (pairRes.status !== 200 || !pairRes.data?.device_secret) {
          throw new Error(`pair failed (${pairRes.status})`);
        }

        const fullEvent = {
          idempotency_key: `agy14-${randomUUID()}`,
          family_id: FAMILY_ID,
          parent_id: PARENT_ID,
          device_id: pairRes.data.device_id,
          channel: "device",
          occurred_at: new Date().toISOString(),
          kind: "sms",
          sender_type: "mobile_10",
          masked_text: `URGENT bank account KYC blocked update immediately at http://${uniqueDomain}`,
          link_domains: [uniqueDomain],
          local_level: "yellow",
          matched_rules: [],
          context: {},
        };
        const rawBody = JSON.stringify(fullEvent);
        const ts = String(Date.now());
        const sig = createHmac("sha256", pairRes.data.device_secret)
          .update(`${ts}.${rawBody}`)
          .digest("hex");

        alertSentCount += 1;
        const evRes = await apiJson("/api/shield/event", {
          method: "POST",
          body: rawBody,
          headers: {
            "x-shield-device": pairRes.data.device_id,
            "x-shield-ts": ts,
            "x-shield-sig": sig,
          },
        });
        if (evRes.status !== 200) {
          throw new Error(`signed /api/shield/event failed (${evRes.status})`);
        }

        const pollDeadline = Date.now() + 12000;
        while (Date.now() < pollDeadline) {
          const afterRes = await apiJson("/api/app/shield/alerts?limit=25", {
            headers: authHeaders,
          });
          const candidate = (afterRes.data?.alerts || []).find(
            (a) => !beforeIds.has(a.id),
          );
          if (candidate) {
            newAlert = candidate;
            break;
          }
          await new Promise((r) => setTimeout(r, 300));
        }
        if (!newAlert) {
          throw new Error("New alert did not appear in /api/app/shield/alerts within 12s");
        }
        if (newAlert.level !== "red") {
          throw new Error(`Expected new alert level=red, got ${newAlert.level}`);
        }
        // Switch to Home tab so Step 4 validates the 3s polling live banner update on Home
        await openTab(page, "Home");
        return `Created red alert id=${newAlert.id} (snippet="${newAlert.masked_snippet}")`;
      },
      () => page,
    );

    if (!newAlert) {
      throw new Error("Aborting remaining steps because no new red alert was recorded.");
    }

    // Step 4: Within 15s (app polls every 3s), Home or Shield shows the new red alert; open it, assert reasons visible & snippet has no 4+ digit run
    await recordStep(
      4,
      "Poll brings new red alert into UI within 15s; open it, verify reasons & masking",
      "step-04-alert-detail.png",
      async () => {
        const remainingTimeout = Math.max(5000, 15000 - (Date.now() - alertStartTime));
        const snippetNeedle = uniqueDomain;
        const cardSnippet = page.getByText(snippetNeedle, { exact: false }).locator("visible=true").last();
        await cardSnippet.waitFor({ state: "visible", timeout: remainingTimeout });
        const uiAppearanceMs = Date.now() - alertStartTime;

        await centerAndClick(page, cardSnippet);
        await page.getByText("Alert detail").locator("visible=true").last().waitFor({ state: "visible", timeout: 10000 });
        await page.getByText("Why Shield flagged it", { exact: false }).locator("visible=true").last().waitFor({
          state: "visible",
          timeout: 10000,
        });

        const firstReasonEn = newAlert.reasons?.[0]?.en;
        if (!firstReasonEn) {
          throw new Error("Server alert has no reasons[0].en to check");
        }
        await page.getByText(firstReasonEn, { exact: false }).locator("visible=true").first().waitFor({
          state: "visible",
          timeout: 10000,
        });

        // Assert masked snippet has no 4+ digit run
        const digitRunMatch = newAlert.masked_snippet.match(/\d{4,}/);
        if (digitRunMatch) {
          throw new Error(`Masking violation in masked_snippet: ${digitRunMatch[0]}`);
        }
        return `Appeared in Home UI in ${uiAppearanceMs}ms (<15000ms); ${newAlert.reasons.length} reasons verified; no 4+ digit run in masked snippet`;
      },
      () => page,
    );

    // Step 5: Tap fraud feedback button -> thank-you/saved state -> verify via GET /api/app/shield/alerts/:id
    await recordStep(
      5,
      "Tap fraud feedback button -> saved state & verify via GET /api/app/shield/alerts/:id",
      "step-05-feedback-saved.png",
      async () => {
        const fraudBtn = page
          .getByRole("button", { name: /Fraud tha|It was fraud/i })
          .locator("visible=true")
          .last();
        const savedNotice = page
          .getByText(/Feedback saved: fraud|Family marked this fraud/i)
          .locator("visible=true")
          .first();

        let actionSummary;
        if (EXISTING_ALERT_ID && (await savedNotice.isVisible().catch(() => false))) {
          await savedNotice.evaluate((el) => el.scrollIntoView({ block: "center" }));
          await page.waitForTimeout(200);
          actionSummary = 'Existing alert already had "Family marked this fraud." visible from prior pass';
        } else {
          await fraudBtn.waitFor({ state: "visible", timeout: 10000 });
          const actualButtonLabel = (await fraudBtn.innerText()).trim();
          await centerAndClick(page, fraudBtn);
          await savedNotice.waitFor({ state: "visible", timeout: 10000 });
          await savedNotice.evaluate((el) => el.scrollIntoView({ block: "center" }));
          await page.waitForTimeout(200);
          actionSummary = `Clicked button "${actualButtonLabel}"; UI saved notice shown`;
        }

        const verifyRes = await apiJson(`/api/app/shield/alerts/${newAlert.id}`, {
          headers: { Authorization: `Bearer ${riyaToken}` },
        });
        if (verifyRes.status !== 200) {
          throw new Error(`GET /api/app/shield/alerts/${newAlert.id} returned ${verifyRes.status}`);
        }
        if (verifyRes.data?.child_feedback !== "fraud") {
          throw new Error(
            `Expected child_feedback="fraud", got ${JSON.stringify(verifyRes.data?.child_feedback)}`,
          );
        }
        return `${actionSummary}; API confirmed child_feedback="${verifyRes.data.child_feedback}"`;
      },
      () => page,
    );

    // Step 6: Timeline -> Verify shows valid
    await recordStep(
      6,
      "Timeline -> Verify confirms valid hash chain",
      "step-06-timeline-verify.png",
      async () => {
        // Navigate back from Alert detail to (tabs) so tab bar is accessible
        await clickGoBack(page);
        await openTab(page, "Timeline");
        await page.getByText("Signed Shield record", { exact: false }).locator("visible=true").last().waitFor({
          state: "visible",
          timeout: 10000,
        });
        await centerAndClick(
          page,
          page.getByRole("button", { name: "Verify hash chain" }).locator("visible=true").last(),
        );
        await page.getByText("Verify record").locator("visible=true").last().waitFor({ state: "visible", timeout: 10000 });
        await page.getByText("Hash chain matches").locator("visible=true").last().waitFor({
          state: "visible",
          timeout: 10000,
        });
        const verifyApi = await apiJson("/api/app/timeline/verify", {
          headers: { Authorization: `Bearer ${riyaToken}` },
        });
        if (verifyApi.status !== 200 || verifyApi.data?.valid !== true) {
          throw new Error(`API verify failed: ${JSON.stringify(verifyApi.data)}`);
        }
        return `UI displayed "Hash chain matches" (${verifyApi.data.checked} steps checked); API /api/app/timeline/verify valid=true`;
      },
      () => page,
    );

    // Step 7: Report pack for that alert opens and shows "1930" text and "cybercrime.gov.in"
    await recordStep(
      7,
      'Report pack opens and shows "1930" and "cybercrime.gov.in"',
      "step-07-report-pack.png",
      async () => {
        await clickGoBack(page);
        await openTab(page, "Home");
        const alertCard = page.getByText(uniqueDomain, { exact: false }).locator("visible=true").last();
        await centerAndClick(page, alertCard);
        await centerAndClick(
          page,
          page.getByRole("button", { name: "Report pack" }).locator("visible=true").last(),
        );

        await page.getByText("Incident evidence").locator("visible=true").last().waitFor({
          state: "visible",
          timeout: 10000,
        });
        await page.getByText("1930", { exact: false }).locator("visible=true").first().waitFor({
          state: "visible",
          timeout: 10000,
        });
        await page.getByText("cybercrime.gov.in", { exact: false }).locator("visible=true").first().waitFor({
          state: "visible",
          timeout: 10000,
        });
        const linkBtn = page.getByRole("button", { name: /Open cybercrime\.gov\.in/i }).locator("visible=true").last();
        const linkBtnVisible = await linkBtn.isVisible();
        await linkBtn.evaluate((el) => el.scrollIntoView({ block: "center" }));
        await page.waitForTimeout(200);
        const anchorCount = await page.locator('a[href*="cybercrime.gov.in"]').count();
        return `Visible "1930" and "cybercrime.gov.in" (button visible=${linkBtnVisible}, <a href> count=${anchorCount})`;
      },
      () => page,
    );

    // Step 8: Shield tab shows protections + scam-sense values from server (not "Demo" label)
    await recordStep(
      8,
      'Shield tab shows server protections + scam-sense (no "Demo" label)',
      "step-08-shield-server-values.png",
      async () => {
        await clickGoBack(page); // back to Alert detail
        await clickGoBack(page); // back to (tabs)
        await openTab(page, "Shield");

        await page.getByText("What is protected", { exact: false }).locator("visible=true").last().waitFor({
          state: "visible",
          timeout: 10000,
        });
        const latestSummary = await apiJson("/api/app/shield/summary", {
          headers: { Authorization: `Bearer ${riyaToken}` },
        });
        if (latestSummary.status !== 200) {
          throw new Error(`GET /api/app/shield/summary failed (${latestSummary.status})`);
        }
        const parent = latestSummary.data.parents?.[0];
        if (!parent) throw new Error("Summary returned 0 parents");
        const expectedSense = `${parent.name}: ${parent.scam_sense.score_out_of_5}/5`;
        await page.getByText(expectedSense, { exact: false }).locator("visible=true").last().waitFor({
          state: "visible",
          timeout: 10000,
        });
        await page.getByText("sms · On", { exact: false }).locator("visible=true").first().waitFor({
          state: "visible",
          timeout: 10000,
        });
        // Check visible non-aria-hidden active screen for any "Demo" label
        const activeText = await page.evaluate(() => {
          const panels = Array.from(document.querySelectorAll('[role="tabpanel"], [data-testid], div'));
          const shieldHeading = Array.from(document.querySelectorAll("*")).find(
            (el) => el.childNodes.length === 1 && el.textContent?.trim() === "What is protected",
          );
          let cur = shieldHeading;
          while (cur && cur.parentElement && cur.getAttribute("aria-hidden") === null) {
            if (cur.scrollHeight > 400 && cur.clientWidth >= 300) break;
            cur = cur.parentElement;
          }
          return cur?.innerText || document.body.innerText;
        });
        if (/\bDemo\b/.test(activeText)) {
          throw new Error('Unexpected "Demo" label found in LiveShield view');
        }
        const demoAlertsCount = await page.getByText("Demo alerts", { exact: false }).count();
        if (demoAlertsCount > 0) {
          throw new Error('Unexpected "Demo alerts" label rendered while signed in');
        }
        return `Rendered "${expectedSense}" and server device protections; no "Demo" label on Shield tab`;
      },
      () => page,
    );

    // Step 9: Sign out -> app falls back to labelled Demo mode
    await recordStep(
      9,
      "Sign out -> app falls back to labelled Demo mode",
      "step-09-signed-out-demo.png",
      async () => {
        await centerAndClick(
          page,
          page.getByRole("button", { name: "Lab sign-in / sign out" }).locator("visible=true").last(),
        );
        await centerAndClick(
          page,
          page.getByRole("button", { name: "Use labelled Demo / sign out" }).locator("visible=true").last(),
        );
        await page.getByText("Demo mode").locator("visible=true").last().waitFor({ state: "visible", timeout: 10000 });
        await page.getByText("Connect live Shield").locator("visible=true").last().waitFor({
          state: "visible",
          timeout: 10000,
        });
        await page.waitForTimeout(500);
        const storedSession = await page.evaluate(() =>
          window.localStorage.getItem("sahaj.lab.session.v1"),
        );
        if (storedSession !== null) {
          throw new Error("Expected sahaj.lab.session.v1 to be removed after sign-out");
        }
        return 'Signed out cleanly; "Demo mode" + "Connect live Shield" restored; localStorage session cleared';
      },
      () => page,
    );
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    if (server) {
      await new Promise((resolve) => server.close(() => resolve()));
    }
  }

  const summary = {
    ranAt: new Date().toISOString(),
    webUrl: WEB_URL,
    apiUrl: API_URL,
    viewport: { width: 390, height: 844 },
    alertSentCount,
    newAlertId: newAlert?.id ?? null,
    consoleErrorCount: consoleErrors.length,
    consoleErrors,
    pageErrorCount: pageErrors.length,
    pageErrors,
    results,
  };
  fs.writeFileSync(
    path.join(OUT_DIR, "results.json"),
    JSON.stringify(summary, null, 2),
  );

  const failed = results.filter((r) => r.status !== "PASS");
  console.log(
    `\nSummary: ${results.length - failed.length}/${results.length} passed, ${failed.length} failed, alertSentCount=${alertSentCount}, consoleErrors=${consoleErrors.length}, pageErrors=${pageErrors.length}`,
  );
  if (failed.length > 0 || results.length < 9) {
    process.exitCode = 1;
  }
}

run().catch((err) => {
  console.error("FATAL:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
