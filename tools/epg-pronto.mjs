/**
 * epg-pronto.mjs — prepara o GUIA DE PROGRAMAÇÃO (EPG) no build, para o app não ter que fazer isso
 *
 * Por que: um XMLTV como o PlutoTV/all.xml.gz tem TODOS os países. Baixar, descompactar e ler isso
 * dentro de uma smart TV é o trabalho mais pesado do guia (e TVs antigas nem descompactam .gz).
 * Aqui, no GitHub Actions, isso é feito UMA vez: só ficam os canais que existem no catálogo e só a
 * janela de horário útil. A TV baixa arquivos JSON pequenos, sem .gz e sem XML.
 *
 * Saída (dentro da pasta do catálogo):
 *   epg/index.json   { v, geradoEm, de, ate, fontes:[urls lidas], chaves:{chave:xmlId}, canais:{xmlId:[fatia, [nomes]]}, fatias }
 *   epg/c/<n>.json   { xmlId: [[inicioSeg, fimSeg, titulo, desc, categoria], ...] }   (fatias por hash do xmlId)
 *
 * A função chavesDoNome() é a MESMA do tvzine-epg-engine.js / tvzine-epg-worker.js (precisa casar igual).
 */
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';

// ------------------------------------------------------------ normalização (IGUAL ao app)
const RUIDO = /\b(hd|fhd|uhd|sd|4k|8k|h265|hevc|720p|1080p|2160p|60fps|50fps|ao vivo|live|oficial|alt|backup|reserva|sinal|opcao \d)\b/g;
export function normalizarNome(bruto) {
    let s = String(bruto || '');
    if (s.includes('..')) s = s.split('..').pop();
    s = s.replace(/@[\w-]+$/, '');
    s = s.replace(/\.[a-z]{2}$/i, '');
    s = s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    s = s.replace(/&/g, ' and ').replace(/\+/g, ' plus ');
    s = s.replace(/[._\-\/|:]+/g, ' ').replace(/[\[(][^\])]*[\])]/g, ' ');
    s = s.replace(RUIDO, ' ');
    return s.replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}
export function chavesDoNome(bruto) {
    const base = normalizarNome(bruto);
    if (!base) return [];
    const out = new Set([base.replace(/ /g, '')]);
    const semTv = base.replace(/^tv /, '').replace(/ tv$/, '');
    const semPais = base.replace(/ (brasil|brazil|br)$/, '');
    out.add(semTv.replace(/ /g, ''));
    out.add(semPais.replace(/ /g, ''));
    out.add(semPais.replace(/^tv /, '').replace(/ /g, ''));
    out.delete('');
    return [...out];
}
// fatia de um xmlId (o app calcula igual se precisar)
export function fatiaDe(id, fatias) {
    let h = 2166136261;
    const s = String(id);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0) % fatias;
}

// ------------------------------------------------------------ XML
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decodificar = (s) => {
    if (!s) return '';
    s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
    return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
        if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(n); } catch { return m; } }
        return ENT[e.toLowerCase()] ?? m;
    }).trim();
};
const atributos = (txt) => { const o = {}; const re = /([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g; let m; while ((m = re.exec(txt))) o[m[1]] = m[3] !== undefined ? m[3] : m[4]; return o; };
const RE_TAG = { title: /<title\b[^>]*>([\s\S]*?)<\/title>/, desc: /<desc\b[^>]*>([\s\S]*?)<\/desc>/, category: /<category\b[^>]*>([\s\S]*?)<\/category>/ };
const tag = (inner, t) => { const m = RE_TAG[t].exec(inner); return m ? decodificar(m[1]) : ''; };
const dataXmltv = (str) => {
    const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-])?(\d{2})?:?(\d{2})?/.exec(String(str || '').trim());
    if (!m) return 0;
    let ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
    if (m[7]) ms -= (m[7] === '-' ? -1 : 1) * ((+m[8]) * 60 + (+(m[9] || 0))) * 60000;
    return ms;
};

/** Abre a fonte como texto (http(s) ou arquivo local), descompactando .gz pelos bytes mágicos. */
async function abrirTexto(url, timeout) {
    let corpo;
    if (/^https?:\/\//i.test(url)) {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), timeout);
        const r = await fetch(url, { signal: ac.signal, redirect: 'follow', headers: { 'User-Agent': 'CartoonzineCatalogBot/2.0' } });
        if (!r.ok) { clearTimeout(t); throw new Error('HTTP ' + r.status); }
        corpo = Readable.fromWeb(r.body);
        corpo.on('close', () => clearTimeout(t));
    } else {
        corpo = (await import('node:fs')).createReadStream(path.resolve(url));
    }
    // espia os 2 primeiros bytes
    const it = corpo[Symbol.asyncIterator]();
    const primeiro = await it.next();
    if (primeiro.done) return (async function* () {})();
    const gz = primeiro.value[0] === 0x1f && primeiro.value[1] === 0x8b;
    const resto = Readable.from((async function* () { yield primeiro.value; for (;;) { const n = await it.next(); if (n.done) return; yield n.value; } })());
    const fluxo = gz ? resto.pipe(zlib.createGunzip()) : resto;
    fluxo.setEncoding('utf8');
    return fluxo;
}

/**
 * @param {object} o
 * @param {Iterable} o.canais   itens ao vivo do catálogo (title, name, tvgId)
 * @param {string[]} o.urls     links XMLTV (manifest.epg)
 * @param {string} o.dir        pasta de saída (…/catalog/epg)
 * @returns {Promise<null|{arquivo, canais, programas, fontes}>}
 */
export async function gerarEpgPronto({ canais, urls, dir, log = console.log, timeout = 180000, antesH = 6, depoisH = 72, fatias = 64, descMax = 300 }) {
    // chaves dos canais do catálogo
    const validas = new Set();
    for (const c of canais) [c.tvgId, c.tvg_id, c.epgId, c.title, c.name].forEach(v => v && chavesDoNome(v).forEach(k => validas.add(k)));
    if (!validas.size || !urls.length) return null;

    const agora = Date.now(), de = agora - antesH * 3600e3, ate = agora + depoisH * 3600e3;
    const progs = new Map();      // xmlId → [[ini, fim, titulo, desc, cat]]
    const nomes = new Map();      // xmlId → [display-names]
    const fontesOk = [];

    for (const url of urls) {
        const t0 = Date.now();
        const decisao = new Map();
        const decidir = (id, ns) => {
            if (decisao.has(id)) return decisao.get(id);
            let ok = false;
            for (const n of [id, ...(ns || [])]) { for (const k of chavesDoNome(n)) if (validas.has(k)) { ok = true; break; } if (ok) break; }
            decisao.set(id, ok);
            return ok;
        };
        const local = new Map(), localNomes = new Map();
        let lidos = 0;
        const RE = /<channel\b([^>]*)>([\s\S]*?)<\/channel>|<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
        const processar = (texto) => {
            RE.lastIndex = 0; let m;
            while ((m = RE.exec(texto))) {
                if (m[1] !== undefined) {
                    const id = atributos(m[1]).id; if (!id) continue;
                    const ns = []; const reN = /<display-name\b[^>]*>([\s\S]*?)<\/display-name>/g; let n;
                    while ((n = reN.exec(m[2]))) ns.push(decodificar(n[1]));
                    decisao.delete(id);
                    if (decidir(id, ns)) localNomes.set(id, ns);
                } else {
                    const a = atributos(m[3]); const id = a.channel;
                    if (!id || !decidir(id)) continue;
                    const ini = dataXmltv(a.start), fim = dataXmltv(a.stop) || ini + 3600e3;
                    if (!ini || fim < de || ini > ate) continue;
                    let desc = tag(m[4], 'desc'); if (desc.length > descMax) desc = desc.slice(0, descMax - 1) + '…';
                    const p = [Math.round(ini / 1000), Math.round(fim / 1000), tag(m[4], 'title') || 'Programação'];
                    const cat = tag(m[4], 'category');
                    if (desc || cat) p.push(desc);
                    if (cat) p.push(cat);
                    (local.get(id) || local.set(id, []).get(id)).push(p);
                    lidos++;
                }
            }
        };
        try {
            const fluxo = await abrirTexto(url, timeout);
            let buf = '';
            for await (const pedaco of fluxo) {
                buf += pedaco;
                const corte = Math.max(buf.lastIndexOf('</programme>') + 12, buf.lastIndexOf('</channel>') + 10);
                if (corte > 11) { processar(buf.slice(0, corte)); buf = buf.slice(corte); }
                else if (buf.length > 8 * 1024 * 1024) buf = buf.slice(-1024 * 1024);
            }
            if (buf) processar(buf);
            // a 1ª fonte que tem o canal ganha (mesma regra do app)
            local.forEach((arr, id) => { if (!progs.has(id)) progs.set(id, arr); });
            localNomes.forEach((ns, id) => { if (!nomes.has(id)) nomes.set(id, ns); });
            fontesOk.push(url);
            log(`📺 EPG ${url.split('/').pop()}: ${local.size} canais do catálogo, ${lidos} programas (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
        } catch (e) {
            log(`✖ EPG ${url}: ${e.message || e} — o app tenta ler esse guia sozinho`);
        }
    }
    if (!progs.size) return { arquivo: null, canais: 0, programas: 0, fontes: fontesOk };

    // índice + fatias
    const chaves = {}, idx = {}, porFatia = new Map();
    let total = 0;
    progs.forEach((arr, id) => {
        arr.sort((a, b) => a[0] - b[0]);
        const limpo = arr.filter((p, i) => i === 0 || p[0] !== arr[i - 1][0]);
        total += limpo.length;
        const f = fatiaDe(id, fatias);
        idx[id] = [f, nomes.get(id) || []];
        (porFatia.get(f) || porFatia.set(f, {}).get(f))[id] = limpo;
        [id, ...(nomes.get(id) || [])].forEach(n => chavesDoNome(n).forEach(k => { if (validas.has(k) && !(k in chaves)) chaves[k] = id; }));
    });
    await fs.mkdir(path.join(dir, 'c'), { recursive: true });
    await Promise.all([...porFatia].map(([f, obj]) => fs.writeFile(path.join(dir, 'c', `${f}.json`), JSON.stringify(obj))));
    const indice = { v: 1, geradoEm: new Date().toISOString(), de: Math.round(de / 1000), ate: Math.round(ate / 1000), fatias, fontes: fontesOk, chaves, canais: idx };
    await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify(indice));
    log(`📺 EPG pronto: ${progs.size} canais, ${total} programas em ${porFatia.size} arquivos (epg/)`);
    return { arquivo: 'epg/index.json', canais: progs.size, programas: total, fontes: fontesOk };
}
