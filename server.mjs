/**
 * Serveur local pour overlay OBS Diablo 4
 * - Events (helltides.com/api/schedule)
 * - Import build Mobalytics (URL)
 * - Compteurs morts/uniques
 * - WebSocket pour push en temps réel
 *
 * Variables en anglais, commentaires en français.
 */

import express from "express";
import { WebSocketServer } from "ws";
import { load } from "cheerio";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3199);

const DATA_DIR = path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");
const STATE_PATH = path.join(DATA_DIR, "state.json");
const BUILD_PATH = path.join(DATA_DIR, "build.json");

function stripPlaceholder(builds) {
    if (!Array.isArray(builds)) return [defaultBuild()];
    // Retire l’entrée placeholder si d’autres builds existent
    if (builds.length > 1) {
        builds = builds.filter((b) => !(b.source === "manual" && b.title === "Aucune build importée"));
    }
    if (!builds.length) builds = [defaultBuild()];
    return builds;
}

// Garantit la présence de l'objet counters pour éviter les 500 si le state est mal formé
function ensureCounters(state) {
    if (!state || typeof state !== "object") state = {};
    if (!state.counters || typeof state.counters !== "object") {
        state.counters = { deaths: 0, uniques: 0 };
    } else {
        state.counters.deaths = state.counters.deaths ?? 0;
        state.counters.uniques = state.counters.uniques ?? 0;
    }
    return state;
}

function defaultBuild() {
    return {
        source: "manual",
        title: "Aucune build importée",
        author: "",
        updatedOn: "",
        url: "",
        highlights: []
    };
}

function readBuilds() {
    try {
        const raw = JSON.parse(fs.readFileSync(BUILD_PATH, "utf-8"));
        if (Array.isArray(raw)) return stripPlaceholder(raw);
        if (raw && typeof raw === "object") return stripPlaceholder([raw]);
    } catch {
        // ignore
    }
    return [defaultBuild()];
}

function writeBuilds(builds) {
    writeJson(BUILD_PATH, stripPlaceholder(builds));
}

function ensureBuildState(state) {
    state = state && typeof state === "object" ? state : {};
    const builds = stripPlaceholder(readBuilds());
    state.builds = builds;
    if (!Number.isInteger(state.currentBuildIndex) || state.currentBuildIndex < 0 || state.currentBuildIndex >= builds.length) {
        state.currentBuildIndex = builds.length ? builds.length - 1 : 0;
    }
    state.build = builds[state.currentBuildIndex] || defaultBuild();
    return state;
}

const HELLTIDES_SCHEDULE_URL = "https://helltides.com/api/schedule";

function ensureDirs() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });

    if (!fs.existsSync(BUILD_PATH)) {
        writeJson(BUILD_PATH, [defaultBuild()]);
    }

    if (!fs.existsSync(STATE_PATH)) {
        const initial = ensureBuildState({
            nowIso: new Date().toISOString(),
            timezone: "Europe/Paris",
            counters: { deaths: 0, uniques: 0 },
            objectives: ["Objectif 1", "Objectif 2", "Objectif 3"],
            events: {
                nextWorldBoss: null,
                nextLegion: null,
                nextHelltide: null
            }
        });
        writeJson(STATE_PATH, initial);
    }
}

function readJsonSafe(filePath, fallback) {
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch {
        return fallback;
    }
}

function writeJson(filePath, value) {
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function toUnixSeconds(dateIsoOrDate) {
    const d = typeof dateIsoOrDate === "string" ? new Date(dateIsoOrDate) : dateIsoOrDate;
    return Math.floor(d.getTime() / 1000);
}

function pickNextByStartTime(items, nowMs) {
    if (!Array.isArray(items)) return null;
    const next = items
        .map((x) => ({ ...x, startMs: new Date(x.startTime).getTime() }))
        .filter((x) => Number.isFinite(x.startMs) && x.startMs > nowMs)
        .sort((a, b) => a.startMs - b.startMs)[0];

    return next ?? null;
}

function formatEventForOverlay(evt, type) {
    if (!evt) return null;

    if (type === "world_boss") {
        // D’après l’API : boss + zone[] présents sur world_boss :contentReference[oaicite:1]{index=1}
        const zoneName = evt.zone?.[0]?.name ?? "";
        return {
            type: "world_boss",
            title: evt.boss ? `World Boss: ${evt.boss}` : "World Boss",
            zone: zoneName,
            startTime: evt.startTime,
            startTs: toUnixSeconds(evt.startTime)
        };
    }

    if (type === "legion") {
        return {
            type: "legion",
            title: "Légion",
            zone: "",
            startTime: evt.startTime,
            startTs: toUnixSeconds(evt.startTime)
        };
    }

    if (type === "helltide") {
        return {
            type: "helltide",
            title: "Helltide",
            zone: "",
            startTime: evt.startTime,
            startTs: toUnixSeconds(evt.startTime)
        };
    }

    return null;
}

/**
 * Import Mobalytics (build guide page).
 * On extrait :
 * - title (h1)
 * - updatedOn (texte "Updated on ...")
 * - author (souvent affiché près du header)
 * - highlights (liste "slot -> item" si on arrive à la détecter dans le texte)
 */
async function importFromMobalytics(url) {
    const res = await fetch(url, {
        headers: {
            "User-Agent": "Mozilla/5.0 (overlay-local; +OBS)"
        }
    });

    if (!res.ok) {
        throw new Error(`Mobalytics fetch failed: HTTP ${res.status}`);
    }

    const html = await res.text();
    const $ = load(html);

    const title = $("h1").first().text().trim() || "Build (Mobalytics)";
    const bodyText = $("body").text().replace(/\s+/g, " ").trim();

    // Cherche "Updated on Dec 25, 2025" (observé sur les pages build) :contentReference[oaicite:2]{index=2}
    const updatedMatch = bodyText.match(/Updated on ([A-Za-z]{3,9} \d{1,2}, \d{4})/);
    const updatedOn = updatedMatch ? updatedMatch[1] : "";

    // Auteur : souvent présent sous forme "By <name>" :contentReference[oaicite:3]{index=3}
    const authorMatch = bodyText.match(/\bBy\s+([A-Za-z0-9_ -]{2,30})\b/);
    const author = authorMatch ? authorMatch[1].trim() : "";

    // Extraction “best-effort” des items (Helm, Chest armor, etc.) si présents en texte :contentReference[oaicite:4]{index=4}
    const slots = [
        "Helm",
        "Chest armor",
        "Gloves",
        "Pants",
        "Boots",
        "Amulet",
        "Ring 1",
        "Ring 2",
        "Dual wield weapon 1",
        "Dual wield weapon 2",
        "Ranged weapon",
        "Slashing weapon",
        "Bludgeoning weapon"
    ];

    const highlights = [];
    for (const slot of slots) {
        const re = new RegExp(`${slot}\\s+([A-Za-z0-9'’\\-: ]{2,60})`, "i");
        const m = bodyText.match(re);
        if (m && m[1]) {
            // Nettoyage simple
            const item = m[1].trim();
            // Évite d’ajouter "Empty"
            if (!/^empty$/i.test(item)) {
                highlights.push(`${slot}: ${item}`);
            }
        }
    }

    return {
        source: "mobalytics",
        title,
        author,
        updatedOn,
        url,
        highlights
    };
}

ensureDirs();

const app = express();
app.use(express.json());

// Debug minimal: log des requêtes (utile derrière ngrok/Twitch)
app.use((req, res, next) => {
    const host = req.headers.host;
    const origin = req.headers.origin;
    const ua = req.headers["user-agent"];
    console.log(`[http] ${req.method} ${req.url} host=${host} origin=${origin || "-"} ua=${ua || "-"}`);
    next();
});

// Endpoint de santé (permet de vérifier rapidement qu'on parle bien au backend JSON)
app.get('/health', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, ts: Date.now() });
});

/**
 * CORS (obligatoire en hébergé Twitch)
 * - Les pages de l'extension viennent de https://<EXT_ID>.ext-twitch.tv
 * - Elles appellent ce backend (ngrok / domaine public)
 * - Avec Authorization: Bearer <JWT>, le navigateur fait un preflight OPTIONS
 */
const ALLOWED_ORIGIN_RE = /^https:\/\/[a-z0-9]+\.ext-twitch\.tv$/i;
const EXTRA_ALLOWED_ORIGINS = new Set([
    // Ajoute ici tes origines de dev si besoin
    "http://localhost:3199",
    "http://localhost:3000",
    "http://localhost:5173"
]);

function applyCors(req, res) {
    const origin = String(req.headers.origin || "").trim();
    const isAllowed = origin && (ALLOWED_ORIGIN_RE.test(origin) || EXTRA_ALLOWED_ORIGINS.has(origin));

    if (isAllowed) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type");
        res.setHeader("Access-Control-Max-Age", "86400");
    }
}

app.use((req, res, next) => {
    applyCors(req, res);
    if (req.method === "OPTIONS") {
        // Répond au preflight CORS
        return res.sendStatus(204);
    }
    next();
});

app.use("/public", express.static(PUBLIC_DIR));
app.use("/ext", express.static(PUBLIC_DIR));


/** Page overlay servie en local */
app.get("/overlay", (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, "overlay.html"));
});

/** Page admin local */
app.get("/admin", (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, "admin.html"));
});

/** Etat JSON (debug / tests) */
app.get("/state", (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const state = ensureBuildState(readJsonSafe(STATE_PATH, {}));
    res.json(state);
});

/** Import Mobalytics : /import/mobalytics?url=... */
app.get("/import/mobalytics", async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const url = decodeURIComponent(String(req.query.url || "").trim());
    if (!url.startsWith("https://mobalytics.gg/")) {
        return res.status(400).json({ error: "URL invalide (attendu: https://mobalytics.gg/...)" });
    }

    try {
        const build = await importFromMobalytics(url);
        let builds = readBuilds();
        builds.push(build);
        builds = stripPlaceholder(builds);
        writeBuilds(builds);

        const state = ensureBuildState(readJsonSafe(STATE_PATH, {}));
        state.builds = builds;
        state.currentBuildIndex = builds.length - 1;
        state.build = build;
        writeJson(STATE_PATH, state);

        broadcastState();
        return res.json({ ok: true, build });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

/** Compteurs */
app.post("/counter/deaths/inc", (req, res) => {
    const state = ensureCounters(readJsonSafe(STATE_PATH, {}));
    state.counters.deaths = (state.counters.deaths ?? 0) + 1;
    writeJson(STATE_PATH, state);
    broadcastState();
    res.json({ ok: true, deaths: state.counters.deaths });
});
app.post("/build", (req, res) => {
    const body = req.body || {};

    const build = {
        source: String(body.source ?? "manual").trim() || "manual",
        title: String(body.title ?? "").trim() || "Aucune build importée",
        author: String(body.author ?? "").trim(),
        updatedOn: String(body.updatedOn ?? "").trim(),
        url: String(body.url ?? "").trim(),
        highlights: []
    };

    let builds = readBuilds();
    builds.push(build);
    builds = stripPlaceholder(builds);
    writeBuilds(builds);

    const state = ensureBuildState(readJsonSafe(STATE_PATH, {}));
    state.builds = builds;
    state.currentBuildIndex = builds.length - 1;
    state.build = build;
    writeJson(STATE_PATH, state);

    broadcastState();
    res.json({ ok: true, build });
});
// Met à jour une build existante (par index, sinon build courante)
app.post("/build/update", (req, res) => {
    const body = req.body || {};
    const state = ensureBuildState(readJsonSafe(STATE_PATH, {}));
    let builds = stripPlaceholder(readBuilds());
    if (!builds.length) return res.status(400).json({ error: "Aucune build" });

    const idxRaw = body.index;
    const idxNum = Number(idxRaw);
    const targetIdx = Number.isFinite(idxNum)
        ? Math.min(Math.max(0, Math.trunc(idxNum)), builds.length - 1)
        : Math.min(Math.max(0, state.currentBuildIndex || 0), builds.length - 1);

    const updated = {
        source: String(body.source ?? builds[targetIdx].source ?? "manual").trim() || "manual",
        title: String(body.title ?? builds[targetIdx].title ?? "").trim() || "Aucune build importée",
        author: String(body.author ?? builds[targetIdx].author ?? "").trim(),
        updatedOn: String(body.updatedOn ?? builds[targetIdx].updatedOn ?? "").trim(),
        url: String(body.url ?? builds[targetIdx].url ?? "").trim(),
        highlights: []
    };

    builds[targetIdx] = updated;
    builds = stripPlaceholder(builds);
    writeBuilds(builds);

    state.builds = builds;
    state.currentBuildIndex = targetIdx;
    state.build = builds[targetIdx];
    writeJson(STATE_PATH, state);
    broadcastState();

    res.json({ ok: true, build: state.build, currentBuildIndex: state.currentBuildIndex, total: builds.length });
});
app.post("/counter/deaths/dec", (req, res) => {
    const state = ensureCounters(readJsonSafe(STATE_PATH, {}));
    state.counters.deaths = Math.max((state.counters.deaths ?? 0) - 1, 0);
    writeJson(STATE_PATH, state);
    broadcastState();
    res.json({ ok: true, deaths: state.counters.deaths });
});
app.post("/counter/uniques/inc", (req, res) => {
    const state = ensureCounters(readJsonSafe(STATE_PATH, {}));
    state.counters.uniques = (state.counters.uniques ?? 0) + 1;
    writeJson(STATE_PATH, state);
    broadcastState();
    res.json({ ok: true, uniques: state.counters.uniques });
});
app.post("/counter/uniques/dec", (req, res) => {
    const state = ensureCounters(readJsonSafe(STATE_PATH, {}));
    state.counters.uniques = Math.max((state.counters.uniques ?? 0) - 1, 0);
    writeJson(STATE_PATH, state);
    broadcastState();
    res.json({ ok: true, uniques: state.counters.uniques });
});

// Resets séparés
app.post("/counter/deaths/reset", (req, res) => {
    const state = ensureCounters(readJsonSafe(STATE_PATH, {}));
    state.counters.deaths = 0;
    writeJson(STATE_PATH, state);
    broadcastState();
    res.json({ ok: true, deaths: state.counters.deaths });
});

app.post("/counter/uniques/reset", (req, res) => {
    const state = ensureCounters(readJsonSafe(STATE_PATH, {}));
    state.counters.uniques = 0;
    writeJson(STATE_PATH, state);
    broadcastState();
    res.json({ ok: true, uniques: state.counters.uniques });
});

// Endpoint legacy : reset les deux (conservation pour compat).
app.post("/counter/reset", (req, res) => {
    const state = ensureCounters(readJsonSafe(STATE_PATH, {}));
    state.counters = { deaths: 0, uniques: 0 };
    writeJson(STATE_PATH, state);
    broadcastState();
    res.json({ ok: true, counters: state.counters });
});


/** Objectifs */
app.post("/objectives", (req, res) => {
    const objectives = Array.isArray(req.body?.objectives) ? req.body.objectives : null;
    if (!objectives) return res.status(400).json({ error: "Body attendu: { objectives: string[] }" });

    const state = readJsonSafe(STATE_PATH, {});
    state.objectives = objectives.map((x) => String(x));
    writeJson(STATE_PATH, state);
    broadcastState();
    res.json({ ok: true, objectives: state.objectives });
});

const server = app.listen(PORT, () => {
    console.log(`Overlay server running: http://localhost:${PORT}/overlay`);
});

const wss = new WebSocketServer({ server, path: "/ws" });

function broadcastState() {
    const state = ensureBuildState(readJsonSafe(STATE_PATH, {}));
    const payload = JSON.stringify(state);

    for (const client of wss.clients) {
        if (client.readyState === 1) client.send(payload);
    }
}

wss.on("connection", (ws) => {
    ws.send(JSON.stringify(readJsonSafe(STATE_PATH, {})));
});

/** Boucle events */
async function refreshEvents() {
    try {
        const res = await fetch(HELLTIDES_SCHEDULE_URL, {
            headers: { "User-Agent": "Mozilla/5.0 (overlay-local; +OBS)" }
        });

        if (!res.ok) throw new Error(`schedule HTTP ${res.status}`);

        const schedule = await res.json();
        const nowMs = Date.now();

        const nextWorldBoss = formatEventForOverlay(
            pickNextByStartTime(schedule.world_boss, nowMs),
            "world_boss"
        );
        const nextLegion = formatEventForOverlay(
            pickNextByStartTime(schedule.legion, nowMs),
            "legion"
        );
        const nextHelltide = formatEventForOverlay(
            pickNextByStartTime(schedule.helltide, nowMs),
            "helltide"
        );

        const state = ensureBuildState(readJsonSafe(STATE_PATH, {}));
        state.nowIso = new Date().toISOString();
        state.events = { nextWorldBoss, nextLegion, nextHelltide };
        state.builds = readBuilds();
        state.build = state.builds[state.currentBuildIndex] || defaultBuild();

        writeJson(STATE_PATH, state);
        broadcastState();
        return state;
    } catch (e) {
        // On ne crash pas : si l’API tombe, l’overlay continue d’afficher l’état précédent.
        console.warn("[events] refresh failed:", e.message);
        return null;
    }
}

// Toutes les 30s (tu peux monter à 60s si tu veux)
setInterval(refreshEvents, 30_000);
refreshEvents();

// Endpoint manuel pour forcer un refresh events
app.post("/events/refresh", async (req, res) => {
    const state = await refreshEvents();
    if (!state) return res.status(500).json({ ok: false, error: "refresh failed" });
    res.json({ ok: true, state });
});

// Navigation entre builds
app.post("/build/next", (req, res) => {
    const state = ensureBuildState(readJsonSafe(STATE_PATH, {}));
    const total = state.builds.length;
    if (!total) return res.status(400).json({ error: "Aucune build" });
    state.currentBuildIndex = (state.currentBuildIndex + 1) % total;
    state.build = state.builds[state.currentBuildIndex];
    writeJson(STATE_PATH, state);
    broadcastState();
    res.json({ ok: true, build: state.build, currentBuildIndex: state.currentBuildIndex, total });
});

app.post("/build/prev", (req, res) => {
    const state = ensureBuildState(readJsonSafe(STATE_PATH, {}));
    const total = state.builds.length;
    if (!total) return res.status(400).json({ error: "Aucune build" });
    state.currentBuildIndex = (state.currentBuildIndex - 1 + total) % total;
    state.build = state.builds[state.currentBuildIndex];
    writeJson(STATE_PATH, state);
    broadcastState();
    res.json({ ok: true, build: state.build, currentBuildIndex: state.currentBuildIndex, total });
});
app.post("/build/select", (req, res) => {
    const state = ensureBuildState(readJsonSafe(STATE_PATH, {}));
    const total = state.builds.length;
    if (!total) return res.status(400).json({ error: "Aucune build" });
    const idx = Number(req.body?.index);
    if (!Number.isFinite(idx)) return res.status(400).json({ error: "index requis" });
    const clamped = Math.min(Math.max(0, Math.trunc(idx)), total - 1);
    state.currentBuildIndex = clamped;
    state.build = state.builds[state.currentBuildIndex];
    writeJson(STATE_PATH, state);
    broadcastState();
    res.json({ ok: true, build: state.build, currentBuildIndex: state.currentBuildIndex, total });
});

// Supprime une build (par index, sinon build courante)
app.post("/build/delete", (req, res) => {
    const state = ensureBuildState(readJsonSafe(STATE_PATH, {}));
    let builds = stripPlaceholder(readBuilds());
    if (!builds.length) return res.status(400).json({ error: "Aucune build" });

    const idxRaw = req.body?.index;
    const idxNum = Number(idxRaw);
    const total = builds.length;
    const targetIdx = Number.isFinite(idxNum) ? Math.min(Math.max(0, Math.trunc(idxNum)), total - 1) : Math.min(Math.max(0, state.currentBuildIndex || 0), total - 1);

    builds.splice(targetIdx, 1);
    if (!builds.length) builds = [defaultBuild()];
    builds = stripPlaceholder(builds);
    writeBuilds(builds);

    state.builds = builds;
    state.currentBuildIndex = Math.min(targetIdx, builds.length - 1);
    state.build = builds[state.currentBuildIndex];
    writeJson(STATE_PATH, state);
    broadcastState();

    res.json({ ok: true, build: state.build, currentBuildIndex: state.currentBuildIndex, total: builds.length });
});
