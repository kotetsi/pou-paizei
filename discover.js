/* Ανακάλυψη ταινιών: οι βαθμολογίες IMDb δεν αντικαθίστανται ποτέ με TMDB. */
(() => {
  const ACCESS = {all:["flatrate","free","ads","rent","buy"], stream:["flatrate","free","ads"], free:["free","ads"]};

  function filtersFrom(values) {
    const from = values.from === "" ? null : Number(values.from);
    const to = values.to === "" ? null : Number(values.to);
    for (const year of [from,to]) {
      if (year !== null && (!Number.isInteger(year) || year < 1874 || year > 2100)) throw new Error("Βάλε έγκυρα έτη από το 1874 έως το 2100.");
    }
    if (from !== null && to !== null && from > to) throw new Error("Το αρχικό έτος πρέπει να είναι μικρότερο ή ίσο με το τελικό.");
    const text = String(values.rating).trim().replace(",", ".");
    const rating = Number(text);
    if (!/^\d+(\.\d+)?$/.test(text) || !Number.isFinite(rating) || rating < 0 || rating >= 10) throw new Error("Βάλε όριο βαθμολογίας από 0 έως 9,9 (π.χ. 7,5).");
    if (!["imdb","tmdb"].includes(values.source) || !ACCESS[values.access]) throw new Error("Διάλεξε πηγή βαθμολογίας και τρόπο προβολής.");
    return {...values,from,to,rating};
  }

  function discoverParams(filters, page) {
    const params = {language:"el-GR",sort_by:"popularity.desc",include_adult:"false",include_video:"false",page};
    if (filters.genre) params.with_genres = filters.genre;
    if (filters.from !== null) params["primary_release_date.gte"] = `${filters.from}-01-01`;
    if (filters.to !== null) params["primary_release_date.lte"] = `${filters.to}-12-31`;
    // IMDb και TMDB έχουν διαφορετικά εκλογικά σώματα: όχι προφίλτρο TMDB για IMDb.
    if (filters.source === "tmdb") {
      params["vote_average.gte"] = filters.rating;
      // Χωρίς ελάχιστο αριθμό ψήφων, μια ταινία με 2 ψήφους και μέσο όρο 10 θα περνούσε το φίλτρο.
      params["vote_count.gte"] = 50;
    }
    return params;
  }

  function availability(providers, locals, access) {
    const selected = Object.fromEntries(ACCESS[access].filter(key => providers?.[key]?.length).map(key => [key, providers[key]]));
    const greek = locals.filter(p => ACCESS[access].includes(p.type));
    return {providers:selected,greek,available:!!(Object.keys(selected).length || greek.length)};
  }

  function passesRating(value, minimum) {
    return typeof value === "number" && Number.isFinite(value) && value > minimum && value <= 10;
  }

  if (typeof module !== "undefined") module.exports = {filtersFrom,discoverParams,availability,passesRating};
  if (typeof document === "undefined") return;

  const form = $("#d-form"), status = $("#d-status"), results = $("#d-results"), more = $("#d-more");
  let generation = 0, state = null, busy = false;
  const ratingCache = new Map();

  async function imdb(id) {
    if (ratingCache.has(id)) return ratingCache.get(id);
    const response = await fetch(PROXY_URL + "?" + new URLSearchParams({path:`imdb/movie/${id}`}));
    const data = await response.json();
    if (!response.ok) {
      if (data.code === "IMDB_NOT_CONFIGURED" || response.status === 400) throw new Error("Η σύνδεση IMDb δεν έχει ενεργοποιηθεί ακόμη. Χρειάζεται ενημέρωση του Worker και κλειδί OMDb. Μπορείς να επιλέξεις βαθμολογία TMDB.");
      throw new Error("Δεν φορτώθηκαν οι βαθμολογίες IMDb. Δοκίμασε ξανά σε λίγο.");
    }
    if (data.source !== "IMDb" || !(data.rating === null || (typeof data.rating === "number" && data.rating >= 0 && data.rating <= 10))) throw new Error("Δεν ήταν έγκυρη η απάντηση βαθμολογίας IMDb. Δοκίμασε ξανά.");
    ratingCache.set(id,data);
    return data;
  }

  function summary() {
    let text = `${state.matches} προτάσεις · ελέγχθηκαν ${state.checked} ταινίες.`;
    if (state.unknown) text += ` ${state.unknown} χωρίς διαθέσιμη βαθμολογία ${state.filters.source.toUpperCase()}.`;
    if (!state.matches) text += state.next <= state.pages
      ? " Δεν βρέθηκε ακόμη ταινία με αυτά τα κριτήρια. Έλεγξε περισσότερες ή άλλαξε τα φίλτρα."
      : " Δεν βρέθηκε ταινία με αυτά τα κριτήρια. Δοκίμασε μεγαλύτερο εύρος ετών ή χαμηλότερο όριο βαθμολογίας.";
    return text;
  }

  async function loadPage(token) {
    if (busy || !state) return;
    busy = true;
    more.disabled = true;
    form.querySelector("button[type=submit]").disabled = true;
    results.setAttribute("aria-busy","true");
    const current = state;
    status.textContent = "Αναζήτηση ταινιών και έλεγχος διαθεσιμότητας στην Ελλάδα…";
    try {
      await greekReady;
      const data = await tmdb("discover/movie",discoverParams(current.filters,current.next));
      if (token !== generation) return;
      const items = (data.results || []).map(norm);
      const cards = [];
      let unknown = 0;
      // Μικρές ομάδες κλήσεων για να μην υπερφορτώνεται ο proxy ή το OMDb.
      for (let offset=0;offset<items.length;offset+=4) {
        const batch = await Promise.all(items.slice(offset,offset+4).map(async movie => {
          const providers = await tmdb(`movie/${movie.id}/watch/providers`);
          const gr = providers.results?.[REGION];
          const allowed = availability(gr,greekFor("movie",movie.id),current.filters.access);
          if (current.filters.available && !allowed.available) return null;
          const rating = current.filters.source === "imdb"
            ? (await imdb(movie.id)).rating
            : (movie.vote_count > 0 ? movie.vote_average : null);
          if (rating === null || rating === undefined) { unknown++; return null; }
          if (!passesRating(rating,current.filters.rating)) return null;
          const label = `${current.filters.source.toUpperCase()} ${rating.toLocaleString("el-GR",{maximumFractionDigits:3})}/10`;
          return card({...movie,ratingLabel:label,availabilityText:"Δεν βρέθηκε διαθέσιμη επιλογή με αυτόν τον τρόπο προβολής στην Ελλάδα."},allowed.providers,gr?.link,"movie",allowed.greek);
        }));
        if (token !== generation) return;
        cards.push(...batch.filter(Boolean));
        status.textContent = `Έλεγχος ταινιών… ${Math.min(offset+4,items.length)}/${items.length} σε αυτή τη σελίδα.`;
      }
      current.pages = Math.min(data.total_pages || 0,500);
      current.next++;
      current.matches += cards.length;
      current.checked += items.length;
      current.unknown += unknown;
      results.insertAdjacentHTML("beforeend",cards.join(""));
      status.textContent = summary();
      more.textContent = "Έλεγχος περισσότερων ταινιών";
      more.hidden = current.next > current.pages;
    } catch (error) {
      if (token !== generation) return;
      status.textContent = error.message.startsWith("Η σύνδεση IMDb") || error.message.includes("βαθμολογ")
        ? error.message
        : "Δεν φορτώθηκαν οι ταινίες ή οι πλατφόρμες. Δοκίμασε ξανά — δεν εμφανίζονται ενδεικτικά αποτελέσματα.";
      more.textContent = "Δοκιμή ξανά";
      more.hidden = false;
    } finally {
      if (token === generation) {
        busy = false;
        more.disabled = false;
        form.querySelector("button[type=submit]").disabled = false;
        results.setAttribute("aria-busy","false");
      }
    }
  }

  form.addEventListener("submit", event => {
    event.preventDefault();
    let filters;
    try {
      filters = filtersFrom({genre:$("#d-genre").value,from:$("#d-from").value,to:$("#d-to").value,
        source:$("#d-source").value,rating:$("#d-rating").value,access:$("#d-access").value,available:$("#d-available").checked});
    } catch (error) { status.textContent = error.message; return; }
    generation++;
    busy = false;
    state = {filters,next:1,pages:1,matches:0,checked:0,unknown:0};
    results.innerHTML = "";
    more.hidden = true;
    loadPage(generation);
  });
  more.addEventListener("click",() => loadPage(generation));
  $("#d-preset").addEventListener("click",() => {
    $("#d-genre").value = "10751";
    $("#d-from").value = $("#d-to").value = "2000";
    $("#d-source").value = "imdb";
    $("#d-rating").value = "7,5";
    $("#d-access").value = "all";
    $("#d-available").checked = true;
    status.textContent = "Έτοιμα τα κριτήρια: οικογενειακή, 2000, IMDb πάνω από 7,5. Πάτησε «Βρες ταινίες».";
  });
})();
