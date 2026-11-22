/** 🛡 Filtro de cópias: nunca juntar o que NÃO é cópia.  node --test test/listas/filtro-copias.test.mjs */
import { test } from 'node:test';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const C = createRequire(import.meta.url)('../../catalog-core.js');
const montar = (modo, fontes) => {
    const b = new C.CatalogBuilder({ deduplicacao: { modo } });
    for (const [src, lista] of fontes) for (const raw of lista) b.addRaw(raw, src);
    return b;
};
const vods = (b) => [...b.items.values()].filter(i => i.categoryType === 'vod');
const A = { nome: 'A', tipo: 'vod_json', prefixoId: 'AA' }, B = { nome: 'B', tipo: 'vod_json', prefixoId: 'BB' };
const t = test;

t('O Rei Leão 1994 × 2019 (mesmo título+ano errado na lista, TMDB diferente) nunca junta, nem no modo ativo', () => {
    const b = montar('ativo', [[A, [{ title: 'O Rei Leão', year: 2019, url: 'http://a/rl.mp4', tmdbId: 420818, tmdbTipo: 'movie' }]], [B, [{ title: 'O Rei Leão', year: 2019, url: 'http://b/rl94.mp4', tmdbId: 8587, tmdbTipo: 'movie' }]]]);
    assert.equal(vods(b).length, 2);
    assert.ok(b.relatorio.separados.some(x => x.motivo === 'TMDB diferente'));
});
t('mesmo TMDB com nomes diferentes = 1 card com reserva (como antes)', () => {
    const b = montar('desligado', [[A, [{ title: 'Matrix', year: 1999, url: 'http://a/m.mp4', tmdbId: 603 }]], [B, [{ title: 'The Matrix', url: 'http://b/m.mp4', tmdbId: 603 }]]]);
    assert.equal(vods(b).length, 1); assert.deepEqual(vods(b)[0].mirrors, ['http://b/m.mp4']);
});
t('TMDB achado só pelo nome: não junta se título e ano não batem', () => {
    const b = montar('desligado', [[A, [{ title: 'Shrek', year: 2001, url: 'http://a/s.mp4', tmdbId: 808 }]], [B, [{ title: 'Shrek: O Musical', year: 2013, url: 'http://b/sm.mp4', tmdbId: 808, tmdbPorNome: true }]]]);
    assert.equal(vods(b).length, 2);
});
t('TMDB achado pelo nome, mas o título bate: junta', () => {
    const b = montar('desligado', [[A, [{ title: 'Shrek', year: 2001, url: 'http://a/s.mp4', tmdbId: 808 }]], [B, [{ title: 'Shrek 1080p DUB', url: 'http://b/s2.mp4', tmdbId: 808, tmdbPorNome: true }]]]);
    assert.equal(vods(b).length, 1);
});
t('IDs não mudam: o card continua com o id de sempre', () => {
    const b1 = montar('desligado', [[A, [{ title: 'Up', year: 2009, url: 'http://a/up.mp4' }]]]);
    const b2 = montar('ativo', [[A, [{ title: 'Up', year: 2009, url: 'http://a/up.mp4' }]], [B, [{ title: 'Up 1080p DUB', year: 2009, url: 'http://b/up.mp4' }]]]);
    assert.equal(vods(b2)[0].id, vods(b1)[0].id); assert.equal(vods(b2).length, 1, 'título limpo achou a cópia no modo ativo');
});
t('título limpo no modo analisar: não junta, só relata', () => {
    const b = montar('analisar', [[A, [{ title: 'Up', year: 2009, url: 'http://a/up.mp4' }]], [B, [{ title: 'Up 1080p DUB', year: 2009, url: 'http://b/up.mp4' }]]]);
    assert.equal(vods(b).length, 2); assert.ok(b.relatorio.juntados.length >= 1);
});
t('séries homônimas (mesma fonte, TMDB diferente) ficam separadas; episódios não viram reserva uma da outra', () => {
    const b = montar('desligado', [[A, [
        { title: 'Doctor Who', tmdbId: 121, tmdbTipo: 'tv', seasons: [{ season: 1, episodes: [{ episode: 1, url: 'http://a/dw63.mp4' }] }] },
        { title: 'Doctor Who', tmdbId: 57243, tmdbTipo: 'tv', seasons: [{ season: 1, episodes: [{ episode: 1, url: 'http://a/dw05.mp4' }] }] }]]]);
    assert.equal(b.series.size, 2);
    const eps = [...b.items.values()].filter(i => i.categoryType === 'episode');
    assert.equal(eps.length, 2); assert.ok(eps.every(e => !e.mirrors));
});
t('séries homônimas soltas no M3U (Serie S01E01) com TMDB diferente', () => {
    const M = { nome: 'M', tipo: 'vod_json', prefixoId: 'MM' };
    const b = montar('desligado', [[M, [{ title: 'Shameless S01E01', url: 'http://m/us.mp4', tmdbId: 34307, tmdbTipo: 'tv' }, { title: 'Shameless S01E01', url: 'http://m/uk.mp4', tmdbId: 1906, tmdbTipo: 'tv' }]]]);
    assert.equal(b.series.size, 2);
});
t('mesma série, mesmo TMDB: os episódios repetidos viram reserva (como antes)', () => {
    const M = { nome: 'M', tipo: 'vod_json', prefixoId: 'MM' };
    const b = montar('desligado', [[M, [{ title: 'Lost S01E01', url: 'http://m/l1.mp4', tmdbId: 4607, tmdbTipo: 'tv' }, { title: 'Lost S01E01', url: 'http://m/l1b.mp4', tmdbId: 4607, tmdbTipo: 'tv' }]]]);
    assert.equal(b.series.size, 1);
    const eps = [...b.items.values()].filter(i => i.categoryType === 'episode'); assert.equal(eps.length, 1); assert.deepEqual(eps[0].mirrors, ['http://m/l1b.mp4']);
});
