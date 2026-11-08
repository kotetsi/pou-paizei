// Cloudflare Worker: proxy για το TMDB API του site «Πού Παίζει».
// Κρατάει το TMDB token κρυφό. Το token μπαίνει στο Cloudflare ως Secret με όνομα TMDB_TOKEN
// (Worker → Settings → Variables and Secrets → Add → Type: Secret).

// Ποια sites επιτρέπεται να χρησιμοποιούν τον proxy. Όταν βρεις domain, βάλε το εδώ,
// π.χ. ["https://poupaizei.gr", "https://ONOMA.github.io"]
const ALLOWED_ORIGINS = ["*"];

// Μόνο οι κλήσεις που χρειάζεται το site
const ALLOWED_PATHS = /^((search|discover)\/(movie|tv)|(movie|tv)\/\d+(\/watch\/providers|\/videos)?|watch\/providers\/(movie|tv))$/;

// Πόση ώρα κρατάμε τα αποτελέσματα στο cache (12 ώρες)
const CACHE_SECONDS = 43200;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const allowOrigin = ALLOWED_ORIGINS.includes("*")
      ? "*"
      : (ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
    const cors = { "Access-Control-Allow-Origin": allowOrigin, "Vary": "Origin" };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: { ...cors, "Access-Control-Allow-Methods": "GET", "Access-Control-Max-Age": "86400" } });
    }
    if (request.method !== "GET") return json({ error: "Επιτρέπεται μόνο GET" }, 405, cors);
    if (!env.TMDB_TOKEN) return json({ error: "Λείπει το TMDB_TOKEN από τις ρυθμίσεις του Worker" }, 500, cors);

    const path = url.searchParams.get("path") || "";
    if (!ALLOWED_PATHS.test(path)) return json({ error: "Μη επιτρεπτή κλήση" }, 400, cors);

    const params = new URLSearchParams(url.searchParams);
    params.delete("path");
    params.sort();
    const target = `https://api.themoviedb.org/3/${path}?${params.toString()}`;

    const cache = caches.default;
    const cacheKey = new Request(target);
    let res = await cache.match(cacheKey);
    if (!res) {
      const r = await fetch(target, {
        headers: { Authorization: `Bearer ${env.TMDB_TOKEN}`, Accept: "application/json" },
      });
      if (!r.ok) return json({ error: "Το TMDB δεν απάντησε", status: r.status }, 502, cors);
      res = new Response(r.body, {
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${CACHE_SECONDS}` },
      });
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
    }

    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    return out;
  },
};

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
  });
}
