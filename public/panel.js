// Logique front-end pour le panneau et le composant vidéo de l'extension Diablo 4.
// Ce fichier est chargé via <script src="panel.js"> dans panel.html et video_component.html.
// Les scripts inline sont interdits en environnement hébergé, d'où ce fichier séparé.

// URL de base de l'API backend (EBS).
// - En local : on reste en relatif (""), donc /state pointe sur http://localhost:3199/state.
// - En hébergé Twitch : on pointe vers ton EBS (ngrok ou domaine public).
//
// IMPORTANT : pas de scripts inline en hébergé, donc on autodétecte avec le hostname.
const API_BASE = (() => {
    if (typeof window.API_BASE === 'string' && window.API_BASE.trim()) {
        return window.API_BASE.trim().replace(/\/$/, '');
    }
    return '';
})();

async function safeJson(res) {
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('application/json')) {
        const text = await res.text();
        const head = text.slice(0, 400).toLowerCase();
        const looksLikeHtml = head.includes('<!doctype html') || head.includes('<html');
        const looksLikeNgrokInterstitial = looksLikeHtml && (head.includes('ngrok') || head.includes('cdn.ngrok.com') || head.includes('abuse_interstitial'));
        if (looksLikeNgrokInterstitial) {
            throw new Error(
                `Le backend a renvoyé une page HTML ngrok (interstitial). ` +
                `Ton tunnel ngrok free est probablement filtré/bloqué. ` +
                `Solution : héberger l'EBS sur un serveur/domaine stable, ou utiliser un domaine ngrok réservé. ` +
                `Aperçu: ${text.slice(0, 140)}`
            );
        }
        throw new Error(`Réponse non JSON (${res.status}) : ${text.slice(0, 140)}`);
    }
    return res.json();
}

// Récupération du token JWT via la bibliothèque Twitch Extension Helper.
let twitchToken = '';
if (window.Twitch && Twitch.ext) {
    Twitch.ext.onAuthorized(function (auth) {
        twitchToken = auth.token;
    });
}

// Utilitaires DOM
const el = (id) => document.getElementById(id);
const setText = (id, value) => {
    const node = el(id);
    if (node) node.textContent = value;
};

function pad2(n) {
    return String(n).padStart(2, '0');
}

// Formate un compte à rebours à partir d'un timestamp (en secondes).  Retourne "0:00" si terminé.
function formatCountdown(targetTs) {
    if (!targetTs || !Number.isFinite(targetTs)) return '—';
    const now = Math.floor(Date.now() / 1000);
    const diff = targetTs - now;
    if (diff <= 0) return '0:00';
    const h = Math.floor(diff / 3600);
    const m = Math.floor((diff % 3600) / 60);
    const s = diff % 60;
    if (h > 0) return `${h}:${pad2(m)}:${pad2(s)}`;
    return `${m}:${pad2(s)}`;
}

// État courant
let currentState = null;
let lastMinuteKey = '';

function renderStatic(state) {
    const build = state.build || {};
    setText('buildTitle', build.title || '—');
    setText('buildSource', build.source || '—');
    setText('buildAuthor', build.author || 'Inconnu');
    setText('buildUpdated', build.updatedOn || '—');

    const total = Array.isArray(state.builds) ? state.builds.length : 1;
    const idx = Number(state.currentBuildIndex ?? 0) + 1;
    setText('buildNavLabel', `${Math.min(idx, total)}/${total}`);
    const prevBtn = el('buildPrev');
    const nextBtn = el('buildNext');
    const disabled = total <= 1;
    if (prevBtn) prevBtn.disabled = disabled;
    if (nextBtn) nextBtn.disabled = disabled;

    const link = el('buildUrl');
    if (link) {
        const url = build.url || '';
        if (url) {
            link.href = url;
            link.textContent = url;
            link.style.display = 'inline-block';
        } else {
            link.href = '#';
            link.textContent = '—';
            link.style.display = 'none';
        }
    }

    const obj = el('objectives');
    if (obj) {
        obj.innerHTML = '';
        (state.objectives || []).forEach((line) => {
            const li = document.createElement('li');
            li.textContent = line;
            obj.appendChild(li);
        });
    }

    setText('deaths', String(state.counters?.deaths ?? 0));
    setText('uniques', String(state.counters?.uniques ?? 0));

    const ev = state.events || {};
    const wb = ev.nextWorldBoss;
    const leg = ev.nextLegion;
    const ht = ev.nextHelltide;
    setText('wbLabel', wb?.title ? wb.title + (wb.zone ? ` (${wb.zone})` : '') : 'World Boss');
    setText('legLabel', leg?.title || 'Légion');
    setText('htLabel', ht?.title || 'Helltide');
}

function updateCountdowns() {
    if (!currentState) return;
    const ev = currentState.events || {};
    setText('wbTime', formatCountdown(ev.nextWorldBoss?.startTs));
    setText('legTime', formatCountdown(ev.nextLegion?.startTs));
    setText('htTime', formatCountdown(ev.nextHelltide?.startTs));
}

function updateClockIfNeeded() {
    const d = new Date();
    const minuteKey = `${d.getHours()}-${d.getMinutes()}`;
    if (minuteKey === lastMinuteKey) return;
    lastMinuteKey = minuteKey;
    setText('clock', `${pad2(d.getHours())}:${pad2(d.getMinutes())}`);
}

function applyState(state) {
    currentState = state;
    renderStatic(state);
    updateCountdowns();
}

// Fonction de navigation entre les builds.
async function nav(dir) {
    try {
        await fetch(`${API_BASE}/build/${dir}`, {
            method: 'POST',
            headers: twitchToken ? { 'Authorization': 'Bearer ' + twitchToken } : {}
        });
        // Récupère l'état mis à jour et l'applique immédiatement
        const res = await fetch(`${API_BASE}/state`);
        const state = await safeJson(res);
        applyState(state);
    } catch {
        // ignore les erreurs réseau
    }
}

// Attache les handlers de navigation après le chargement du DOM
document.addEventListener('DOMContentLoaded', () => {
    const prevBtn = el('buildPrev');
    const nextBtn = el('buildNext');
    if (prevBtn) prevBtn.onclick = () => nav('prev');
    if (nextBtn) nextBtn.onclick = () => nav('next');
});

// Tick du compte à rebours toutes les secondes
setInterval(updateCountdowns, 1000);
// Mise à jour de l'horloge interne toutes les secondes
updateClockIfNeeded();
setInterval(updateClockIfNeeded, 1000);

// Ouverture du WebSocket pour mises à jour en temps réel.
// NOTE: les tunnels ngrok free peuvent déclencher un interstitial (HTML) sous charge.
// En hébergé Twitch, on coupe le WS par défaut et on préfère un polling plus lent.
let wsOk = false;
const IS_TWITCH_HOSTED = window.location.hostname.endsWith('.ext-twitch.tv');
(() => {
    if (IS_TWITCH_HOSTED) {
        wsOk = false;
        return;
    }
    let url;
    if (API_BASE) {
        // Convertit l'URL API en URL WS : https://example.com -> wss://example.com
        url = API_BASE.replace(/^https?:/, function (match) {
            return match === 'https:' ? 'wss:' : 'ws:';
        }) + '/ws';
    } else {
        url = 'ws://' + window.location.host + '/ws';
    }
    try {
        const ws = new WebSocket(url);
        ws.onmessage = (msg) => {
            wsOk = true;
            try {
                applyState(JSON.parse(msg.data));
            } catch {}
        };
        ws.onerror = () => { wsOk = false; };
        ws.onclose = () => { wsOk = false; };
    } catch {
        wsOk = false;
    }
})();

// Fallback polling si le WebSocket ne fonctionne pas
setInterval(async () => {
    if (wsOk) return;
    try {
        const res = await fetch(`${API_BASE}/state`);
        applyState(await safeJson(res));
    } catch {
        // ignore
    }
}, IS_TWITCH_HOSTED ? 10_000 : 3_000);

// Chargement initial de l'état
(async () => {
    try {
        const res = await fetch(`${API_BASE}/state`);
        applyState(await safeJson(res));
    } catch {
        // ignore
    }
})();