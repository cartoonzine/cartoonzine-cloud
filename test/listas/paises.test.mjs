/** sources-idioma.json (listas de UM país).  Rodar:  node --test test/listas/paises.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
const C = createRequire(import.meta.url)('../../catalog-core.js');

test('país: blocos do sources-idioma.json viram fontes (canal com país exclusivo, filme com idioma)', () => {
    const f = C.fontesPorPais({ paises: {
        br: { pais: 'Brasil', idioma: 'pt-BR', canais: ['https://br.dev/'], filmes: ['https://br.dev/f.m3u'] },
        pt: { pais: 'Portugal', idioma: 'pt-PT', canais: ['https://br.dev/'] },          // link repetido: entra 1 vez
        mx: { ativo: false, canais: ['https://mx.dev/'] },
        _x: { canais: ['https://y.dev/'] }
    } }, []);
    assert.equal(f.length, 2);
    assert.equal(f[0].pais, 'br'); assert.equal(f[0].paisExclusivo, true); assert.equal(f[0].idioma, undefined);
    assert.equal(f[0].nome, 'Listas · Brasil · Canais · br.dev'); assert.equal(f[0].prefixoId, 'LST_TV_BR_1');
    assert.equal(f[1].idioma, 'pt-BR'); assert.equal(f[1].pais, undefined);
    assert.equal(C.chaveNomeCanal('Globo SP FHD [BR]'), C.chaveNomeCanal('GLOBO SP (backup)'));
});

test('país: build — a lista do Brasil manda e ensina o país às listas mistas', async () => {
    const misto = '#EXTM3U\n' +
        '#EXTINF:-1 tvg-id="Globo.br" tvg-country="US" group-title="Variados",Globo HD\nhttp://s/globo-misto.m3u8\n' +  // país errado na lista mista
        '#EXTINF:-1 group-title="Variados",SBT FHD\nhttp://s/sbt-misto.m3u8\n' +                                       // sem país (ia para Internacional)
        '#EXTINF:-1 group-title="Variados",Canal Qualquer\nhttp://s/q.m3u8\n';                                         // continua sem país
    const br = '#EXTM3U\n#EXTINF:-1 tvg-id="Globo.br" group-title="Abertos",Globo\nhttp://s/globo.m3u8\n' +
        '#EXTINF:-1 group-title="Abertos",SBT\nhttp://s/sbt.m3u8\n';
    const srv = http.createServer((q, r) => r.end(q.url === '/misto.m3u' ? misto : q.url === '/br/' ? br : ''));
    await new Promise(ok => srv.listen(0, ok));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paises-'));
    fs.writeFileSync(path.join(dir, 'sources.json'), JSON.stringify({ listas: { canais: [base + '/misto.m3u'] }, fontes: [] }));
    fs.writeFileSync(path.join(dir, 'sources-idioma.json'), JSON.stringify({ paises: { br: { pais: 'Brasil', canais: [base + '/br/'] } } }));
    const saida = await new Promise(ok => execFile(process.execPath, [new URL('../../tools/build-catalog.mjs', import.meta.url).pathname,
        '--sources', path.join(dir, 'sources.json'), '--out', path.join(dir, 'catalog'), '--sem-epg', '--health', path.join(dir, 'h.json')],
        { timeout: 60000 }, (e, so, se) => ok(so + se)));
    srv.close();
    const itens = [];
    for (const f of fs.readdirSync(path.join(dir, 'catalog'), { recursive: true })) {
        if (!f.endsWith('.json')) continue;
        const walk = (o) => { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === 'object') { if (o.categoryType === 'live' && o.title) itens.push(o); Object.values(o).forEach(walk); } };
        try { walk(JSON.parse(fs.readFileSync(path.join(dir, 'catalog', f), 'utf8'))); } catch (e) { /* */ }
    }
    const pais = (t) => { const a = itens.filter(i => i.title === t && i.paises); return a.length ? a[0].paises.join(',') : ''; };
    assert.match(saida, /Listas por país: 1 link/, saida);
    assert.equal(pais('Globo HD') || pais('Globo'), 'br', saida);      // mesmo tvg-id: a lista do BR vence o "US"
    assert.equal(pais('SBT FHD'), 'br', saida);                        // aprendido pelo nome
    assert.equal(pais('Canal Qualquer'), '');                          // nada a aprender: segue Internacional
    assert.match(saida, /ganharam o país/);
});
