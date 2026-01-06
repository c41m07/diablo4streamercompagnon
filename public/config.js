// Logique JS de la page de configuration (admin) de l'extension.
// Séparé de config.html pour se conformer au CSP de Twitch.

// Base API (EBS)
// - En local : on reste en relatif (""), donc /state pointe sur http://localhost:3199/state.
// - En hébergé Twitch : on pointe vers ton EBS (ngrok ou domaine public).
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

// Jeton JWT fourni par Twitch
let twitchToken = '';
if (window.Twitch && Twitch.ext) {
    Twitch.ext.onAuthorized(function (auth) {
        twitchToken = auth.token;
    });
}

// Affiche un message dans l'élément #notice
function notify(message, type = 'info') {
    const notice = document.getElementById('notice');
    if (!notice) return;
    notice.textContent = message;
    notice.style.color = type === 'error' ? '#d00' : '#090';
    setTimeout(() => {
        if (notice.textContent === message) notice.textContent = '';
    }, 3000);
}

async function diagApi() {
    try {
        const url = `${API_BASE}/health`;
        const res = await fetch(url, { method: 'GET' });
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        if (ct.includes('application/json')) {
            await res.json();
            notify(`API OK (${API_BASE || 'relatif'})`, 'success');
            return;
        }
        const text = await res.text();
        notify(`API KO (${API_BASE || 'relatif'}) : content-type=${ct || '??'} ; aperçu=${text.slice(0, 80)}`, 'error');
    } catch (e) {
        notify(`API KO (${API_BASE || 'relatif'}) : ${e.message}`, 'error');
    }
}

// Appel API générique avec token JWT
function api(path, options = {}) {
    const opts = { ...options };
    opts.headers = { ...opts.headers };
    if (twitchToken) {
        opts.headers['Authorization'] = 'Bearer ' + twitchToken;
    }
    const url = `${API_BASE}${path}`;
    return fetch(url, opts);
}

async function postJson(path, body) {
    const res = await api(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
    });
    try {
        return await safeJson(res);
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

async function loadState() {
    const res = await api('/state');
    return safeJson(res);
}

function linesToArray(text) {
    return text.split('\n').map((s) => s.trim()).filter(Boolean);
}

function arrayToLines(arr) {
    return (arr || []).join('\n');
}

// Ouvre l'overlay dans un nouvel onglet (panel ou overlay).  En local, /overlay existe
// sur le même domaine.  En hébergé, ce chemin ne sera pas disponible ; vous pouvez
// désactiver ce bouton ou changer pour afficher votre overlay via une URL publique.
document.addEventListener('DOMContentLoaded', () => {
    // Diagnostic au chargement
    diagApi();

    // La sandbox Twitch bloque alert()/confirm(). On remplace la confirmation par un "double-clic".
    let deleteArmedUntil = 0;
    const openBtn = document.getElementById('btnOpenOverlay');
    if (openBtn) {
        openBtn.onclick = () => {
            const url = API_BASE ? `${API_BASE}/overlay` : '/overlay';
            window.open(url, '_blank');
        };
    }

    document.getElementById('btnImport').onclick = async () => {
        const url = document.getElementById('mobUrl').value.trim();
        if (!url) {
            notify('Colle une URL Mobalytics.', 'error');
            return;
        }
        try {
            const res = await api(`/import/mobalytics?url=${encodeURIComponent(url)}`);
            const json = await safeJson(res);
            if (!json.ok) throw new Error(json.error || 'Erreur inconnue');
            notify('Import OK !', 'success');
        } catch (e) {
            notify('Import KO : ' + e.message, 'error');
        }
    };

    // Compteurs
    document.getElementById('dInc').onclick = () => api('/counter/deaths/inc', { method: 'POST' });
    document.getElementById('dDec').onclick = () => api('/counter/deaths/dec', { method: 'POST' });
    document.getElementById('uInc').onclick = () => api('/counter/uniques/inc', { method: 'POST' });
    document.getElementById('uDec').onclick = () => api('/counter/uniques/dec', { method: 'POST' });
    document.getElementById('cResetDeaths').onclick = () => api('/counter/deaths/reset', { method: 'POST' });
    document.getElementById('cResetUniques').onclick = () => api('/counter/uniques/reset', { method: 'POST' });

    // Sauvegarde de la build courante
    document.getElementById('btnSaveBuild').onclick = async () => {
        const state = await loadState();
        const current = Number(state.currentBuildIndex ?? 0);
        const body = {
            index: current,
            source: document.getElementById('bSource').value.trim(),
            title: document.getElementById('bTitle').value.trim(),
            author: document.getElementById('bAuthor').value.trim(),
            updatedOn: document.getElementById('bUpdated').value.trim(),
            url: document.getElementById('bUrl').value.trim()
        };
        const json = await postJson('/build/update', body);
        if (!json.ok) {
            notify('Enregistrement de la build KO', 'error');
            return;
        }
        await loadAndFill();
        notify('Build mise à jour !', 'success');
    };

    async function loadAndFill(index) {
        const state = await loadState();
        const builds = state.builds || [];
        const current = Number(state.currentBuildIndex ?? 0);
        const total = builds.length || 1;
        const idx = Number.isFinite(index) ? index : current;
        const clamped = Math.min(Math.max(0, idx), total - 1);
        const b = builds[clamped] || {};
        document.getElementById('bIndex').textContent = `${clamped + 1}/${total}`;
        document.getElementById('bTitleLabel').textContent = b.title || '';
        document.getElementById('bSource').value = b.source || '';
        document.getElementById('bTitle').value = b.title || '';
        document.getElementById('bAuthor').value = b.author || '';
        document.getElementById('bUpdated').value = b.updatedOn || '';
        document.getElementById('bUrl').value = b.url || '';
        document.getElementById('objText').value = arrayToLines(state.objectives);
    }

    async function navBuild(dir) {
        const path = dir === 'next' ? '/build/next' : '/build/prev';
        await postJson(path, {});
        await loadAndFill();
    }

    document.getElementById('bPrev').onclick = () => navBuild('prev');
    document.getElementById('bNext').onclick = () => navBuild('next');

    document.getElementById('bDelete').onclick = async () => {
        const state = await loadState();
        const current = Number(state.currentBuildIndex ?? 0);
        const total = (state.builds || []).length;
        if (!total) {
            notify('Aucune build à supprimer', 'error');
            return;
        }
        const now = Date.now();
        if (now > deleteArmedUntil) {
            deleteArmedUntil = now + 5000;
            notify(`Clique une 2e fois sur "Supprimer" pour confirmer (5s) — build #${current + 1}/${total}.`, 'info');
            return;
        }
        deleteArmedUntil = 0;
        const json = await postJson('/build/delete', { index: current });
        if (!json.ok) {
            notify('Suppression KO', 'error');
            return;
        }
        await loadAndFill();
        notify('Build supprimée.', 'success');
    };

    // Sauvegarde des objectifs
    document.getElementById('btnSaveObj').onclick = async () => {
        const objectives = linesToArray(document.getElementById('objText').value);
        const json = await postJson('/objectives', { objectives });
        if (!json.ok) {
            notify('Enregistrement des objectifs KO', 'error');
            return;
        }
        notify('Objectifs enregistrés !', 'success');
    };

    // Chargement depuis l'état
    document.getElementById('btnLoadState').onclick = async () => {
        await loadAndFill();
        notify('Formulaire rempli depuis /state.', 'success');
    };

    // Chargement initial de la build courante
    loadAndFill();
});