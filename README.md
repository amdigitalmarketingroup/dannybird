# Danny Bird 🐦

Clon de Flappy Bird, mobile-first, donde el personaje es **Danny** (una carita con
alitas) en vez del pájaro. HTML5 + Canvas en JavaScript vanilla. PWA instalable,
jugable offline, con SFX y música de fondo sintetizados (sin archivos de audio).

**Live:** https://dannybird.25ocho.agency

---

## Cómo correr en local

No hay build. Solo necesitas servir la carpeta por HTTP (el service worker y el
manifest no funcionan con `file://`):

```bash
cd flappy-face
python3 -m http.server 8080
# abre http://localhost:8080
```

Cualquier server estático sirve (`npx serve`, `php -S`, etc.).

## Controles

- **Tap / click / Espacio / ↑ / W** = volar (impulso hacia arriba).
- Esquiva los tubos. Chocar con tubo o suelo = game over. El techo no mata (topa).
- Botón de **mute** arriba a la derecha (silencia música + efectos; se recuerda).
- El **best score** se guarda en `localStorage`.

## Personaje y feedback

El personaje es **`assets/player_bombita.png`** (la niña hecha bolita, perfil
mirando a la derecha, sin alas, fondo transparente). El impulso es un **pedo**:
en cada tap se suelta `assets/fart_puff.png` por detrás-abajo (escala + fade en
~340ms), suena un SFX de pedo sintetizado y el cuerpo hace squash-and-stretch.
La física (gravedad, impulso, gap, velocidad) es idéntica a la versión clásica.

Para cambiar el personaje:

1. Reemplaza `assets/player_bombita.png` por tu PNG (fondo transparente, mirando a
   la derecha). Cualquier proporción sirve; el juego lo escala manteniendo el aspecto.
2. (Opcional) Cambia `assets/fart_puff.png` por otra partícula de impulso.
3. Si cambiaste assets, sube el número de versión del cache en `sw.js`
   (`const CACHE = 'dannybird-vN'`) para invalidar la versión vieja.

Si el sprite no carga, el juego dibuja una carita procedural de respaldo (no rompe).

## Física (fiel al Flappy original, tuneada por feel)

Constantes en `game.js`, en unidades de un mundo de referencia de 640px de alto,
escaladas al tamaño real de pantalla (mismo feel en cualquier celular):

| Constante | Valor | Qué es |
|---|---|---|
| `GRAVITY` | 1500 px/s² | gravedad |
| `FLAP_V` | -430 px/s | impulso del tap |
| `MAX_FALL` | 560 px/s | tope de caída |
| `PIPE_SPEED` | 150 px/s | velocidad de tubos |
| `PIPE_GAP` | 178 px | hueco entre tubos |
| `PIPE_SPACING` | 232 px | separación horizontal |

Loop con **fixed timestep a 60Hz** (acumulador) → física determinista, idéntica en
pantallas de 60/90/120Hz. Input en `pointerdown`/`keydown` directo (sin esperar al
frame) + `touch-action:none` → latencia mínima entre control y gameplay.

## Deploy (Hostinger)

Sitio 100% estático. Subir el contenido de la carpeta al docroot del subdominio
`dannybird.25ocho.agency`. El `.htaccess` ya trae los headers de cache correctos
(SW sin cache, HTML revalidado, assets con cache largo). No hace falta build.

## Estructura

```
flappy-face/
├── index.html              # markup + meta PWA + registro del SW
├── style.css               # full-bleed, mobile-first, sin latencia de gestos
├── game.js                 # juego completo (física, render, audio, input)
├── manifest.webmanifest    # PWA instalable
├── sw.js                   # service worker (cache offline)
├── .htaccess               # headers de cache para Hostinger
├── assets/
│   └── player.png          # ← el sprite del personaje (reemplazable)
└── icons/                  # iconos PWA (192, 512, apple-touch, favicon)
```

## Scoreboard global (ranking)

Backend propio en el VPS (NO Supabase — para no mezclar con datos del negocio),
aislado y autocontenido:

- **`server/server.mjs`** — mini-API Node (módulo `node:http` + `node:sqlite`). Guarda
  los scores en un archivo SQLite propio (`scores.db`). Endpoints:
  - `GET /api/scores?limit=10` → top scores.
  - `POST /api/scores` `{name, score}` → inserta (nombre sanitizado a ≤5 A-Z0-9, score 0..100000),
    devuelve `{rank, scores}`. Rate-limit 20/min por IP.
- Corre con **pm2** (`dannybird-api`) en `172.18.0.1:3210` (solo bridge, no público).
- **Traefik** lo enruta en `https://dannybird.25ocho.agency/api` (mismo origen que el
  juego → sin CORS) vía `/root/traefik-dynamic/dannybird-api.yml` (priority 200 sobre el static).
- ufw: `allow from 172.18.0.0/16 to any port 3210`.

El juego (`game.js`) usa rutas relativas `/api/scores`. En game over: entrada de nombre
(5 chars) → POST → muestra el ranking global con tu lugar resaltado. El nombre se
recuerda en `localStorage`.

### Re-deploy del backend
```bash
cp server/server.mjs ~/projects/dannybird-api/server.mjs
pm2 restart dannybird-api
```
