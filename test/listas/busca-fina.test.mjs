/** Busca fina (Filtros+): TMDB junta a mesma obra, áudios e qualidade.  Rodar:  node --test test/listas/busca-fina.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const C = createRequire(import.meta.url)('../../catalog-core.js');

test('mesmo tmdbId com nomes diferentes vira UM card (id do primeiro); áudios somam e a qualidade é a melhor', () => {
    const b = new C.CatalogBuilder({ deduplicacao: { modo: 'ativo' } });
    const src = { nome: 't', tipo: 'vod_json', prefixoId: 'V' };
    b.addRaw({ title: 'Matrix', year: 1999, tmdbId: 603, tmdbTipo: 'movie', rating: 8.2, url: 'http://v/a.mp4', audios: ['dublado'], qualidadeMax: 'HD' }, src);
    b.addRaw({ title: 'The Matrix', year: 1999, tmdbId: 'movie/603', url: 'http://v/b.mp4', fontes: [{ url: 'http://v/b.mp4', idioma: 'legendado', qualidade: 'fhd' }] }, src);
    b.addRaw({ title: 'Matrix', year: 1999, tmdbId: 604, url: 'http://v/c.mp4' }, src);   // outro código = outra obra? mesmo nome+ano junta pela chave de sempre
    const cards = [];
    for (const [cat, ids] of b.catCards) for (const id of ids) cards.push(b.card(id, cat));
    const m = cards.filter(c => /matrix/i.test(c.title));
    assert.equal(m.length, 1);
    assert.deepEqual(m[0].audios.sort(), ['dublado', 'legendado']);
    assert.equal(m[0].qualidadeMax, 'FHD'); assert.equal(m[0].rating, 8.2); assert.equal(m[0].tmdbTipo, 'movie');
    assert.ok((m[0].mirrors || []).includes('http://v/b.mp4'));
});

test('fontes {url, idioma, qualidade} viram audios e qualidadeMax do título', () => {
    const [it] = C.normalize({ title: 'Dinheiro Suspeito', year: 2026, fontes: [
        { url: 'http://v/1.mp4', idioma: 'dublado', qualidade: 'FHD' }, { url: 'http://v/2.mp4', idioma: 'legendado', qualidade: 'HD' }] }, { nome: 't', tipo: 'vod_json', prefixoId: 'V' });
    assert.deepEqual(it.audios.sort(), ['dublado', 'legendado']); assert.equal(it.qualidadeMax, 'FHD');
    assert.equal(it.url, 'http://v/1.mp4');
});
