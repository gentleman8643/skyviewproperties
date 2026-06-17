// generate-manifest.js
// 1. Fetches your Google Sheet to discover all Property IDs
// 2. Scans public/ for media files in matching folders
// 3. Writes public/media-manifest.json so every listing appears
//
// You NEVER edit the manifest by hand.
// Just add photos to public/properties/<PROPERTY_ID>/ and push — done.

const fs   = require("fs");
const path = require("path");
const https = require("https");

const ROOT   = __dirname;
const OUTPUT = path.join(ROOT, "public", "media-manifest.json");

// Same CSV URL your website uses
const CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vT5Dudb7PfN8IwcrGz8GuKIpPtWymiJNG4bmoCcLiq-z_x2hDmuF3psbI6rDAhMpe0RCopMfdHUuyb1/pub?output=csv";

const MEDIA_RE = /\.(jpe?g|png|webp|gif|avif|mp4|webm|ogg|mov|m4v)$/i;
const IGNORE   = new Set(["node_modules", ".git", ".netlify", ".vercel", ".github", "dist"]);

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

// ── Parse CSV (handles commas inside quotes) ─────────────────────────────
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

// ── Scan a directory for media files ──────────────────────────────────────
function scanDir(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return []; }

    const files = [];
    for (const entry of entries) {
        if (entry.isDirectory()) {
            if (IGNORE.has(entry.name)) continue;
            files.push(...scanDir(path.join(dir, entry.name)));
        } else if (MEDIA_RE.test(entry.name)) {
            files.push(path.join(dir, entry.name));
        }
    }
    return files;
}

// ── MAIN ─────────────────────────────────────────────────────────────────
async function main() {
    // 1) Get all Property IDs from the spreadsheet
    let sheetIDs = [];
    try {
        console.log("Fetching Google Sheet...");
        const csvText = await fetchCSV(CSV_URL);
        const rows    = parseCSV(csvText);
        sheetIDs = rows
            .map(r => (r["id"] || "").trim())
            .filter(id => id.length > 0);
        console.log(`Found ${sheetIDs.length} IDs in spreadsheet: ${sheetIDs.join(", ")}`);
    } catch (err) {
        console.warn("Could not fetch spreadsheet (will rely on folder scan only):", err.message);
    }

    // 2) Ensure every sheet ID has a folder under public/properties/
    const propBase = path.join(ROOT, "public", "properties");
    for (const id of sheetIDs) {
        const folder = path.join(propBase, id);
        if (!fs.existsSync(folder)) {
            fs.mkdirSync(folder, { recursive: true });
            console.log(`Created folder: public/properties/${id}`);
        }
    }

    // 3) Scan public/properties/ for media files and group by folder name
    const allFiles = scanDir(propBase);
    const byFolder = {};
    for (const absPath of allFiles) {
        // Figure out the property ID = the folder right under properties/
        const rel = path.relative(propBase, absPath).split(path.sep);
        const id  = rel[0];  // first segment is the property ID folder
        if (!byFolder[id]) byFolder[id] = [];
        byFolder[id].push(absPath);
    }

    // 4) Build the manifest — every sheet ID gets an entry
    for (const id of sheetIDs) {
        const files = byFolder[id] || [];

        // Sort: images first (first = thumbnail), then videos, both alphabetical
        files.sort((a, b) => {
            const av = /\.(mp4|webm|ogg|mov|m4v)$/i.test(a) ? 1 : 0;
            const bv = /\.(mp4|webm|ogg|mov|m4v)$/i.test(b) ? 1 : 0;
            return av - bv || path.basename(a).localeCompare(path.basename(b));
        });

        // Convert absolute paths to web URLs.
        // Files are under public/properties/<ID>/  →  web URL is /properties/<ID>/file.jpg
        manifest[id] = files.map(absPath => {
            let rel = path.relative(path.join(ROOT, "public"), absPath).split(path.sep).join("/");
            return "/" + rel;
        });

        if (manifest[id].length === 0) {
            console.log(`  ${id}: no media yet (folder is empty)`);
        } else {
            console.log(`  ${id}: ${manifest[id].length} file(s)`);
        }
    }

    // 5) Also include any folders with media that aren't in the sheet yet
    //    (so newly-added photos show up even before the sheet is updated)
    for (const id of Object.keys(byFolder)) {
        if (manifest[id]) continue;  // already handled from sheet
        const files = byFolder[id];
        files.sort((a, b) => {
            const av = /\.(mp4|webm|ogg|mov|m4v)$/i.test(a) ? 1 : 0;
            const bv = /\.(mp4|webm|ogg|mov|m4v)$/i.test(b) ? 1 : 0;
            return av - bv || path.basename(a).localeCompare(path.basename(b));
        });
        manifest[id] = files.map(absPath => {
            let rel = path.relative(path.join(ROOT, "public"), absPath).split(path.sep).join("/");
            return "/" + rel;
        });
        console.log(`  ${id}: ${manifest[id].length} file(s) [not in sheet yet, added from folder]`);
    }

    // 6) Write the manifest
    fs.writeFileSync(OUTPUT, JSON.stringify(manifest, null, 2));
    console.log(`\nmedia-manifest.json written: ${Object.keys(manifest).length} properties.`);
}

main().catch(err => {
    console.error("FATAL:", err);
    process.exit(1);
});
