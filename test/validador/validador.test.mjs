/**
 * Testes do validador de links.  Rodar:  node --test test/validador/
 * Tudo acontece contra um servidor falso em 127.0.0.1 — nenhum site real é acessado.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { criarServidor, resolverFalso } from './servidor-falso.mjs';
import { criarRequisitor, ipProibido, redigir, cabecalhosSeguros, chaveDoLink } from '../../tools/validador/seguranca.mjs';
import { verificar, analisarHls, detectarTipo, assinatura } from '../../tools/validador/verificadores.mjs';
import { criarMotor, carregarCache } from '../../tools/validador/motor.mjs';
import { ordenarFontes } from '../../tools/validador/selecao.mjs';
import { validarCatalogo } from '../../tools/validador/index.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let S;
const LOOP = ['127.0.0.1/32'];
before(async () => { S = await criarServidor(); });
after(async () => { await S.fechar(); });

const req = () => criarRequisitor({ redesPermitidas: LOOP, resolver: resolverFalso });
const v = async (caminho, extra = {}) => {
    const R = req();
    try { return await verificar(S.base + caminho, { req: R.requisitar, timeoutMs: 1500, ...extra }); }
    finally { R.encerrar(); }
};

// =====================================================================================
describe('segurança (SSRF)', () => {
    const semLiberar = () => criarRequisitor({ resolver: resolverFalso });

    test('bloqueia IPs internos, metadados de nuvem e variações de escrita', async () => {
        const R = semLiberar();
        const alvos = [
            'http://127.0.0.1/', 'http://localhost/', 'http://0.0.0.0/', 'http://10.1.1.1/', 'http://172.16.5.5/',
            'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data/', 'http://100.64.0.1/',
            'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[fd00:ec2::254]/',
            'http://[fe80::1]/', 'http://2130706433/', 'http://0x7f.1/', 'http://017700000001/',
            'http://metadata.google.internal/', 'http://algo.local/'
        ];
        for (const a of alvos) {
            await assert.rejects(R.requisitar(a, { timeoutMs: 1000 }), e => e.codigo === 'destino_bloqueado', a);
        }
        R.encerrar();
    });

    test('bloqueia domínio que resolve para rede interna (inclusive se só UM dos IPs for interno)', async () => {
        const R = criarRequisitor({ redesPermitidas: LOOP, resolver: resolverFalso });
        for (const h of ['interno.teste', 'metadados.teste', 'misto.teste', 'v6local.teste', 'mapeado.teste'])
            await assert.rejects(R.requisitar(`http://${h}:${S.porta}/v/filme.mp4`, { timeoutMs: 1000 }), e => e.codigo === 'destino_bloqueado', h);
        R.encerrar();
    });

    test('protocolos, credenciais na URL e portas sensíveis são recusados', async () => {
        const R = semLiberar();
        await assert.rejects(R.requisitar('file:///etc/passwd'), e => e.codigo === 'protocolo_nao_permitido');
        await assert.rejects(R.requisitar('ftp://exemplo.com/a.mp4'), e => e.codigo === 'protocolo_nao_permitido');
        await assert.rejects(R.requisitar('http://user:senha@exemplo.com/a.mp4'), e => e.codigo === 'credencial_na_url');
        await assert.rejects(R.requisitar('http://exemplo.com:6379/'), e => e.codigo === 'porta_bloqueada');
        await assert.rejects(R.requisitar('http://exemplo.com:22/'), e => e.codigo === 'porta_bloqueada');
        R.encerrar();
    });

    test('redirecionamento para rede interna, metadados ou file: é barrado', async () => {
        assert.equal((await v('/r/interno')).estado, 'bloqueado');
        assert.equal((await v('/r/metadados')).estado, 'bloqueado');
        assert.equal((await v('/r/file')).estado, 'bloqueado');
    });

    test('redirecionamento normal funciona; loop e cadeia longa falham', async () => {
        const ok = await v('/r/ok');
        assert.equal(ok.estado, 'ok'); assert.equal(ok.redirecionamentos, 1);
        assert.equal((await v('/r/loop')).codigo, 'redirecionamento_em_loop');
        assert.equal((await v('/r/cadeia/0')).codigo, 'redirecionamentos_demais');
    });

    test('nunca envia Cookie/Authorization; só cabeçalhos da lista segura', async () => {
        const R = req();
        const r = await R.requisitar(S.base + '/eco', { headers: { Cookie: 'a=1', Authorization: 'Bearer x', Referer: 'https://site.com/', 'X-Api-Key': 'segredo', 'User-Agent': 'VLC\r\nX-Injetado: 1' } });
        const h = JSON.parse(r.corpo.toString());
        R.encerrar();
        assert.equal(h.cookie, undefined); assert.equal(h.authorization, undefined); assert.equal(h['x-api-key'], undefined);
        assert.equal(h.referer, 'https://site.com/');
        assert.equal(h['x-injetado'], undefined);
        assert.match(h['user-agent'], /CartoonzineLinkCheck/);
        assert.deepEqual(cabecalhosSeguros({ Cookie: 'x', Origin: 'https://a' }), { Origin: 'https://a' });
    });

    test('limita o tamanho da resposta (playlist gigante, transmissão infinita)', async () => {
        const g = await v('/hls/gigante.m3u8');
        assert.equal(g.estado, 'falhou'); assert.equal(g.codigo, 'playlist_grande_demais');
        const t0 = Date.now();
        const live = await v('/live/canal.ts');
        assert.equal(live.estado, 'ok'); assert.equal(live.detalhes.assinatura, 'mpegts');
        assert.ok(Date.now() - t0 < 1500, 'não pode ficar preso numa transmissão sem fim');
    });

    test('logs não mostram tokens, senhas Xtream nem query', () => {
        assert.equal(redigir('https://cdn.com/live/joao/senha123/555.ts'), 'https://cdn.com/live/***/***/555.ts');
        const r = redigir('https://cdn.com/hls/a.m3u8?token=abc123&expires=999&q=1');
        assert.ok(!r.includes('abc123') && !r.includes('999'), r);
        assert.ok(!redigir('https://u:p@cdn.com/x').includes('p@'));
        assert.ok(!redigir('https://cdn.com/v/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9/a.mp4').includes('eyJ'));
        assert.equal(chaveDoLink('https://a/b?token=x').includes('token'), false);
    });

    test('ipProibido cobre IPv4/IPv6 e não bloqueia IP público', async () => {
        const net = await import('node:net');
        const l = { bloq: new net.BlockList(), perm: new net.BlockList() };
        // usa a lista real via requisitor: IP público passa pela checagem (falha só na conexão)
        assert.equal(typeof ipProibido, 'function');
        const R = criarRequisitor({ resolver: { lookup: async () => [{ address: '93.184.216.34', family: 4 }] } });
        await assert.doesNotReject(R.conferirDestino(new URL('http://exemplo.com/')));
        R.encerrar();
        void l;
    });
});

// =====================================================================================
describe('verificadores por formato', () => {
    test('HLS master → variante → segmento TS', async () => {
        const r = await v('/hls/master.m3u8');
        assert.equal(r.estado, 'ok'); assert.equal(r.tipo, 'hls'); assert.equal(r.detalhes.variantes, 2);
        assert.equal(r.detalhes.segmento, 'mpegts'); assert.equal(r.confianca, 'alta');
    });
    test('HLS ao vivo testa o segmento mais novo', async () => {
        const r = await v('/hls/vivo.m3u8');
        assert.equal(r.estado, 'ok'); assert.equal(r.detalhes.aoVivo, true);
        assert.ok(S.pedidos.get('/seg/1.ts') >= 1);
    });
    test('HLS fMP4 com EXT-X-MAP', async () => {
        const r = await v('/hls/fmp4.m3u8');
        assert.equal(r.estado, 'ok'); assert.equal(r.detalhes.segmento, 'mp4');
    });
    test('HLS AES-128 não é DRM (toca no hls.js)', async () => assert.equal((await v('/hls/aes128.m3u8')).estado, 'ok'));
    test('HLS com gzip é descompactado', async () => assert.equal((await v('/hls/gzip.m3u8')).estado, 'ok'));
    test('HLS malformado / sem #EXTM3U / sem segmentos / HTML', async () => {
        assert.equal((await v('/hls/malformada.m3u8')).codigo, 'playlist_malformada');
        assert.equal((await v('/hls/sem-cabecalho.m3u8')).codigo, 'playlist_malformada');
        assert.equal((await v('/hls/sem-segmentos.m3u8')).codigo, 'playlist_malformada');
        assert.equal((await v('/hls/html.m3u8')).codigo, 'pagina_html');
    });
    test('HLS com segmento quebrado: 200 na playlist NÃO é sucesso', async () => {
        assert.equal((await v('/hls/segmento-html.m3u8')).codigo, 'segmento_invalido');
        assert.equal((await v('/hls/segmento-404.m3u8')).codigo, 'http_404');
        assert.equal((await v('/hls/master-quebrada.m3u8')).estado, 'falhou');
    });
    test('DRM é marcado "protegido" e não é aprofundado', async () => {
        S.zerar();
        const r = await v('/hls/drm.m3u8');
        assert.equal(r.estado, 'protegido');
        assert.equal(S.pedidos.get('/seg/1.ts'), undefined, 'não pode baixar segmento de conteúdo protegido');
        assert.equal((await v('/dash/drm.mpd')).estado, 'protegido');
    });
    test('DASH válido testa a inicialização; DASH malformado falha', async () => {
        const r = await v('/dash/ok.mpd');
        assert.equal(r.estado, 'ok'); assert.equal(r.detalhes.segmento, 'mp4');
        assert.equal((await v('/dash/ruim.mpd')).codigo, 'manifesto_malformado');
    });
    test('MP4/WebM pela assinatura; HTML/texto/vazio com extensão .mp4 falham', async () => {
        assert.equal((await v('/v/filme.mp4')).detalhes.assinatura, 'mp4');
        assert.equal((await v('/v/filme.webm')).detalhes.assinatura, 'webm/mkv');
        assert.equal((await v('/v/falso.mp4')).codigo, 'pagina_html');
        assert.equal((await v('/v/texto.mp4')).codigo, 'conteudo_invalido');
        assert.equal((await v('/v/vazio.mp4')).codigo, 'resposta_vazia');
        const sr = await v('/v/sem-range.mp4');
        assert.equal(sr.estado, 'ok'); assert.ok(sr.avisos.some(a => /Range/.test(a)));
    });
    test('HTTP inválido: 404/403 definitivos, 500 passageiro, timeout passageiro', async () => {
        const a = await v('/v/404.mp4'); assert.equal(a.codigo, 'http_404'); assert.equal(a.transitorio, false);
        const b = await v('/v/403.mp4'); assert.equal(b.codigo, 'http_403'); assert.equal(b.transitorio, false);
        const c = await v('/v/500.mp4'); assert.equal(c.codigo, 'http_500'); assert.equal(c.transitorio, true);
        const t0 = Date.now();
        const d = await v('/v/lento.mp4', { timeoutMs: 400 });
        assert.equal(d.codigo, 'timeout'); assert.equal(d.transitorio, true);
        assert.ok(Date.now() - t0 < 1200);
    });
    test('sem extensão: decide pelo conteúdo', async () => {
        assert.equal((await v('/semtipo/video')).estado, 'ok');
        assert.equal((await v('/semtipo/playlist')).tipo, 'hls');
        assert.equal((await v('/semtipo/pagina')).codigo, 'pagina_html');
    });
    test('formatos que a nuvem não testa ficam "nao_verificavel"', async () => {
        const R = req();
        for (const u of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'magnet:?xt=urn:btih:abc', 'rtmp://a/b', 'https://archive.org/details/x'])
            assert.equal((await verificar(u, { req: R.requisitar })).estado, 'nao_verificavel', u);
        assert.equal((await verificar('', { req: R.requisitar })).codigo, 'sem_url');
        R.encerrar();
    });
    test('domínio inexistente', async () => {
        const R = req();
        const r = await verificar(`http://naoexiste.teste:${S.porta}/a.mp4`, { req: R.requisitar });
        R.encerrar();
        assert.equal(r.codigo, 'dns'); assert.equal(r.transitorio, false);
    });
    test('detector concorda com o format-detector do player', () => {
        assert.equal(detectarTipo('https://a/b/live/u/p/123'), 'mpegts');
        assert.equal(detectarTipo('https://a/x.m3u8?token=1'), 'hls');
        assert.equal(detectarTipo('https://a/x.mpd'), 'dash');
        assert.equal(detectarTipo('https://a/x.mkv'), 'arquivo');
        assert.equal(detectarTipo('https://a/x'), 'generico');
        assert.equal(assinatura(Buffer.from('<html>')), null);
    });
    test('parser HLS: EXTINF sem URI é malformado', () => {
        assert.ok(analisarHls('#EXTM3U\n#EXTINF:1,\n', 'http://a/').erro);
    });
});

// =====================================================================================
describe('motor (concorrência, tentativas, cache, orçamento, interrupção)', () => {
    const motor = (o = {}) => criarMotor({ redesPermitidas: LOOP, resolver: resolverFalso, timeoutMs: 1500, esperaMs: [50, 100], intervaloPorHostMs: 0, ...o });

    test('no máximo 2 conexões por servidor e concorrência global respeitada', async () => {
        S.zerar();
        const links = [];
        for (const h of ['a.teste', 'b.teste', 'c.teste']) for (let i = 0; i < 6; i++) links.push({ url: S.url(h, `/v/demora-${h}-${i}.mp4`) });
        const M = motor({ porHost: 2, concorrencia: 4 });
        const { estat } = await M.testar(links, carregarCache(null));
        M.encerrar();
        assert.equal(estat.ok, 18);
        for (const h of ['a.teste', 'b.teste', 'c.teste']) assert.ok(S.maxHost.get(h) <= 2, `${h}: ${S.maxHost.get(h)}`);
    });

    test('nova tentativa só em falha passageira', async () => {
        S.zerar();
        const M = motor({ tentativas: 2 });
        const { resultados } = await M.testar([{ url: S.base + '/v/instavel.mp4' }, { url: S.base + '/v/404.mp4' }, { url: S.base + '/v/500.mp4' }], carregarCache(null));
        M.encerrar();
        assert.equal(resultados.get(S.base + '/v/instavel.mp4').estado, 'ok');
        assert.equal(S.pedidos.get('/v/instavel.mp4'), 2);
        assert.equal(S.pedidos.get('/v/404.mp4'), 1, '404 não pode ser repetido');
        assert.equal(S.pedidos.get('/v/500.mp4'), 3, '500: 1 + 2 tentativas');
    });

    test('429 com Retry-After curto espera e tenta; longo deixa para o próximo ciclo', async () => {
        S.zerar();
        const M = motor({ tentativas: 1 });
        const t0 = Date.now();
        const { resultados, estat } = await M.testar([{ url: S.url('x.teste', '/v/429.mp4') }, { url: S.url('y.teste', '/v/429-longo.mp4') }, { url: S.url('y.teste', '/v/filme.mp4') }], carregarCache(null));
        M.encerrar();
        assert.equal(resultados.get(S.url('x.teste', '/v/429.mp4')).estado, 'ok');
        assert.ok(Date.now() - t0 >= 900, 'respeitou o Retry-After de 1s');
        assert.equal(S.pedidos.get('/v/429-longo.mp4'), 1, 'não insiste em servidor que pediu 1h de pausa');
        assert.ok(estat.servidoresDesligados.some(h => h.startsWith('y.teste')));
    });

    test('disjuntor: servidor que só dá timeout é desligado no ciclo', async () => {
        S.zerar();
        const links = Array.from({ length: 8 }, (_, i) => ({ url: S.url('morto.teste', `/v/lento.mp4?${i}`) }));
        const M = motor({ timeoutMs: 200, tentativas: 0, disjuntorPorHost: 3, porHost: 1 });
        const { estat } = await M.testar(links, carregarCache(null));
        M.encerrar();
        assert.ok(estat.pulados >= 4, `pulados=${estat.pulados}`);
        assert.ok(S.pedidos.get('/v/lento.mp4') <= 4);
    });

    test('cache: link bom não é retestado; ruim é retestado; links repetidos testados 1 vez', async () => {
        S.zerar();
        const cache = carregarCache(null);
        const M = motor();
        const links = [{ url: S.base + '/v/filme.mp4' }, { url: S.base + '/v/404.mp4' }];
        const r1 = await M.testar(links, cache);
        M.registrar(cache, r1.resultados);
        const r2 = await M.testar(links, cache);
        M.encerrar();
        assert.equal(r2.estat.doCache, 1);
        assert.equal(S.pedidos.get('/v/filme.mp4'), 1);
        assert.equal(S.pedidos.get('/v/404.mp4'), 2);
        assert.ok(!JSON.stringify(cache).includes('filme.mp4'), 'o cache guarda só a chave, não o link');
    });

    test('formato antigo do health-cache.json é migrado', () => {
        const c = carregarCache({ abc123: { at: 1, fails: 2 } });
        assert.equal(c.versao, 2); assert.equal(c.itens.abc123.sf, 2);
    });

    test('orçamento de tempo: o que não coube fica "pulado"', async () => {
        const links = Array.from({ length: 30 }, (_, i) => ({ url: S.url('orc.teste', `/v/demora-orc-${i}.mp4`) }));
        const M = motor({ orcamentoMin: 0.004, porHost: 1, concorrencia: 1 }); // ~240 ms
        const { estat } = await M.testar(links, carregarCache(null));
        M.encerrar();
        assert.ok(estat.pulados > 0 && estat.motivoParada, JSON.stringify(estat));
    });

    test('limite de links por execução', async () => {
        const links = Array.from({ length: 10 }, (_, i) => ({ url: S.url('lim.teste', `/v/filme.mp4?${i}`) }));
        const M = motor({ limiteLinks: 4 });
        const { estat } = await M.testar(links, carregarCache(null));
        M.encerrar();
        assert.equal(estat.ok, 4); assert.equal(estat.pulados, 6);
    });

    test('interrupção no meio: para rápido e nada fica pela metade', async () => {
        const links = Array.from({ length: 20 }, (_, i) => ({ url: S.url('int.teste', `/v/lento.mp4?i${i}`) }));
        const ac = new AbortController();
        const M = motor({ timeoutMs: 5000, porHost: 2 });
        setTimeout(() => ac.abort(), 150);
        const t0 = Date.now();
        const { resultados, estat } = await M.testar(links, carregarCache(null), ac.signal);
        M.encerrar();
        assert.ok(Date.now() - t0 < 1500);
        assert.equal(estat.motivoParada, 'interrompido');
        assert.ok([...resultados.values()].every(r => r.estado === 'pulado'));
    });
});

// =====================================================================================
describe('seleção da melhor fonte', () => {
    const cache = carregarCache(null);
    const R = (m) => new Map(Object.entries(m));

    test('a que funciona vence; ordem original desempata', () => {
        const s = ordenarFontes(['a', 'b', 'c'], R({ a: { estado: 'falhou' }, b: { estado: 'ok', ttfb: 100 }, c: { estado: 'ok', ttfb: 100 } }), cache);
        assert.equal(s.escolhida, 'b'); assert.deepEqual(s.ordem, ['b', 'c', 'a']); assert.equal(s.trocou, true);
    });
    test('latência pesa entre as que funcionam', () => {
        const s = ordenarFontes(['http://x/a', 'http://y/b'], R({ 'http://x/a': { estado: 'falhou', transitorio: true }, 'http://y/b': { estado: 'ok', ttfb: 2000 } }), cache);
        assert.equal(s.escolhida, 'http://y/b');
        const t = ordenarFontes(['p', 'q'], R({ p: { estado: 'protegido' }, q: { estado: 'ok', ttfb: 3000 } }), cache);
        assert.equal(t.escolhida, 'q');
    });
    test('estabilidade: principal que funciona não é trocado por diferença pequena', () => {
        const s = ordenarFontes(['a', 'b'], R({ a: { estado: 'ok', ttfb: 500 }, b: { estado: 'ok', ttfb: 100 } }), cache);
        assert.equal(s.escolhida, 'a'); assert.equal(s.trocou, false);
    });
    test('prioridade configurada por servidor', () => {
        const s = ordenarFontes(['http://lento.com/a', 'http://meu.com/b'], R({ 'http://lento.com/a': { estado: 'ok', ttfb: 100 }, 'http://meu.com/b': { estado: 'ok', ttfb: 100 } }), cache, { prioridadeServidores: { 'meu.com': 5 } });
        assert.equal(s.escolhida, 'http://meu.com/b');
    });
    test('todas falhando → indisponível (e não inventa link)', () => {
        const s = ordenarFontes(['a', 'b'], R({ a: { estado: 'falhou' }, b: { estado: 'falhou' } }), cache);
        assert.equal(s.situacao, 'indisponivel'); assert.deepEqual(s.ordem.sort(), ['a', 'b']);
    });
    test('sem URL', () => {
        const s = ordenarFontes([], new Map(), cache);
        assert.equal(s.escolhida, null); assert.equal(s.situacao, 'indisponivel');
    });
});

// =====================================================================================
describe('validarCatalogo (itens do catálogo)', () => {
    function construtor(itens) {
        const items = new Map(itens.map(i => [i.id, structuredClone(i)]));
        return { items, remove(ids) { let n = 0; for (const id of ids) n += items.delete(id) ? 1 : 0; return n; } };
    }
    const tmp = async () => path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'czval-')), 'health.json');
    const rodar = (b, health, config = {}, extra = {}) => validarCatalogo(b, { config: { concorrencia: 8, timeoutMs: 1000, esperaMs: [50], intervaloPorHostMs: 0, ...config }, health, redesPermitidas: LOOP, resolver: resolverFalso, log: () => {}, ...extra });

    test('troca o principal quebrado pela reserva que funciona e mantém o antigo como reserva', async () => {
        const b = construtor([{ id: '1', title: 'Filme', url: S.base + '/v/404.mp4', mirrors: [S.base + '/v/filme.mp4'] }]);
        const val = await rodar(b, await tmp());
        const it = b.items.get('1');
        assert.equal(it.url, S.base + '/v/filme.mp4');
        assert.deepEqual(it.mirrors, [S.base + '/v/404.mp4']);
        assert.equal(val.detalhes.trocas.length, 1);
        assert.ok(!JSON.stringify(val.detalhes.trocas).includes('?token'));
    });

    test('várias URLs: ordena todas pela qualidade, sem perder nenhuma', async () => {
        const urls = ['/v/404.mp4', '/v/500.mp4', '/hls/master.m3u8', '/v/filme.mp4'].map(p => S.base + p);
        const b = construtor([{ id: '2', title: 'X', url: urls[0], mirrors: urls.slice(1) }]);
        await rodar(b, await tmp(), { tentativas: 0 });
        const it = b.items.get('2');
        assert.equal(new Set([it.url, ...it.mirrors]).size, 4);
        assert.ok(it.url.endsWith('/hls/master.m3u8') || it.url.endsWith('/v/filme.mp4'));
        assert.equal(it.mirrors[it.mirrors.length - 1], urls[0], 'o 404 (definitivo) vai para o fim');
    });

    test('todas falhando: marca indisponível só depois de 3 ciclos; volta se recuperar', async () => {
        const health = await tmp();
        const b = construtor([{ id: '3', title: 'Morto', url: S.base + '/v/404.mp4' }]);
        for (let i = 1; i <= 3; i++) {
            const val = await rodar(b, health);
            await val.confirmar();
            assert.equal(!!b.items.get('3').indisponivel, i >= 3, `ciclo ${i}`);
        }
        const csvDir = path.dirname(health);
        const val = await rodar(b, health);
        await val.gravarRelatorio(csvDir);
        const csv = await fs.readFile(path.join(csvDir, 'validacao-indisponiveis.csv'), 'utf8');
        assert.match(csv, /Morto/);
        // recuperou: o mesmo item agora com reserva boa
        b.items.get('3').mirrors = [S.base + '/v/filme.mp4'];
        const v2 = await rodar(b, health);
        assert.equal(b.items.get('3').indisponivel, undefined);
        assert.equal(v2.detalhes.recuperados.length, 1);
    });

    test('semFonte "remover" respeita a trava de remoção em massa', async () => {
        const health = await tmp();
        const itens = Array.from({ length: 5 }, (_, i) => ({ id: 'm' + i, title: 'M' + i, url: S.base + `/v/404.mp4?${i}` }));
        itens.push(...Array.from({ length: 20 }, (_, i) => ({ id: 'b' + i, title: 'B' + i, url: S.base + `/v/filme.mp4?${i}` })));
        const b = construtor(itens);
        for (let i = 0; i < 3; i++) { const val = await rodar(b, health, { semFonte: 'remover', limiteRemocaoPorCiclo: 0.1, cicloSuspeitoAcimaDe: 0.9 }); await val.confirmar(); }
        assert.equal(b.items.size, 25, 'acima de 10%: não remove, só marca');
        assert.ok(b.items.get('m0').indisponivel);
        const b2 = construtor(itens);
        const h2 = await tmp();
        for (let i = 0; i < 3; i++) { const val = await rodar(b2, h2, { semFonte: 'remover', limiteRemocaoPorCiclo: 0.5, cicloSuspeitoAcimaDe: 0.9 }); await val.confirmar(); }
        assert.equal(b2.items.size, 20);
    });

    test('ciclo suspeito (quase tudo falhou = rede do robô): ninguém ganha falha', async () => {
        const health = await tmp();
        const itens = Array.from({ length: 25 }, (_, i) => ({ id: 's' + i, title: 'S', url: S.base + `/v/404.mp4?s${i}` }));
        const b = construtor(itens);
        for (let i = 0; i < 4; i++) { const val = await rodar(b, health); assert.equal(val.relatorio.cicloSuspeito, true); await val.confirmar(); }
        assert.ok([...b.items.values()].every(it => !it.indisponivel));
    });

    test('modo "relatorio" não altera o catálogo; "desligado" não testa nada', async () => {
        const original = { id: '4', title: 'R', url: S.base + '/v/404.mp4', mirrors: [S.base + '/v/filme.mp4'] };
        const b = construtor([original]);
        const val = await rodar(b, await tmp(), { modo: 'relatorio' });
        assert.deepEqual(b.items.get('4'), original);
        assert.equal(val.relatorio.links.ok, 1);
        S.zerar();
        assert.equal(await rodar(b, await tmp(), { modo: 'desligado' }), null);
        assert.equal(S.pedidos.size, 0);
    });

    test('item sem URL, jogos e fontes com "validar": false ficam intactos', async () => {
        const itens = [
            { id: '5', title: 'Sem link', url: '' },
            { id: '6', title: 'Jogo', url: S.base + '/v/404.mp4', categoryType: 'game' },
            { id: '7', title: 'Pulado', url: S.base + '/v/404.mp4', mirrors: [S.base + '/v/filme.mp4'], origem: 'Minha fonte' }
        ];
        const b = construtor(itens);
        S.zerar();
        await rodar(b, await tmp(), {}, { fontes: [{ nome: 'Minha fonte', validar: false }] });
        for (const it of itens) assert.deepEqual(b.items.get(it.id), it);
        assert.equal(S.pedidos.size, 0);
    });

    test('apenasFontes: só as fontes da lista são testadas/alteradas; as outras ficam no original', async () => {
        const quebrado = S.base + '/v/404.mp4?af', bom = S.base + '/v/filme.mp4?af';
        const itens = [
            { id: 'a1', title: 'Saimo', url: quebrado, mirrors: [bom], origem: 'Filmes Saimo' },
            { id: 'a2', title: 'Canal', url: quebrado + '2', mirrors: [bom + '2'], origem: 'TVzine - Canais (Saimo)' },
            { id: 'a3', title: 'Outra', url: quebrado + '3', mirrors: [bom + '3'], origem: 'Desenhos 24 Horas' }
        ];
        const b = construtor(itens);
        S.zerar();
        const msgs = [];
        await rodar(b, await tmp(), { apenasFontes: ['filmes saimo ', 'TVzine - Canais (Saimo)', 'Séries Saimo'] },
            { fontes: [{ nome: 'Filmes Saimo' }, { nome: 'TVzine - Canais (Saimo)' }, { nome: 'Desenhos 24 Horas' }], log: m => msgs.push(m) });
        assert.equal(b.items.get('a1').url, bom);
        assert.equal(b.items.get('a2').url, bom + '2');
        assert.deepEqual(b.items.get('a3'), itens[2], 'fonte fora da lista: intacta');
        assert.equal(S.pedidos.get('/v/404.mp4') + S.pedidos.get('/v/filme.mp4'), 4, 'só 4 links testados');
        assert.ok(msgs.some(m => /não existem.*Séries Saimo/.test(m)), 'avisa nome que não existe');
    });

    test('lista "fontes" (idioma/qualidade do player) é só reordenada, objetos preservados', async () => {
        const fontes = [
            { url: S.base + '/v/404.mp4', idioma: 'dublado', qualidade: '1080p' },
            { url: S.base + '/v/filme.mp4', idioma: 'legendado', qualidade: '720p' }
        ];
        const b = construtor([{ id: '8', title: 'F', url: S.base + '/v/404.mp4', fontes }]);
        await rodar(b, await tmp());
        const it = b.items.get('8');
        assert.deepEqual(it.fontes, [fontes[1], fontes[0]]);
        assert.equal(it.url, S.base + '/v/filme.mp4');
        assert.deepEqual(it.mirrors, [S.base + '/v/404.mp4']);
    });

    test('execuções repetidas são idempotentes', async () => {
        const health = await tmp();
        const base = { id: '9', title: 'I', url: S.base + '/v/404.mp4', mirrors: [S.base + '/v/filme.mp4', S.base + '/v/filme.webm'] };
        const b = construtor([base]);
        let antes;
        for (let i = 0; i < 3; i++) {
            const val = await rodar(b, health); await val.confirmar();
            const agora = JSON.stringify(b.items.get('9'));
            if (antes) assert.equal(agora, antes, `execução ${i + 1}`);
            antes = agora;
        }
    });

    test('cache só é gravado em confirmar() (falha na publicação não suja o cache)', async () => {
        const health = await tmp();
        const b = construtor([{ id: '10', title: 'C', url: S.base + '/v/filme.mp4' }]);
        await rodar(b, health); // "publicação falhou": confirmar() não foi chamado
        await assert.rejects(fs.access(health));
        const val = await rodar(b, health);
        await val.confirmar();
        const c = JSON.parse(await fs.readFile(health, 'utf8'));
        assert.equal(c.versao, 2); assert.equal(Object.keys(c.links).length, 1);
    });
});
