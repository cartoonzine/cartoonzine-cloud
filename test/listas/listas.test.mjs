/** "listas" do sources.json e links de site (*.pages.dev).  Rodar:  node --test test/listas/listas.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
const C = createRequire(import.meta.url)('../../catalog-core.js');

test('listas: canais/filmes/series viram fontes comuns, sem repetir link', () => {
    const f = C.fontesDasListas({
        canais: ['https://canais-exemplo.pages.dev/', { url: 'https://x.dev/tv.m3u', nome: 'Meus canais', epg: 'https://x.dev/g.xml.gz' }],
        filmes: ['https://filmes-exemplo.pages.dev/', { url: 'https://y.dev/', ativo: false }],
        'séries': ['https://s.dev/series.m3u'],
        'filmes e séries': ['https://mix.dev/'],
        outra: ['https://ignorada.dev/'],
        series: ['https://ja.existe/lista.m3u']
    }, [{ url: 'https://ja.existe/lista.m3u' }]);
    assert.equal(f.length, 5);
    assert.equal(f[4].separarSeries, true); assert.equal(f[4].agruparSeries, undefined);
    assert.equal(f[0].tipo, 'tvzine_worker'); assert.equal(f[0].nome, 'Listas · Canais · canais-exemplo.pages.dev');
    assert.equal(f[1].nome, 'Meus canais'); assert.equal(f[1].epg, 'https://x.dev/g.xml.gz');
    assert.equal(f[2].destino, 'filmes'); assert.equal(f[2].categoryType, 'vod');
    assert.equal(f[3].destino, 'series');
    assert.equal(new Set(f.map(x => x.prefixoId)).size, 5);
    assert.equal(C.sourceFormat(f[0]), 'auto');      // sem extensão: descobre pelo conteúdo
});

test('listas: página HTML → as listas que ela aponta (sem .m3u8 de canal solto)', () => {
    const html = `<!DOCTYPE html><html><body><a href="/lista.m3u">Baixar</a> <a href="filmes.json">json</a>
      <script>const L = "https://cdn.x.dev/series.m3u"; fetch('./extra.txt')</script>
      <video src="https://cdn.x.dev/canal.m3u8"></video><link rel="manifest" href="/site.webmanifest"><a href="/manifest.json">m</a></body></html>`;
    assert.equal(C.pareceHtml(html), true);
    assert.equal(C.pareceHtml('#EXTM3U\n#EXTINF:-1,A\nhttp://a'), false);
    assert.deepEqual(C.linksDeListaNoHtml(html, 'https://filmes-exemplo.pages.dev/'), [
        'https://filmes-exemplo.pages.dev/lista.m3u', 'https://filmes-exemplo.pages.dev/filmes.json',
        'https://cdn.x.dev/series.m3u', 'https://filmes-exemplo.pages.dev/extra.txt'
    ]);
});

test('listas: build completo com um "site" que abre a M3U direto e outro que abre uma página', async () => {
    const m3u = '#EXTM3U\n#EXTINF:-1 tvg-logo="http://l/a.png" group-title="Desenhos",Canal Teste\nhttp://s/a.m3u8\n';
    const filmes = '#EXTM3U\n#EXTINF:-1 group-title="Ação",Filme Teste (2020)\nhttp://s/f.mp4\n';
    const srv = http.createServer((q, r) => {
        if (q.url === '/canais/') { r.setHeader('Content-Type', 'text/plain'); return r.end(m3u); }
        if (q.url === '/filmes/') { r.setHeader('Content-Type', 'text/html'); return r.end('<!doctype html><a href="lista-filmes.m3u">lista</a>'); }
        if (q.url === '/filmes/lista-filmes.m3u') return r.end(filmes);
        if (q.url === '/misto/') return r.end('#EXTM3U\n#EXTINF:-1 group-title="Animes",Filme Misto (2019)\nhttp://s/m.mp4\n' +
            '#EXTINF:-1 group-title="Animes",Naruto S01E01\nhttp://s/n1.mp4\n#EXTINF:-1 group-title="Animes",Naruto S01E02\nhttp://s/n2.mp4\n');
        r.statusCode = 404; r.end();
    });
    await new Promise(ok => srv.listen(0, ok));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'listas-'));
    fs.writeFileSync(path.join(dir, 'sources.json'), JSON.stringify({ listas: { canais: [base + '/canais/'], filmes: [base + '/filmes/'], 'filmes e séries': [base + '/misto/'] }, fontes: [] }));
    const saida = await new Promise(ok => execFile(process.execPath, [new URL('../../tools/build-catalog.mjs', import.meta.url).pathname,
        '--sources', path.join(dir, 'sources.json'), '--out', path.join(dir, 'catalog'), '--sem-epg', '--health', path.join(dir, 'h.json')],
        { timeout: 60000 }, (e, so, se) => ok(so + se)));
    srv.close();
    const todo = fs.readdirSync(path.join(dir, 'catalog'), { recursive: true }).filter(f => f.endsWith('.json'))
        .map(f => fs.readFileSync(path.join(dir, 'catalog', f), 'utf8')).join('\n');
    assert.match(todo, /Canal Teste/, saida);
    assert.match(todo, /Filme Teste/, saida);
    assert.match(saida, /a página aponta 1 lista/);
    // lista mista: o filme fica em Filmes ("Animes"); o Naruto vira UMA série em "Séries · Animes", prateleira de séries
    const man = JSON.parse(fs.readFileSync(path.join(dir, 'catalog', 'manifest.json'), 'utf8'));
    const cats = (man.categorias || man.categories || []);
    const ser = cats.find(c => c.nome === 'Séries · Animes'), fil = cats.find(c => c.nome === 'Animes');
    assert.ok(ser && fil, JSON.stringify(cats.map(c => [c.nome, c.destino, c.total])));
    assert.equal(ser.destino, 'series'); assert.equal(ser.total, 1);
    assert.equal(fil.destino, 'filmes'); assert.equal(fil.total, 1);
});
