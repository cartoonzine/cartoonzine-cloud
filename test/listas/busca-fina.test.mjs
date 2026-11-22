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
    b.addRaw({ title: 'Matrix', year: 1999, tmdbId: 604, url: 'http://v/c.mp4' }, src);   // 🛡 outro código = outra obra: NUNCA junta (trava TMDB)
    const cards = [];
    for (const [cat, ids] of b.catCards) for (const id of ids) cards.push(b.card(id, cat));
    const todos = cards.filter(c => /matrix/i.test(c.title));
    assert.equal(todos.length, 2, 'o 604 fica num card próprio');
    const m = todos.filter(c => String(c.tmdbId).endsWith('603'));
    assert.equal(m.length, 1);
    assert.ok(!(m[0].mirrors || []).includes('http://v/c.mp4'), 'o link do 604 não vira reserva do 603');
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

test('filmes/séries: os mais novos primeiro (destaque antes); canais ficam na ordem da lista; "fonte" desliga', () => {
    const monta = () => {
        const b = new C.CatalogBuilder({});
        const vod = { nome: 'f', tipo: 'vod_json', prefixoId: 'V' };
        b.addRaw({ title: 'Velho', year: 1999, url: 'http://v/1.mp4', cat: 'Filmes' }, vod);
        b.addRaw({ title: 'Sem Ano', url: 'http://v/2.mp4', cat: 'Filmes' }, vod);
        b.addRaw({ title: 'Novo', year: 2026, url: 'http://v/3.mp4', cat: 'Filmes' }, vod);
        b.addRaw({ title: 'Meio', year: 2015, url: 'http://v/4.mp4', cat: 'Filmes', destaque: true }, vod);
        b.addRaw({ title: 'Série Nova', year: 2025, cat: 'Filmes', seasons: [{ season: 1, episodes: [{ episode: 1, url: 'http://v/s.mp4' }] }] }, vod);
        const tv = { nome: 'c', tipo: 'tvzine_worker', prefixoId: 'T' };
        b.addRaw({ title: 'Canal B', year: 2000, url: 'http://t/b.m3u8', group: 'Notícias' }, tv);
        b.addRaw({ title: 'Canal A', year: 2026, url: 'http://t/a.m3u8', group: 'Notícias' }, tv);
        return b;
    };
    const titulos = (b, cat) => b.catCards.get(cat).map(id => b.card(id, cat).title);
    let b = monta(); b.ordenarCategorias();
    assert.deepEqual(titulos(b, 'Filmes'), ['Meio', 'Novo', 'Série Nova', 'Velho', 'Sem Ano']);
    assert.deepEqual(titulos(b, 'Notícias'), ['Canal B', 'Canal A'], 'canal não muda de ordem');
    b = monta(); b.ordenarCategorias('fonte');
    assert.deepEqual(titulos(b, 'Filmes').slice(0, 2), ['Velho', 'Sem Ano']);
});
