/** Ficha de filtro + data de entrada ("Recém-postados").  Rodar:  node --test test/listas/ficha-filtro.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const C = createRequire(import.meta.url)('../../catalog-core.js');

const monta = () => {
    const b = new C.CatalogBuilder({});
    const vod = { nome: 'f', tipo: 'vod_json', prefixoId: 'V' };
    b.addRaw({ title: 'Antigo Postado Hoje', year: 1980, url: 'http://v/1.mp4', cat: 'Filmes', genre: 'Drama', rating: 7.1, audios: ['dublado'] }, vod);
    b.addRaw({ title: 'Novo Postado Antes', year: 2026, url: 'http://v/2.mp4', cat: 'Filmes', added: 1700000000 }, vod);
    b.addRaw({ title: 'Torrent', year: 2010, url: 'magnet:?xt=urn:btih:abc', cat: 'Filmes' }, vod);
    b.addRaw({ title: 'Série', year: 2020, cat: 'Filmes', seasons: [{ season: 1, episodes: [{ episode: 1, url: 'http://v/s1.mp4', added: '2025-01-10' }, { episode: 2, url: 'http://v/s2.mp4', added: '2025-03-05' }] }] }, vod);
    return b;
};
const titulos = (b) => b.catCards.get('Filmes').map(id => b.card(id, 'Filmes').title);

test('dataDia aceita segundos, ms, texto e recusa lixo', () => {
    assert.equal(C.dataDia(1700000000), '2023-11-14');
    assert.equal(C.dataDia('1700000000000'), '2023-11-14');
    assert.equal(C.dataDia('2025-03-05T10:00:00Z'), '2025-03-05');
    assert.equal(C.dataDia('ontem'), null);
    assert.equal(C.dataDia(5), null);
});

test('entrada: fonte > memória > hoje; série pega o episódio mais novo; memória esquece quem sumiu há 60 dias', () => {
    const b = monta();
    const mem = { velho: ['2024-01-01', '2024-01-02'] };
    const ids = [...b.items.keys()];
    mem[ids[0]] = ['2026-10-01', '2026-11-01'];
    b.aplicarEntradas(mem, '2026-11-20');
    const card = (t) => b.catCards.get('Filmes').map(id => b.card(id, 'Filmes')).find(c => c.title === t);
    assert.equal(card('Antigo Postado Hoje').adicionado, '2026-10-01', 'memória');
    assert.equal(card('Novo Postado Antes').adicionado, '2023-11-14', 'fonte');
    assert.equal(card('Torrent').adicionado, '2026-11-20', 'hoje');
    assert.equal(card('Série').adicionado, '2025-03-05', 'episódio mais novo');
    assert.equal(mem.velho, undefined);
    assert.deepEqual(mem[ids[0]], ['2026-10-01', '2026-11-20']);
});

test('ordem "recentes" usa a data de entrada; "novos" continua pelo ano', () => {
    let b = monta(); b.aplicarEntradas({}, '2026-11-20'); b.ordenarCategorias('recentes');
    assert.deepEqual(titulos(b).slice(0, 2).sort(), ['Antigo Postado Hoje', 'Torrent']);
    assert.equal(titulos(b)[3], 'Novo Postado Antes');
    b = monta(); b.aplicarEntradas({}, '2026-11-20'); b.ordenarCategorias('novos');
    assert.equal(titulos(b)[0], 'Novo Postado Antes');
});

test('ficha de filtro: todos os títulos, na ordem das páginas, só os campos dos filtros', () => {
    const b = monta(); b.aplicarEntradas({}, '2026-11-20'); b.ordenarCategorias('novos');
    const f = b.fichaFiltro('Filmes');
    assert.equal(f.v, 1);
    assert.equal(f.itens.length, b.catCards.get('Filmes').length);
    const obj = f.itens.map(l => Object.fromEntries(f.campos.map((k, i) => [k, l[i]]).filter(([, v]) => v != null)));
    assert.deepEqual(obj.map(o => o.title), titulos(b));
    const a = obj.find(o => o.title === 'Antigo Postado Hoje');
    assert.equal(a.rating, 7.1); assert.deepEqual(a.audios, ['dublado']); assert.equal(a.year, 1980);
    assert.equal(obj.find(o => o.title === 'Torrent').torrent, 1);
    assert.ok(!('url' in a) && !('thumb' in a), 'nada além dos campos dos filtros');
});

test('LocalCatalog também entrega a ficha', () => {
    const lc = new C.LocalCatalog({ pageSize: 2 });
    lc.b = monta();
    const m = lc.manifest();
    const cat = m.categories.find(c => c.nome === 'Filmes');
    const f = lc.ficha(cat.slug);
    assert.equal(f.pageSize, 2); assert.equal(f.itens.length, cat.total);
});
