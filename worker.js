// Cloudflare Worker: proxy για το TMDB API του site «Πού Παίζει».
// Κρατάει το TMDB token κρυφό. Το token μπαίνει στο Cloudflare ως Secret με όνομα TMDB_TOKEN
// (Worker → Settings → Variables and Secrets → Add → Type: Secret).
// Προαιρετικά: OMDB_API_KEY, για πραγματικές βαθμολογίες IMDb μέσω OMDb.

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
    const imdbMovie = /^imdb\/movie\/([1-9]\d*)$/.exec(path);
    if (imdbMovie) {
      if (!env.OMDB_API_KEY) return json({error:"Δεν έχει ρυθμιστεί η σύνδεση IMDb",code:"IMDB_NOT_CONFIGURED"},503,cors);
      return imdbRating(imdbMovie[1],env,ctx,cors,url.origin);
    }
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

async function imdbRating(movieId, env, ctx, cors, origin) {
  // Το κλειδί OMDb δεν επιστρέφεται στον browser και δεν μπαίνει στο cache key.
  const cache = caches.default;
  const cacheKey = new Request(`${origin}/cache/imdb-v1/movie/${movieId}`);
  const cached = await cache.match(cacheKey);
  if (cached) {
    const out = new Response(cached.body,cached);
    for (const [key,value] of Object.entries(cors)) out.headers.set(key,value);
    return out;
  }
  try {
    const detailsResponse = await fetch(`https://api.themoviedb.org/3/movie/${movieId}`,{
      headers:{Authorization:`Bearer ${env.TMDB_TOKEN}`,Accept:"application/json"},
    });
    if (!detailsResponse.ok) return json({error:"Δεν φορτώθηκαν τα στοιχεία ταινίας"},502,cors);
    const details = await detailsResponse.json();
    const imdbId = details.imdb_id;
    let rating = null;
    if (imdbId) {
      if (!/^tt\d+$/.test(imdbId)) return json({error:"Μη έγκυρο αναγνωριστικό IMDb"},502,cors);
      const omdbUrl = new URL("https://www.omdbapi.com/");
      omdbUrl.search = new URLSearchParams({apikey:env.OMDB_API_KEY,i:imdbId,r:"json"});
      const upstream = await fetch(omdbUrl.toString(),{headers:{Accept:"application/json"}});
      if (!upstream.ok) return json({error:"Το OMDb δεν απάντησε"},502,cors);
      const data = await upstream.json();
      // Quota / invalid-key errors must not masquerade as an unrated title.
      if (data.Response === "False") {
        if (data.Error !== "Movie not found!") return json({error:"Δεν είναι διαθέσιμες οι βαθμολογίες IMDb",code:"IMDB_UPSTREAM_ERROR"},502,cors);
      } else {
        if (data.Response !== "True" || data.imdbID !== imdbId) return json({error:"Μη έγκυρη απάντηση OMDb"},502,cors);
        if (data.imdbRating !== "N/A" && data.imdbRating != null) {
          const parsed = Number(data.imdbRating);
          if (String(data.imdbRating).trim() === "" || !Number.isFinite(parsed) || parsed < 0 || parsed > 10) return json({error:"Μη έγκυρη βαθμολογία IMDb"},502,cors);
          rating = parsed;
        }
      }
    }
    const body = {source:"IMDb",imdb_id:imdbId || null,rating};
    // Cache only data; attach CORS to each response for its current origin.
    const response = json(body,200,{"Cache-Control":`public, max-age=${CACHE_SECONDS}`});
    ctx.waitUntil(cache.put(cacheKey,response.clone()));
    const out = new Response(response.body,response);
    for (const [key,value] of Object.entries(cors)) out.headers.set(key,value);
    return out;
  } catch {
    return json({error:"Δεν φορτώθηκε η βαθμολογία IMDb"},502,cors);
  }
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
  });
}
