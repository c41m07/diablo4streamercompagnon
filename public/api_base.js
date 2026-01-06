// Configuration runtime de l'API (EBS)
//
// Objectif :
// - En local (http://localhost:3199), on laisse vide pour appeler en relatif (/state, /import, ...)
// - En hébergé (Twitch Hosted), on appelle le backend Render (HTTPS stable)

(() => {
  const host = (window.location && window.location.hostname) ? window.location.hostname : '';
  const isLocal = host === 'localhost' || host === '127.0.0.1';
  window.API_BASE = isLocal ? '' : 'https://diablo4streamercompagnon.onrender.com';
})();