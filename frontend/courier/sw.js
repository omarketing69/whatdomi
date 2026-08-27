// Service worker mínimo: solo lo necesario para que la PWA sea instalable
// en celulares de gama baja. No implementa estrategias de caché elaboradas
// (el flujo de ofertas/ubicación necesita red igual, no tiene sentido
// cachear esas respuestas).
const CACHE_NAME = "whatdomi-courier-shell-v2";
// Los modelos de face-api.js (../vendor/face-api/models/*, varios MB)
// deliberadamente NO están en el shell: se piden bajo demanda la primera
// vez que se usa la cámara, no en cada instalación de la PWA.
const SHELL_FILES = [
  "./",
  "./index.html",
  "./app.js",
  "./face.js",
  "./manifest.webmanifest",
  "../styles.css",
  "../vendor/face-api/face-api.min.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
