#!/usr/bin/env node
/**
 * build-catalog.mjs — "Fábrica" do catálogo do Cartoonzine
 *
 * Roda FORA do navegador (no seu PC ou no GitHub Actions), baixa todas as
 * fontes do sources.json, normaliza, remove duplicados, agrupa séries e gera
 * um catálogo estático FATIADO que o navegador lê aos pedaços:
 *
 *   catalog/
 *     manifest.json                 categorias, totais, destaques, versão
 *     cat/<categoria>/<n>.json      páginas de cards (ex.: 120 por página)
 *     series/<id>.json              temporadas + episódios de cada série
 *     items/<abc>.json              detalhe completo por ID (4096 fatias)
 *     search/<xx>.json              índice de busca por prefixo de 2 letras
 *
 * Uso:
 *   node tools/build-catalog.mjs --sources sources.json --out catalog
 *   node tools/build-catalog.mjs --check-streams --check-limit 5000
 *
 * Opções:
 *   --sources <arq>       manifesto de fontes (padrão: sources.json)
 *   --out <dir>           pasta de saída (padrão: catalog)
 *   --page-size <n>       cards por página (padrão: 120)
 *   --concurrency <n>     downloads simultâneos (padrão: 6)
 *   --timeout <ms>        timeout por download (padrão: 60000)
 *   --check-streams       testa se os links respondem (remove os mortos)
 *   --check-limit <n>     máximo de links testados por execução (padrão: 3000)
 *   --health <arq>        memória dos testes entre execuções (padrão: health-cache.json)
 *   --force               publica mesmo se o catálogo encolher mais de 50%
 *   --compat-episodios    gera também TODOS os episódios em lotes (só para o modo antigo
 *                         seriesComoEpisodios: true — ocupa bastante espaço)
 */
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const Core = require(path.join(__dirname, '..', 'catalog-core.js'));

// ------------------------------------------------------------------ args
function parseArgs(argv) {
    const a = {
        sources: 'sources.json', out: 'catalog', pageSize: 120, concurrency: 6,
        timeout: 60000, checkStreams: false, checkLimit: 3000, health: 'health-cache.json',
        checkTimeout: 8000, maxFails: 3
    };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i], v = argv[i + 1];
        switch (k) {
            case '--sources': a.sources = v; i++; break;
            case '--out': a.out = v; i++; break;
            case '--page-size': a.pageSize = +v; i++; break;
            case '--concurrency': a.concurrency = +v; i++; break;
            case '--timeout': a.timeout = +v; i++; break;
            case '--check-streams': a.checkStreams = true; break;
            case '--check-limit': a.checkLimit = +v; i++; break;
            case '--health': a.health = v; i++; break;
            case '--force': a.force = true; break;
            case '--compat-episodios': a.compatEpisodios = true; break;
            default: console.warn('Opção desconhecida:', k);
        }
    }
    return a;
}

const log = (...m) => console.log('[catalog]', ...m);

// ------------------------------------------------------------------ utilidades
function limiter(n) {
    let active = 0; const q = [];
    const next = () => {
        if (active >= n || !q.length) return;
        active++;
        const { fn, res, rej } = q.shift();
        fn().then(res, rej).finally(() => { active--; next(); });
    };
    return fn => new Promise((res, rej) => { q.push({ fn, res, rej }); next(); });
}

async function fetchRetry(url, { timeout, retries = 2, init = {} }) {
    let lastErr;
    for (let t = 0; t <= retries; t++) {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), timeout);
        try {
            const r = await fetch(url, { ...init, signal: ac.signal, headers: { 'User-Agent': 'CartoonzineCatalogBot/2.0', ...(init.headers || {}) } });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return { r, done: () => clearTimeout(timer) };
        } catch (e) {
            clearTimeout(timer);
            lastErr = e;
            if (t < retries) await new Promise(ok => setTimeout(ok, 800 * 2 ** t));
        }
    }
    throw lastErr;
}

/** Lê uma fonte (URL http(s) ou arquivo local) chamando onChunk com texto. */
async function readSource(url, opts, onChunk) {
    if (!/^https?:\/\//i.test(url)) {
        const stream = fss.createReadStream(path.resolve(url), { encoding: 'utf8', highWaterMark: 1 << 20 });
        for await (const chunk of stream) onChunk(chunk);
        return;
    }
    const { r, done } = await fetchRetry(url, opts);
    try {
        const decoder = new TextDecoder();
        for await (const part of r.body) onChunk(decoder.decode(part, { stream: true }));
        onChunk(decoder.decode());
    } finally { done(); }
}

async function writeJSON(file, data) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(data));
}

/** Escreve muitos arquivos com concorrência limitada. */
async function writeMany(entries, conc = 64) {
    const run = limiter(conc);
    await Promise.all(entries.map(([f, d]) => run(() => writeJSON(f, d))));
}

// ------------------------------------------------------------------ ingestão
async function ingest(builder, src, args, epgSet) {
    const fmt = Core.sourceFormat(src);
    const t0 = Date.now();
    let n = 0;
    if (fmt === 'm3u') {
        const parser = Core.createM3UParser(
            raw => { n += builder.addRaw(raw, src); },
            h => h.epg.forEach(u => epgSet.add(u))
        );
        await readSource(src.url, { timeout: args.timeout }, c => parser.push(c));
        parser.end();
    } else {
        let text = '';
        await readSource(src.url, { timeout: args.timeout }, c => { text += c; });
        const lista = Core.extractList(JSON.parse(text));
        text = null;
        for (const raw of lista) n += builder.addRaw(raw, src);
    }
    log(`✔ ${src.nome}: +${n} itens (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    return n;
}

// ------------------------------------------------------------------ saúde dos streams
async function checkStreams(builder, args) {
    let cache = {};
    try { cache = JSON.parse(await fs.readFile(args.health, 'utf8')); } catch { /* primeira execução */ }

    // Testa primeiro quem nunca foi testado, depois os mais antigos
    const candidates = [...builder.items.values()]
        .filter(it => /^https?:/i.test(it.url) && it.categoryType !== 'game')
        .sort((a, b) => (cache[a.id]?.at || 0) - (cache[b.id]?.at || 0))
        .slice(0, args.checkLimit);

    log(`🩺 Testando ${candidates.length} streams...`);
    const run = limiter(Math.max(args.concurrency * 4, 16));
    let ok = 0, bad = 0;
    await Promise.all(candidates.map(it => run(async () => {
        let alive = false;
        for (const url of Core.streamCandidates(it)) {
            try {
                const { r, done } = await fetchRetry(url, {
                    timeout: args.checkTimeout, retries: 0,
                    init: { method: 'GET', headers: { Range: 'bytes=0-1023', ...(it.headers || {}) } }
                });
                done();
                r.body?.cancel?.();
                alive = true;
                if (url !== it.url) { // espelho funcionou e o principal não: promove
                    it.mirrors = [it.url, ...(it.mirrors || []).filter(u => u !== url)];
                    it.url = url;
                }
                break;
            } catch { /* tenta o próximo espelho */ }
        }
        const prev = cache[it.id] || { fails: 0 };
        cache[it.id] = { at: Date.now(), fails: alive ? 0 : prev.fails + 1 };
        alive ? ok++ : bad++;
    })));

    // Remove só quem falhou várias execuções seguidas (evita apagar por instabilidade)
    const dead = new Set(Object.entries(cache)
        .filter(([id, h]) => h.fails >= args.maxFails && builder.items.has(id))
        .map(([id]) => id));
    const removed = builder.remove(dead);
    await fs.writeFile(args.health, JSON.stringify(cache));
    log(`🩺 ok=${ok} falhou=${bad} removidos(≥${args.maxFails} falhas)=${removed}`);
}

// ------------------------------------------------------------------ saída
async function emit(builder, args, epg, sourcesReport) {
    const tmp = args.out + '.tmp-' + Date.now();
    await fs.rm(tmp, { recursive: true, force: true });
    const writes = [];
    const categories = [];
    const usedSlugs = new Set();
    const destaques = [];

    // 1) Páginas por categoria
    for (const cat of builder.categories()) {
        let s = cat.slug, i = 2;
        while (usedSlugs.has(s)) s = `${cat.slug}-${i++}`;
        usedSlugs.add(s);
        const ids = builder.catCards.get(cat.nome);
        const pages = Math.ceil(ids.length / args.pageSize);
        for (let p = 0; p < pages; p++) {
            const cards = ids.slice(p * args.pageSize, (p + 1) * args.pageSize).map(id => builder.card(id, cat.nome));
            for (const c of cards) if (c.destaque && destaques.length < 40) destaques.push(c);
            writes.push([path.join(tmp, 'cat', s, `${p}.json`), cards]);
        }
        const entry = { nome: cat.nome, slug: s, type: cat.type, destino: cat.destino, total: ids.length, pages };
        // Formato do motor antigo: episódios "achatados" (um item por episódio) em lotes
        if (cat.type === 'series' && args.compatEpisodios) {
            const eps = [];
            for (const id of ids) if (builder.series.has(id)) eps.push(...builder.compatEpisodes(id, cat.nome));
            const LOTE = 5000;
            entry.compatPages = Math.ceil(eps.length / LOTE);
            entry.compatTotal = eps.length;
            for (let p = 0; p < entry.compatPages; p++) {
                writes.push([path.join(tmp, 'compat', s, `${p}.json`), eps.slice(p * LOTE, (p + 1) * LOTE)]);
            }
        }
        categories.push(entry);
    }

    // 2) Séries
    for (const sid of builder.series.keys()) {
        writes.push([path.join(tmp, 'series', `${sid}.json`), builder.seriesDetail(sid)]);
    }

    // 3) Itens completos fatiados por hash do ID
    const shards = new Map();
    const put = (id, obj) => {
        const k = Core.idShard(id);
        if (!shards.has(k)) shards.set(k, {});
        shards.get(k)[id] = obj;
    };
    for (const [id, it] of builder.items) put(id, it);
    for (const sid of builder.series.keys()) put(sid, builder.seriesCard(sid));
    for (const [k, obj] of shards) writes.push([path.join(tmp, 'items', `${k}.json`), obj]);

    // 4) Índice de busca adaptativo: começa por prefixo de 2 letras e,
    //    se a fatia passar de MAX_ROWS, subdivide em 3, 4... letras.
    //    Formato compacto: [tituloNormalizado, id, titulo, thumb, cat, categoryType]
    const MAX_ROWS = 3000, MAX_DEPTH = 6, MAX_CAP = 5000;
    const allRows = [];
    const rowTokens = [];
    const addSearch = (card) => {
        allRows.push([Core.normText(card.title), card.id, card.title, card.thumb, card.cat, card.categoryType]);
        rowTokens.push(Core.searchTokens(card.title));
    };
    for (const it of builder.items.values()) if (it.categoryType !== 'episode') addSearch(it);
    for (const sid of builder.series.keys()) addSearch(builder.seriesCard(sid));

    const search = new Map();
    // entries = [rowIndex, token]; divide recursivamente por prefixo
    const bucketize = (entries, depth) => {
        const groups = new Map();
        for (const e of entries) {
            const k = e[1].length >= depth ? e[1].slice(0, depth) : e[1].padEnd(depth, '_');
            if (!groups.has(k)) groups.set(k, []);
            groups.get(k).push(e);
        }
        for (const [k, g] of groups) {
            const uniq = [...new Set(g.map(e => e[0]))];
            const canSplit = depth < MAX_DEPTH && !k.endsWith('_') && g.some(e => e[1].length > depth);
            if (uniq.length > MAX_ROWS && canSplit) {
                // palavras que terminam exatamente aqui ficam na fatia "k_"
                const exact = g.filter(e => e[1].length === depth);
                if (exact.length) search.set(k + '_', [...new Set(exact.map(e => e[0]))].map(i => allRows[i]));
                bucketize(g.filter(e => e[1].length > depth), depth + 1);
            } else {
                // Palavra comuníssima (ex.: "amor" em 40 mil títulos): guarda os títulos
                // mais curtos (mais relevantes). Buscas com mais palavras usam a fatia
                // da palavra mais rara, então continuam precisas.
                let rows = uniq.map(i => allRows[i]);
                if (rows.length > MAX_CAP) rows = rows.sort((a, b) => a[0].length - b[0].length).slice(0, MAX_CAP);
                search.set(k, rows);
            }
        }
    };
    const entries = [];
    rowTokens.forEach((tks, i) => { for (const t of tks) entries.push([i, t]); });
    bucketize(entries, 2);
    for (const [k, rows] of search) writes.push([path.join(tmp, 'search', `${k}.json`), rows]);

    log(`💾 Gravando ${writes.length} arquivos...`);
    await writeMany(writes);

    const totals = { itens: builder.items.size, series: builder.series.size, categorias: categories.length };
    const byType = {};
    for (const it of builder.items.values()) byType[it.categoryType] = (byType[it.categoryType] || 0) + 1;
    totals.porTipo = byType;

    const manifest = {
        schema: 2,
        version: Core.cyrb53(JSON.stringify(categories) + Date.now()).toString(36),
        generatedAt: new Date().toISOString(),
        pageSize: args.pageSize,
        totals,
        categories,
        destaques,
        epg: [...epg],
        searchShards: [...search.keys()].sort(),
        fontes: sourcesReport
    };
    await writeJSON(path.join(tmp, 'manifest.json'), manifest);

    // Troca atômica: o site nunca vê um catálogo pela metade
    const old = args.out + '.old-' + Date.now();
    if (fss.existsSync(args.out)) await fs.rename(args.out, old);
    await fs.rename(tmp, args.out);
    await fs.rm(old, { recursive: true, force: true });
    return manifest;
}

// ------------------------------------------------------------------ main
async function main() {
    const args = parseArgs(process.argv);
    const t0 = Date.now();
    const cfg = JSON.parse(await fs.readFile(args.sources, 'utf8'));
    const sources = (Array.isArray(cfg) ? cfg : cfg.fontes || cfg.sources || []);
    const builder = new Core.CatalogBuilder();
    const epg = new Set();
    const report = [];

    // Fontes "aoVivo" ficam de fora: o navegador carrega essas direto (listas pequenas que mudam muito)
    const usable = sources.filter(s => s.ativo !== false && s.aoVivo !== true && Core.isUsableUrl(s.url));
    log(`Fontes: ${usable.length} ativas de ${sources.length} (sem URL/placeholder/aoVivo são ignoradas)`);

    // Baixa em paralelo, mas ingere na ORDEM do manifesto (ordem das categorias estável).
    // Fontes JSON ficam em memória até a vez delas; M3U são lidos em streaming na vez.
    const run = limiter(args.concurrency);
    const prefetched = usable.map(src => Core.sourceFormat(src) === 'json' && /^https?:/i.test(src.url)
        ? run(async () => {
            const { r, done } = await fetchRetry(src.url, { timeout: args.timeout });
            try { return await r.text(); } finally { done(); }
        }).catch(e => ({ error: e }))
        : null);

    for (let i = 0; i < usable.length; i++) {
        const src = usable[i];
        try {
            let n;
            if (prefetched[i]) {
                const text = await prefetched[i];
                if (text && text.error) throw text.error;
                const before = builder.items.size;
                for (const raw of Core.extractList(JSON.parse(text))) builder.addRaw(raw, src);
                n = builder.items.size - before;
                log(`✔ ${src.nome}: +${n} itens`);
            } else {
                n = await ingest(builder, src, args, epg);
            }
            report.push({ nome: src.nome, ok: true, itens: n });
        } catch (e) {
            log(`✖ ${src.nome}: ${e.message}`);
            report.push({ nome: src.nome, ok: false, erro: String(e.message || e) });
        }
    }

    // Trava de segurança: nunca troca um catálogo bom por um quebrado
    if (usable.length && report.every(r => !r.ok)) {
        log('✖ Todas as fontes falharam — catálogo anterior mantido.');
        process.exit(1);
    }
    try {
        const prev = JSON.parse(await fs.readFile(path.join(args.out, 'manifest.json'), 'utf8'));
        if (!args.force && builder.items.size < prev.totals.itens * 0.5) {
            log(`✖ Catálogo encolheu de ${prev.totals.itens} para ${builder.items.size} itens (>50%). Use --force se for intencional. Catálogo anterior mantido.`);
            process.exit(1);
        }
    } catch { /* sem catálogo anterior */ }

    if (args.checkStreams) await checkStreams(builder, args);

    const m = await emit(builder, args, epg, report);
    log(`✅ Pronto em ${((Date.now() - t0) / 1000).toFixed(1)}s — ${m.totals.itens} itens, ${m.totals.series} séries, ${m.totals.categorias} categorias`);
    log(`   duplicados mesclados: ${builder.stats.duplicados}`);
    if (report.some(r => !r.ok)) process.exitCode = report.every(r => !r.ok) ? 1 : 0;
}

main().catch(e => { console.error(e); process.exit(1); });
