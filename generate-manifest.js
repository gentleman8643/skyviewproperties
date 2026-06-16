// generate-manifest.js
// Auto-scans your property folders and writes media-manifest.json.
// You never edit the manifest by hand. Filenames can be anything.

const fs = require("fs");
const path = require("path");

const ROOT = __dirname;                 // repo root (where this file + index.html live)
const OUTPUT = path.join(ROOT, "public", "media-manifest.json");
const MEDIA_RE = /\.(jpe?g|png|webp|gif|avif|mp4|webm|ogg|mov|m4v)$/i;
const IGNORE = new Set(["node_modules", ".git", ".netlify", ".github", "dist"]);

const manifest = {};

// Walk the whole repo. Any folder that directly contains image/video files
// becomes a property, keyed by that folder's name (your Property ID).
function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    const mediaFiles = [];
    for (const entry of entries) {
        if (entry.isDirectory()) {
            if (IGNORE.has(entry.name)) continue;
            walk(path.join(dir, entry.name));
        } else if (MEDIA_RE.test(entry.name)) {
            mediaFiles.push(entry.name);
        }
    }

    if (mediaFiles.length > 0) {
        const id = path.basename(dir);                 // folder name = Property ID

        // Build the web-accessible path.
        // Files under public/ are served at the root URL by both Vite and Netlify,
        // so we strip the leading "public/" segment from the path.
        let relPath = path.relative(ROOT, dir).split(path.sep).join("/");
        if (relPath.startsWith("public/")) relPath = relPath.slice("public/".length);
        const webBase = "/" + relPath;

        // Images first (thumbnail = first entry), then videos — both alphabetical
        mediaFiles.sort((a, b) => {
            const av = /\.(mp4|webm|ogg|mov|m4v)$/i.test(a) ? 1 : 0;
            const bv = /\.(mp4|webm|ogg|mov|m4v)$/i.test(b) ? 1 : 0;
            return av - bv || a.localeCompare(b);
        });
        manifest[id] = mediaFiles.map(f => `${webBase}/${f}`);
    }
}

walk(ROOT);
fs.writeFileSync(OUTPUT, JSON.stringify(manifest, null, 2));
console.log(`media-manifest.json written: ${Object.keys(manifest).length} properties.`);
