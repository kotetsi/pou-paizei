const {test} = require('node:test');
const assert = require('node:assert/strict');
const {filtersFrom,discoverParams,availability,passesRating} = require('../discover.js');
const base = {genre:'10751',from:'2000',to:'2000',source:'imdb',rating:'7,5',access:'all',available:true};

test('family / exact year / decimal comma; IMDb must not be prefiltered using TMDB scores', () => {
  const filters = filtersFrom(base);
  const params = discoverParams(filters,2);
  assert.equal(filters.rating,7.5);
  assert.equal(params.with_genres,'10751');
  assert.equal(params['primary_release_date.gte'],'2000-01-01');
  assert.equal(params['primary_release_date.lte'],'2000-12-31');
  assert.equal(params['vote_average.gte'],undefined);
  assert.equal(params.page,2);
});

test('open and bounded year ranges; TMDB explicitly uses its own score', () => {
  const params = discoverParams(filtersFrom({...base,to:'2009',source:'tmdb'}),1);
  assert.equal(params['primary_release_date.lte'],'2009-12-31');
  assert.equal(params['vote_average.gte'],7.5);
  assert.equal(discoverParams(filtersFrom({...base,from:'',to:''}),1)['primary_release_date.gte'],undefined);
});

test('invalid or reversed years and invalid rating are rejected', () => {
  for(const patch of [{from:'2001'}, {from:'1873'}, {to:'2000.5'}, {rating:''}, {rating:'NaN'}, {rating:'10'}, {rating:'-1'}, {rating:'7,5,5'}]) {
    assert.throws(() => filtersFrom({...base,...patch}));
  }
});

test('strictly above 7.5 excludes 7.5, missing, unrated and invalid values', () => {
  assert.equal(passesRating(7.6,7.5),true);
  for(const score of [7.5,7.4,null,undefined,'8',NaN,11]) assert.equal(passesRating(score,7.5),false);
});

test('availability respects rent, subscription, free and Greek platform access type', () => {
  const providers = {rent:[{provider_name:'Apple TV'}],ads:[{provider_name:'Plex'}]};
  const locals = [{name:'ERTFLIX',type:'free'},{name:'ANT1+',type:'flatrate'}];
  assert.equal(availability({rent:providers.rent},[],'stream').available,false);
  assert.equal(availability({rent:providers.rent},[],'all').available,true);
  const free = availability(providers,locals,'free');
  assert.deepEqual(Object.keys(free.providers),['ads']);
  assert.deepEqual(free.greek.map(p => p.name),['ERTFLIX']);
  assert.equal(availability(null,[locals[0]],'stream').available,true);
});
