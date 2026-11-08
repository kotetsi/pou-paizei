const {test,beforeEach} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
let worker, calls, stored, pending;
const env = {TMDB_TOKEN:'test-tmdb',OMDB_API_KEY:'test-omdb'};
const request = (path='imdb/movie/123') => new Request('https://worker.example/?'+new URLSearchParams({path}),{headers:{Origin:'https://kotetsi.github.io'}});
const ctx = {waitUntil(promise){pending.push(promise);}};
const json = data => new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});

beforeEach(async () => {
  calls = []; stored = new Map(); pending = [];
  global.caches = {default:{async match(key){return stored.get(key.url)?.clone();}, async put(key,res){stored.set(key.url,res);}}};
  const source = fs.readFileSync(require.resolve('../worker.js'),'utf8');
  // Κάθε τεστ φορτώνει καινούργιο Worker, ώστε η μνήμη του να μη μεταφέρεται από τεστ σε τεστ.
  const fresh = source + '\n// ' + Math.random();
  worker = (await import('data:text/javascript;base64,'+Buffer.from(fresh).toString('base64'))).default;
  global.fetch = async (url, options) => {
    calls.push({url:String(url),options});
    return String(url).includes('themoviedb') ? json({imdb_id:'tt1234567'}) : json({Response:'True',imdbID:'tt1234567',imdbRating:'7.8'});
  };
});

test('returns IMDb score from OMDb, caches it and keeps secrets out of response and cache key', async () => {
  let response = await worker.fetch(request(),env,ctx);
  assert.equal(response.status,200);
  const body = await response.text();
  assert.deepEqual(JSON.parse(body),{source:'IMDb',imdb_id:'tt1234567',rating:7.8});
  assert.equal(body.includes(env.OMDB_API_KEY),false);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'),'*');
  await Promise.all(pending);
  assert.equal([...stored.keys()].some(key=>key.includes(env.OMDB_API_KEY)),false);
  response = await worker.fetch(request(),env,ctx);
  assert.equal((await response.json()).rating,7.8);
  assert.equal(calls.length,2);
});

test('missing key explicitly reports configuration, no substituted score', async () => {
  const response = await worker.fetch(request(),{TMDB_TOKEN:'test'},ctx);
  assert.equal(response.status,503);
  assert.equal((await response.json()).code,'IMDB_NOT_CONFIGURED');
  assert.equal(calls.length,0);
});

test('missing IMDb ID and N/A ratings stay null', async () => {
  global.fetch = async () => json({imdb_id:null,vote_average:9.9});
  let response = await worker.fetch(request(),env,ctx);
  assert.equal((await response.json()).rating,null);
  global.fetch = async url => String(url).includes('themoviedb') ? json({imdb_id:'tt1234567'}) : json({Response:'True',imdbID:'tt1234567',imdbRating:'N/A'});
  response = await worker.fetch(request('imdb/movie/456'),env,ctx);
  assert.equal((await response.json()).rating,null);
});

test('quota and bad API key errors are failures, never unrated cached results', async () => {
  global.fetch = async url => String(url).includes('themoviedb') ? json({imdb_id:'tt1234567'}) : json({Response:'False',Error:'Request limit reached!'});
  const response = await worker.fetch(request(),env,ctx);
  assert.equal(response.status,502);
  assert.equal((await response.json()).code,'IMDB_UPSTREAM_ERROR');
  assert.equal(stored.size,0);
});

test('old TMDB paths, method restrictions and path allowlist still work', async () => {
  let response = await worker.fetch(request('discover/movie'),env,ctx);
  assert.equal(response.status,200);
  response = await worker.fetch(request('account'),env,ctx);
  assert.equal(response.status,400);
  response = await worker.fetch(request('imdb/movie/../../account'),env,ctx);
  assert.equal(response.status,400);
  response = await worker.fetch(new Request('https://worker.example',{method:'POST'}),env,ctx);
  assert.equal(response.status,405);
});

test('in-memory cache answers repeat requests even when the Cloudflare cache is empty', async () => {
  let response = await worker.fetch(request('imdb/movie/789'),env,ctx);
  assert.equal(response.headers.get('X-Cache'),'MISS');
  await Promise.all(pending);
  stored.clear();
  const before = calls.length;
  response = await worker.fetch(request('imdb/movie/789'),env,ctx);
  assert.equal(response.headers.get('X-Cache'),'MEMORY');
  assert.equal((await response.json()).rating,7.8);
  assert.equal(calls.length,before);
});

test('upstream errors are not remembered in memory', async () => {
  global.fetch = async url => String(url).includes('themoviedb') ? json({imdb_id:'tt1234567'}) : json({Response:'False',Error:'Invalid API key!'});
  let response = await worker.fetch(request('imdb/movie/321'),env,ctx);
  assert.equal(response.status,502);
  global.fetch = async url => String(url).includes('themoviedb') ? json({imdb_id:'tt1234567'}) : json({Response:'True',imdbID:'tt1234567',imdbRating:'8.1'});
  response = await worker.fetch(request('imdb/movie/321'),env,ctx);
  assert.equal((await response.json()).rating,8.1);
});
