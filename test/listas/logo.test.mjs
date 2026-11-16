/** Logo PNG do título (filmes e séries).  Rodar:  node --test test/listas/logo.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const C = createRequire(import.meta.url)('../../catalog-core.js');

test('logo: filme e série guardam o PNG do título ("logo" ou "bannerlogo"); a capa repetida não conta', () => {
    const b = new C.CatalogBuilder({});
    const src = { nome: 't', tipo: 'vod_json', prefixoId: 'V' };
    b.addRaw({ title: 'Filme A', year: 2020, thumb: 'http://c/a.jpg', bannerlogo: 'http://l/a.png', url: 'http://v/a.mp4' }, src);
    b.addRaw({ title: 'Filme B', thumb: 'http://c/b.jpg', logo: 'http://c/b.jpg', url: 'http://v/b.mp4' }, src);
    b.addRaw({ title: 'Série S', thumb: 'http://c/s.jpg', logo: 'http://l/s.png', seasons: [{ season: 1, episodes: [{ episode: 1, url: 'http://v/s1.mp4' }] }] }, src);
    const logos = {};
    for (const [cat, ids] of b.catCards) for (const id of ids) { const k = b.card(id, cat); logos[k.title] = k.logo; }
    assert.deepEqual(logos, { 'Filme A': 'http://l/a.png', 'Filme B': undefined, 'Série S': 'http://l/s.png' });
});
