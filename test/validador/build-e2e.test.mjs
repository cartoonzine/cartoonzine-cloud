/**
 * Ponta a ponta: roda o tools/build-catalog.mjs de verdade (como o GitHub Actions faz)
 * contra o servidor falso. Rodar:  node --test test/validador/build-e2e.test.mjs
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { criarServidor } from './servidor-falso.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILD = path.join(RAIZ, 'tools', 'build-catalog.mjs');
let S, DIR;

function rodarBuild(args, { matarDepoisMs } = {}) {
    return new Promise(ok => {
        const p = spawn(process.execPath, [BUILD, ...args], { cwd: DIR, env: { ...process.env, CZ_VALIDADOR_TESTE: '1' } });
        let saida = '';
        p.stdout.on('data', d => { saida += d; }); p.stderr.on('data', d => { saida += d; });
        if (matarDepoisMs) setTimeout(() => p.kill('SIGTERM'), matarDepoisMs);
        p.on('close', codigo => ok({ codigo, saida }));
    });
}
const ler = async (f) => JSON.parse(await fs.readFile(path.join(DIR, f), 'utf8'));
async function itemPorTitulo(titulo) {
    const m = await ler('catalog/manifest.json');
    for (const c of m.categories) for (let p = 0; p < c.pages; p++) {
        const cards = await ler(`catalog/cat/${c.slug}/${p}.json`);
        const it = cards.find(x => x.title === titulo);
        if (it) return it;
    }
    return null;
}

before(async () => {
    S = await criarServidor();
    DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'czbuild-'));
    const u = (p) => S.base + p;
    const filmes = [
        { title: 'Funciona', url: u('/v/filme.mp4'), cat: 'Filmes', year: '2001', genre: 'Ação' },
        // o mesmo filme duas vezes = o catalog-core junta e a 2ª vira link reserva (mirrors)
        { title: 'Principal quebrado', year: '1999', url: u('/v/404.mp4'), cat: 'Filmes' },
        { title: 'Principal quebrado', year: '1999', url: u('/hls/master.m3u8'), cat: 'Filmes' },
        { title: 'Todos quebrados', year: '1998', url: u('/v/falso.mp4'), cat: 'Filmes' },
        { title: 'Todos quebrados', year: '1998', url: u('/v/403.mp4'), cat: 'Filmes' },
        { title: 'Sem link', url: '', cat: 'Filmes' },
        { title: 'YouTube', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', cat: 'Filmes' },
        { title: 'Aponta para rede interna', url: 'http://10.0.0.8/filme.mp4', cat: 'Filmes' },
        { title: 'Dublado e legendado', url: u('/v/404.mp4?d'), fontes: [{ url: u('/v/404.mp4?d'), idioma: 'dublado' }, { url: u('/v/filme.webm'), idioma: 'legendado' }], cat: 'Filmes' }
    ];
    for (let i = 0; i < 12; i++) filmes.push({ title: `Extra ${i}`, url: u(`/v/filme.mp4?e${i}`), cat: 'Filmes' });
    await fs.writeFile(path.join(DIR, 'filmes.json'), JSON.stringify(filmes));
    await fs.writeFile(path.join(DIR, 'sources.json'), JSON.stringify({
        validacao: { modo: 'otimizar', timeoutMs: 1500, esperaMs: [50], intervaloPorHostMs: 0, falhasParaIndisponivel: 2 },
        deduplicacao: { modo: 'ativo' },
        fontes: [{ nome: 'Filmes', tipo: 'vod_json', prefixoId: 'VOD', targetCategory: 'Filmes', url: 'filmes.json' }]
    }));
});
after(async () => { await S.fechar(); await fs.rm(DIR, { recursive: true, force: true }); });

test('1ª execução: publica, troca principal quebrado, escreve relatórios e cache', async () => {
    const r = await rodarBuild(['--check-streams']);
    assert.equal(r.codigo, 0, r.saida);
    const m = await ler('catalog/manifest.json');
    assert.ok(m.validacao && m.validacao.modo === 'otimizar');
    const pq = await itemPorTitulo('Principal quebrado');
    assert.match(pq.url, /master\.m3u8$/); assert.match(pq.mirrors[0], /404\.mp4$/);
    const dl = await itemPorTitulo('Dublado e legendado');
    if (Array.isArray(dl.fontes)) {           // catalog-core que mantém "fontes" no item
        assert.equal(dl.fontes[0].idioma, 'legendado', 'lista de fontes reordenada');
        assert.equal(dl.fontes.length, 2);
    } else {                                  // catalog-core que converte "fontes" em mirrors
        assert.match(dl.url, /filme\.webm$/);
        assert.ok(dl.mirrors.some(u => /404\.mp4\?d$/.test(u)));
    }
    const yt = await itemPorTitulo('YouTube');
    assert.match(yt.url, /youtube/);
    const interno = await itemPorTitulo('Aponta para rede interna');
    assert.ok(interno && !interno.indisponivel, 'link bloqueado por segurança não é tratado como morto');
    assert.equal((await itemPorTitulo('Todos quebrados')).indisponivel, undefined, '1 ciclo ainda não basta');
    const rel = await ler('catalog/analise/validacao.json');
    assert.ok(rel.links.ok >= 14 && rel.links.bloqueado === 1, JSON.stringify(rel.links));
    const h = await ler('health-cache.json');
    assert.equal(h.versao, 2);
    assert.ok(!JSON.stringify(h).includes('filme.mp4'), 'cache sem links em texto');
    assert.ok(!r.saida.includes('?e1'), 'log sem query string');
});

test('2ª execução: idempotente, usa cache e marca o item sem fonte (limite 2 ciclos)', async () => {
    S.zerar();
    const antes = await itemPorTitulo('Principal quebrado');
    const r = await rodarBuild(['--check-streams']);
    assert.equal(r.codigo, 0, r.saida);
    assert.equal(S.pedidos.get('/v/filme.mp4'), undefined, 'link bom não foi retestado');
    assert.deepEqual(await itemPorTitulo('Principal quebrado'), antes);
    assert.equal((await itemPorTitulo('Todos quebrados')).indisponivel, true);
    const ind = await ler('catalog/analise/validacao-indisponiveis.json');
    assert.ok(ind.some(x => x.titulo === 'Todos quebrados'));
});

test('interrupção (SIGTERM) durante a validação: nada publicado, cache intacto', async () => {
    const versaoAntes = (await ler('catalog/manifest.json')).version;
    const cacheAntes = await fs.readFile(path.join(DIR, 'health-cache.json'), 'utf8');
    // muitos links lentos para a validação demorar
    const lentos = Array.from({ length: 40 }, (_, i) => ({ title: `Lento ${i}`, url: S.base + `/v/lento.mp4?${i}`, cat: 'Filmes' }));
    const orig = await fs.readFile(path.join(DIR, 'filmes.json'), 'utf8');
    await fs.writeFile(path.join(DIR, 'filmes.json'), JSON.stringify(JSON.parse(orig).concat(lentos)));
    const r = await rodarBuild(['--check-streams'], { matarDepoisMs: 1200 });
    await fs.writeFile(path.join(DIR, 'filmes.json'), orig);
    assert.notEqual(r.codigo, 0);
    assert.match(r.saida, /interrompida/);
    assert.equal((await ler('catalog/manifest.json')).version, versaoAntes);
    assert.equal(await fs.readFile(path.join(DIR, 'health-cache.json'), 'utf8'), cacheAntes);
    const sobras = (await fs.readdir(DIR)).filter(f => f.startsWith('catalog.tmp') || f.startsWith('catalog.old'));
    assert.deepEqual(sobras, []);
});

test('falha na publicação: cache não é gravado e o catálogo anterior fica', async () => {
    const cacheAntes = await fs.readFile(path.join(DIR, 'health-cache.json'), 'utf8');
    await fs.writeFile(path.join(DIR, 'nao-e-pasta'), 'x');
    const r = await rodarBuild(['--check-streams', '--out', 'nao-e-pasta/catalog', '--force']);
    assert.notEqual(r.codigo, 0);
    assert.equal(await fs.readFile(path.join(DIR, 'health-cache.json'), 'utf8'), cacheAntes);
    assert.ok((await ler('catalog/manifest.json')).version);
});

test('sem --check-streams: build igual ao de antes (não testa nada)', async () => {
    S.zerar();
    const r = await rodarBuild([]);
    assert.equal(r.codigo, 0, r.saida);
    assert.equal(S.pedidos.size, 0);
    assert.equal((await ler('catalog/manifest.json')).validacao, undefined);
});
