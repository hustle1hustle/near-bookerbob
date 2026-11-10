// Cross-origin isolation for prove.html on a host that cannot send headers (GitHub Pages).
// Threads in wasm need SharedArrayBuffer, which a page only gets when it is served with
// Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy. This service worker adds them
// to the responses it relays. The pattern is the well known coi-serviceworker one
// (Guido Zuidhof, https://github.com/gzuidhof/coi-serviceworker); this file is our own code.
//
// It touches nothing but prove.html and the files under prove/: prove.html registers it with
// the scope "prove", so the browser never hands it board.html, swarm.html or any other page,
// and the handler checks the path again before it answers. It stores nothing and sends nothing.
const base = new URL("./", self.location).pathname;
const ours = (url) => url.origin === self.location.origin && (url.pathname === `${base}prove.html` || url.pathname.startsWith(`${base}prove/`));

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || !ours(new URL(request.url))) return;
  if (request.cache === "only-if-cached" && request.mode !== "same-origin") return;
  event.respondWith(
    fetch(request).then((response) => {
      if (response.status === 0) return response;
      const headers = new Headers(response.headers);
      headers.set("Cross-Origin-Opener-Policy", "same-origin");
      headers.set("Cross-Origin-Embedder-Policy", "require-corp");
      headers.set("Cross-Origin-Resource-Policy", "same-origin");
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }),
  );
});
