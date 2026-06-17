// generate-manifest.js
// 1. Fetches your Google Sheet to discover all Property IDs
// 2. Scans the ENTIRE repo for media files in folders matching any Property ID
// 3. Writes public/media-manifest.json with correct web paths
// 4. Creates empty folders for any IDs that don't have media yet
//
// Works with ANY nesting depth (e.g. public/properties/SVP30001/,
// public/properties/properties/SVP30001/, etc.)
// You NEVER edit the manifest by hand — just push photos and the sheet row.

const fs    = require("fs");
const path  = require("path");
const https = require("https");

const ROOT   = __dirname;
const OUTPUT = path.join(ROOT, "public", "media-manifest.json");
const CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vT5Dudb7PfN8IwcrGz8GuKIpPtWymiJNG4bmoCcLiq-z_x2hDmuF3psbI6rDAhMpe0RCopMfdHUuyb1/pub?output=csv";

const MEDIA_RE = /\.(jpe?g|png|webp|gif|avif|mp4|webm|ogg|mov|m4v)$/i;
const IGNORE   = new Set(["node_modules", ".git", ".netlify", ".vercel", ".github", "dist", ".next", ".cache"]);

const manifest = {};

// ── Fetch CSV (no external deps) ────────────────────────────────────────
function fetchCSV(url) {
    return new Promise((resolve, reject) => {
        const redir = (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                https.get(res.headers.location, redir).on("error", reject);
            } else {
                let body = "";
                res.on("data", c => body += c);
                res.on("end", () => resolve(body));
            }
        };
        https.get(url, redir).on("error", reject);
    });
}

// ── Parse CSV ────────────────────────────────────────────────────────────
function parseCSV(text) {
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 2) return [];
    const headers = splitLine(lines[0]).map(h => h.toLowerCase().trim());
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        const vals = splitLine(lines[i]);
        const obj  = {};
        headers.forEach((h, idx) => { obj[h] = (vals[idx] || "").trim(); });
        rows.push(obj);
    }
    return rows;
}

function splitLine(line) {
    const out = [];
    let cur = "", inQ = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
            if (inQ && line[i+1] === '"') { cur += '"'; i++; }
            else inQ = !inQ;
        } else if (c === ',' && !inQ) {
            out.push(cur); cur = "";
        } else cur += c;
    }
    out.push(cur);
    return out;
}

// ── Scan entire repo for media files, group by Property ID folder ─────────
function scanRepoForMedia(sheetIDs) {
    const idSet = new Set(sheetIDs);
    const byID  = {};

    function walk(dir) {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { return; }

        for (const entry of entries) {
            if (IGNORE.has(entry.name)) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (idSet.has(entry.name)) {
                    const media = collectMedia(full, idSet);
                    if (media.length > 0) {
                        byID[entry.name] = (byID[entry.name] || []).concat(media);
                    }
                }
                walk(full);
            }
        }
    }

    function collectMedia(dir, idSet) {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { return []; }

        const files = [];
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!idSet.has(entry.name)) {
                    files.push(...collectMedia(full, idSet));
                }
            } else if (MEDIA_RE.test(entry.name)) {
                files.push(full);
            }
        }
        return files;
    }

    walk(ROOT);
    return byID;
}

// ── Convert absolute path to web URL ─────────────────────────────────────
function absToWebURL(absPath) {
    let rel = path.relative(ROOT, absPath).split(path.sep).join("/");
    if (rel.startsWith("public/")) rel = rel.slice("public/".length);
    return "/" + rel;
}

// ── MAIN ─────────────────────────────────────────────────────────────────
async function main() {
    // 1) Get all Property IDs from the spreadsheet
    let sheetIDs = [];
    try {
        console.log("Fetching Google Sheet...");
        const csvText = await fetchCSV(CSV_URL);
        const rows    = parseCSV(csvText);
        // Only get IDs from rows that have actual listing data (not placeholders)
        sheetIDs = rows
            .filter(r => r["status"] || r["priceraw"] || r["pricedisplay"] || r["beds"])
            .map(r => (r["id"] || "").trim())
            .filter(id => id.length > 0);
        console.log(`Found ${sheetIDs.length} active IDs in spreadsheet: ${sheetIDs.join(", ")}`);
    } catch (err) {
        console.warn("Could not fetch spreadsheet:", err.message);
        console.log("Falling back to folder scan only...");
    }

    // 2) Scan the entire repo for media files grouped by property ID
    const byID = scanRepoForMedia(sheetIDs);

    // 3) Build manifest — every sheet ID gets an entry
    for (const id of sheetIDs) {
        const files = byID[id] || [];

        files.sort((a, b) => {
            const av = /\.(mp4|webm|ogg|mov|m4v)$/i.test(a) ? 1 : 0;
            const bv = /\.(mp4|webm|ogg|mov|m4v)$/i.test(b) ? 1 : 0;
            return av - bv || path.basename(a).localeCompare(path.basename(b));
        });

        manifest[id] = files.map(absToWebURL);

        if (manifest[id].length === 0) {
            console.log(`  ${id}: no media yet`);
        } else {
            console.log(`  ${id}: ${manifest[id].length} file(s) — ${manifest[id][0]}`);
        }
    }

    // 4) Ensure folder structure exists under public/ for every ID
    for (const id of sheetIDs) {
        const loc1 = path.join(ROOT, "public", "properties", id);
        const loc2 = path.join(ROOT, "public", "properties", "properties", id);
        [loc1, loc2].forEach(loc => {
            if (!fs.existsSync(loc)) {
                fs.mkdirSync(loc, { recursive: true });
            }
            const gitkeep = path.join(loc, ".gitkeep");
            if (!fs.existsSync(gitkeep)) {
                fs.writeFileSync(gitkeep, "");
            }
        });
    }

    // 5) Write the manifest (only valid sheet IDs — no stray folder names)
    fs.writeFileSync(OUTPUT, JSON.stringify(manifest, null, 2));
    console.log(`\nmedia-manifest.json written: ${Object.keys(manifest).length} properties.`);
}

main().catch(err => {
    console.error("FATAL:", err);
    process.exit(1);
});
