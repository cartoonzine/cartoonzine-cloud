/** Listas .md → registros do catálogo.  Rodar:  node --test test/markdown/markdown.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const C = createRequire(import.meta.url)('../../catalog-core.js');
const ler = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8');

test('tabela de canais: título vira categoria, logo, EPG, reservas e status offline', () => {
    const r = C.parseSourceText(ler('canais.md'));
    const nomes = r.map(x => x.title);
    assert.deepEqual(nomes, ['Desenho TV', 'Toon Max', 'Jornal 24h', 'Rádio Notícia', 'Canal do Bloco']);
    assert.equal(r[0].group, 'Desenhos');
    assert.equal(r[0].thumb, 'https://img.exemplo.com/desenho.png');
    assert.equal(r[0].tvgId, 'DesenhoTV.br');
    assert.deepEqual(r[1].urls, ['https://reserva.exemplo.com/toon.m3u8']);
    assert.ok(!nomes.includes('Canal Morto'), 'linha marcada ❌ offline fica de fora');
    assert.equal(r[2].group, 'Notícias');
    assert.ok(!r.some(x => /nao-e-canal/.test(x.url)), 'bloco de código que não é M3U é ignorado');
});

test('tabela de filmes: ano, gênero, capa, idioma, | escapado e vários servidores', () => {
    const r = C.parseSourceText(ler('filmes.md'));
    assert.equal(r.length, 2);
    assert.deepEqual(r[0], { title: 'Duro de Matar', year: '1988', genre: 'Ação', thumb: 'https://img.exemplo.com/duro.jpg', idioma: 'Dublado', url: 'https://v.exemplo.com/duro.mp4' });
    assert.equal(r[1].title, 'Rei Leão | Edição Especial');
    assert.equal(r[1].year, '1994');
    assert.deepEqual(r[1].urls, ['https://v2.exemplo.com/rei.mp4']);
});

test('formato: .md pela extensão e pelo conteúdo; JSON e M3U continuam iguais', () => {
    assert.equal(C.sourceFormat({ url: 'https://raw.githubusercontent.com/a/b/main/lista.md' }), 'md');
    assert.equal(C.parseSourceText('[{"title":"A","url":"https://a/1.mp4"}]').length, 1);
    assert.equal(C.parseSourceText('#EXTM3U\n#EXTINF:-1,Canal\nhttps://a/1.m3u8\n').length, 1);
    assert.equal(C.parseSourceText('- [Canal](https://a/x.m3u8)').length, 1);
});
