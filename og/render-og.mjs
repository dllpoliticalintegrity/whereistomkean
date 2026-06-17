// Regenerate the 1200x630 social share card (../og-image.png) from the
// missing-person bulletin template, using live Integrity Index data.
//
//   npm install            # installs playwright
//   npx playwright install chromium
//   npm run build          # writes ../og-image.png
//
// The candidate photo and identifying details are pulled fresh from the
// public Supabase REST API and inlined as a data URI, so the rendered
// page has no external image dependency at screenshot time.

import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));

const SUPABASE_URL = "https://qjsesvdduoriofiodumm.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFqc2VzdmRkdW9yaW9maW9kdW1tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjA2OTU3OTksImV4cCI6MjA3NjI3MTc5OX0.ny5M7Z0yMlw0K1LWyKfSEde4VFjAdJmimTh2YHxl-3s";
const CANDIDATE_SLUG = "thomas-kean";
const CANDIDATE_BIOGUIDE = "K000398";

async function fetchCandidate() {
  const url =
    `${SUPABASE_URL}/rest/v1/candidates?slug=eq.${CANDIDATE_SLUG}` +
    `&select=name,party,state,district,bioguide_id,photo_url_large`;
  const res = await fetch(url, { headers: { apikey: SUPABASE_ANON_KEY } });
  if (!res.ok) throw new Error(`candidate fetch failed: ${res.status}`);
  const [cand] = await res.json();
  return cand || null;
}

async function toDataUri(photoUrl) {
  if (!photoUrl) return "";
  const res = await fetch(photoUrl);
  if (!res.ok) throw new Error(`photo fetch failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const mime = photoUrl.endsWith(".webp")
    ? "image/webp"
    : photoUrl.endsWith(".png")
      ? "image/png"
      : "image/jpeg";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

function districtCode(cand) {
  const st = (cand?.state || "")
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase();
  if (cand?.district) return `${st}-${String(cand.district).padStart(2, "0")}`;
  return st || "NJ-07";
}

function displayName(cand) {
  let name = cand?.name || "Thomas Kean";
  if (!/\bjr\b/i.test(name)) name += " Jr.";
  return name;
}

async function main() {
  const cand = await fetchCandidate();
  const data = {
    NAME: displayName(cand),
    DISTRICT: districtCode(cand),
    PARTY: cand?.party || "Republican",
    CASE: `#${cand?.bioguide_id || CANDIDATE_BIOGUIDE}`,
    PHOTO_SRC: await toDataUri(cand?.photo_url_large),
  };

  let html = await readFile(join(__dirname, "template.html"), "utf8");
  for (const [key, value] of Object.entries(data)) {
    html = html.replaceAll(`{{${key}}}`, value);
  }

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 630 },
      deviceScaleFactor: 1,
    });
    await page.setContent(html, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(250);
    const out = join(__dirname, "..", "og-image.png");
    await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1200, height: 630 } });
    console.log(`wrote ${out}`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
