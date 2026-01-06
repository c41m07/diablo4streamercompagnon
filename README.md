# Twitch extension – Backend (EBS) + UI

Ce dépôt contient :
- un backend Node/Express (`server.mjs`) utilisé comme **EBS** (Extension Backend Service)
- des pages front dans `public/` (panel, video component, config, live config)

## Pourquoi ça cassait avec ngrok free
En mode Hosted Twitch, ngrok free peut renvoyer une **page HTML interstitielle** (content-type `text/html`) au lieu de forwarder vers ton backend. Le front attend du JSON → erreur « Réponse non JSON ».

La solution fiable est d’héberger le backend sur une URL HTTPS stable (Render/Railway/Fly/VPS) ou d’utiliser ngrok avec domaine réservé.

## Démarrage en local
```bash
npm install
npm start
```
Backend local: http://localhost:3199/health

## Déploiement sur Render (recommandé)
1. Pousser le code sur GitHub.
2. Render → **New** → **Web Service** → sélectionner le repo.
3. Renseigner :
   - Build Command: `npm install`
   - Start Command: `npm start`
4. Une URL est fournie (ex: `https://ton-service.onrender.com`).

### Configurer le front (API_BASE)
La configuration est centralisée dans :
- `public/api_base.js`

Par défaut :
- en local (`localhost`), `API_BASE` reste vide (`""`) pour appeler en relatif.
- en hébergé, `API_BASE` pointe vers Render.

Si tu changes d’URL Render, modifie uniquement `public/api_base.js`.

## Regénérer public.zip
Sous Windows PowerShell :
```powershell
$src='public\*'
$dst='public.zip'
if (Test-Path $dst) { Remove-Item $dst -Force }
Compress-Archive -Path $src -DestinationPath $dst -Force
```