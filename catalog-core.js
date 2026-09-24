/**
 * @fileoverview catalog-core.js — Núcleo compartilhado do Cartoonzine
 * Roda IGUAL no navegador (window.CatalogCore) e no Node (require).
 * Tudo que define "o que é um item" mora aqui: IDs estáveis, parsers
 * M3U/JSON, normalização, deduplicação, agrupamento de séries e busca.
 * Assim o pipeline de build e o modo legado do navegador nunca divergem.
 */
(function (root, factory) {
    const api = factory();
    // Sempre publica no global (window/self), MESMO que exista um "module"
    // na página (Electron, NW.js, bundlers, outras libs) — antes isso fazia
    // o núcleo "sumir" para o cloud-engine.js.
    if (root) root.CatalogCore = api;
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    // Avisa quem estiver esperando (cloud-engine.js carregado antes/async)
    if (root && typeof root.dispatchEvent === 'function' && typeof Event === 'function') {
        try { root.dispatchEvent(new Event('catalogcore:ready')); } catch (e) { /* ignore */ }
    }
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const PLACEHOLDER = './assets/img/loja-bg.jpg';
    const DESC_CARD_MAX = 600;

    // ------------------------------------------------------------------
    // Hash e IDs estáveis
    // ------------------------------------------------------------------
    /** cyrb53: hash rápido de 53 bits, funciona com qualquer Unicode. */
    function cyrb53(str, seed = 0) {
        let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
        for (let i = 0; i < str.length; i++) {
            const ch = str.charCodeAt(i);
            h1 = Math.imul(h1 ^ ch, 2654435761);
            h2 = Math.imul(h2 ^ ch, 1597334677);
        }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        return 4294967296 * (2097151 & h2) + (h1 >>> 0);
    }

    /** Mesmo conteúdo => mesmo ID, sempre (favoritos e "continuar assistindo" não quebram). */
    function makeId(prefix, key) {
        return `${prefix}_${cyrb53(String(key)).toString(36).toUpperCase()}`;
    }

    /** Fatia de 3 caracteres hex usada para distribuir itens em arquivos (4096 fatias). */
    function idShard(id) {
        return (cyrb53(String(id), 7) & 0xfff).toString(16).padStart(3, '0');
    }

    // ------------------------------------------------------------------
    // Texto
    // ------------------------------------------------------------------
    function normText(s) {
        return String(s == null ? '' : s)
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    }

    function slug(s) {
        return normText(s).replace(/ /g, '-') || 'geral';
    }

    function normUrl(u) {
        if (!u) return '';
        return String(u).trim().replace(/#.*$/, '');
    }

    const STOP = new Set(['a', 'o', 'e', 'de', 'da', 'do', 'das', 'dos', 'the', 'of', 'and', 'em', 'hd', 'fhd', 'sd', '4k']);

    /** Palavras pesquisáveis de um título (sem acento, sem stopwords). */
    function searchTokens(title) {
        const out = [];
        for (const w of normText(title).split(' ')) {
            if (w.length >= 2 && !STOP.has(w) && !out.includes(w)) out.push(w);
        }
        return out;
    }

    /** Chave do arquivo de busca: 2 primeiros caracteres da palavra. */
    function searchShardKey(token) {
        return normText(token).replace(/ /g, '').slice(0, 2).padEnd(2, '_');
    }

    /** Verifica se todas as palavras da consulta casam (por prefixo) com o título. */
    function matchesQuery(normTitle, queryTokens) {
        const words = normTitle.split(' ');
        return queryTokens.every(q => words.some(w => w.startsWith(q)));
    }

    // ------------------------------------------------------------------
    // Detecção de episódios em títulos ("Show S01E02", "Show T1E2", "Show 1x02")
    // ------------------------------------------------------------------
    const EP_RE = /^(.*?)[\s._\-–|:]*(?:[ST](\d{1,2})\s*[E](\d{1,4})|(\d{1,2})x(\d{1,3}))\b/i;

    function detectEpisode(title) {
        const m = EP_RE.exec(String(title || ''));
        if (!m) return null;
        const serie = m[1].replace(/[\s._\-–|:]+$/, '').trim();
        if (!serie) return null;
        return {
            serie,
            season: parseInt(m[2] || m[4], 10),
            episode: parseInt(m[3] || m[5], 10)
        };
    }

    const VOD_EXT = /\.(mp4|mkv|avi|mov|webm|m4v)(\?|$)/i;

    // ------------------------------------------------------------------
    // Parser M3U incremental (aceita pedaços de texto — serve p/ arquivos gigantes)
    // ------------------------------------------------------------------
    function createM3UParser(onEntry, onHeader) {
        let buffer = '';
        let cur = null;
        let pendingOpts = {};

        function parseAttrs(line) {
            const attrs = {};
            const re = /([\w-]+)="([^"]*)"/g;
            let m;
            while ((m = re.exec(line))) attrs[m[1].toLowerCase()] = m[2];
            return attrs;
        }

        function handleLine(raw) {
            const line = raw.trim();
            if (!line) return;
            if (line.startsWith('#EXTM3U')) {
                const a = parseAttrs(line);
                const epg = a['url-tvg'] || a['x-tvg-url'];
                if (epg && onHeader) onHeader({ epg: epg.split(',').map(s => s.trim()).filter(Boolean) });
                return;
            }
            if (line.startsWith('#EXTINF')) {
                const attrs = parseAttrs(line);
                // título = texto após a última vírgula que está FORA de aspas
                let inQ = false, idx = -1;
                for (let i = 0; i < line.length; i++) {
                    if (line[i] === '"') inQ = !inQ;
                    else if (line[i] === ',' && !inQ) idx = i;
                }
                cur = {
                    title: idx !== -1 ? line.slice(idx + 1).trim() : (attrs['tvg-name'] || ''),
                    thumb: attrs['tvg-logo'] || '',
                    group: attrs['group-title'] || '',
                    tvgId: attrs['tvg-id'] || '',
                    tvgName: attrs['tvg-name'] || ''
                };
                return;
            }
            if (line.startsWith('#EXTGRP:')) { if (cur) cur.group = cur.group || line.slice(8).trim(); return; }
            if (line.startsWith('#EXTVLCOPT:')) {
                const opt = line.slice(11);
                const eq = opt.indexOf('=');
                if (eq > 0) pendingOpts[opt.slice(0, eq).trim()] = opt.slice(eq + 1).trim();
                return;
            }
            if (line.startsWith('#')) return;
            // Qualquer linha não-comentário é URL (http, https, rtmp, rtsp, relativa...)
            if (cur) {
                cur.url = line;
                const headers = {};
                if (pendingOpts['http-user-agent']) headers['User-Agent'] = pendingOpts['http-user-agent'];
                if (pendingOpts['http-referrer']) headers['Referer'] = pendingOpts['http-referrer'];
                if (Object.keys(headers).length) cur.headers = headers;
                if (!cur.title) cur.title = cur.tvgName || 'Sem nome';
                onEntry(cur);
            }
            cur = null;
            pendingOpts = {};
        }

        return {
            push(chunk) {
                buffer += chunk;
                let start = 0, nl;
                while ((nl = buffer.indexOf('\n', start)) !== -1) {
                    handleLine(buffer.slice(start, nl));
                    start = nl + 1;
                }
                buffer = buffer.slice(start);
            },
            end() {
                if (buffer) handleLine(buffer);
                buffer = '';
            }
        };
    }

    function parseM3U(text) {
        const out = [];
        let epg = [];
        const p = createM3UParser(e => out.push(e), h => { epg = epg.concat(h.epg); });
        p.push(text);
        p.end();
        return { entries: out, epg };
    }

    // ------------------------------------------------------------------
    // Fontes: tipos do manifesto -> tipo de item
    // ------------------------------------------------------------------
    /** Formato do arquivo de uma fonte (json ou m3u). */
    function sourceFormat(src) {
        if (src.formato) return src.formato;
        if (src.tipo === 'vod_m3u' || src.tipo === 'tvzine_worker') return 'm3u';
        if (/\.m3u8?(\?|$)/i.test(src.url || '')) return 'm3u';
        return 'json';
    }

    /** Para qual "prateleira" antiga do app a fonte vai (compatibilidade). */
    function destinoDe(src) {
        if (src.destino) return src.destino;
        return { tvzine_worker: 'iptv', radio: 'radio', emulator_json: 'games' }[src.tipo] || 'videos';
    }

    function isUsableUrl(u) {
        return !!u && !/SEU_USER|SEU_REPO/.test(u);
    }

    /** Extrai a lista de um JSON com formatos variados. */
    function extractList(dados) {
        if (Array.isArray(dados)) return dados;
        if (!dados || typeof dados !== 'object') return [];
        for (const k of ['data', 'items', 'results', 'videos', 'channels', 'games', 'roms', 'movies', 'series']) {
            if (Array.isArray(dados[k])) return dados[k];
        }
        const firstArr = Object.values(dados).find(Array.isArray);
        return firstArr || [];
    }

    function clean(obj) {
        for (const k of Object.keys(obj)) {
            const v = obj[k];
            if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) delete obj[k];
        }
        return obj;
    }

    function asGenre(g) {
        if (!g) return undefined;
        if (Array.isArray(g)) return g.map(String).filter(Boolean);
        return String(g).split(/[,/|]/).map(s => s.trim()).filter(Boolean);
    }

    // Campos que o normalize já trata; qualquer OUTRO campo do seu JSON
    // (ex.: previewVtt, trailer, idade, elenco...) é mantido como veio.
    const CAMPOS_CONHECIDOS = new Set(['title', 'name', 'nome', 'tvgName', 'thumb', 'posterUrl', 'poster', 'logo', 'image', 'cover',
        'bannerThumb', 'backdropUrl', 'backdrop', 'url',
        'desc', 'overview', 'description', 'year', 'genre', 'genres', 'cat', 'category', 'group', 'console',
        'tvgId', 'tvg_id', 'headers', 'destaque', 'id', 'seasons', 'episodes', 'episode', 'season', 'number', 'still',
        'categoryType', 'provider', 'origem', 'mirrors', 'seriesId', 'serie', 'cats']);

    function extras(raw) {
        const out = {};
        if (!raw || typeof raw !== 'object') return out;
        for (const k of Object.keys(raw)) {
            if (CAMPOS_CONHECIDOS.has(k) || k.startsWith('_')) continue;
            const v = raw[k];
            if (v === undefined || v === null || v === '') continue;
            out[k] = v;
        }
        return out;
    }

    /**
     * Converte um registro bruto (de JSON ou M3U) em 0..N itens normalizados.
     * Séries com "seasons" viram N episódios (agrupados depois pelo builder).
     */
    function normalize(raw, src) {
        const prefix = src.prefixoId || (src.tipo === 'emulator_json' ? 'GAME' : src.tipo === 'radio' ? 'RAD' : 'LIV');
        const baseCat = src.targetCategory || raw.group || raw.category || raw.cat || src.nome || 'Geral';
        const origem = src.nome;
        const _dest = destinoDe(src);

        // --- Série no formato {title, seasons:[{season, episodes:[...]}]} ---
        if (Array.isArray(raw.seasons)) {
            const serie = raw.title || raw.name || 'Série';
            const seriesId = makeId(prefix, 'serie|' + normText(serie) + '|' + (raw.year || ''));
            const meta = {
                serie, seriesId,
                thumb: raw.posterUrl || raw.thumb || raw.poster || raw.logo,
                bannerThumb: raw.backdropUrl || raw.bannerThumb || raw.backdrop,
                desc: raw.overview || raw.desc || raw.description,
                year: raw.year, genre: asGenre(raw.genre || raw.genres),
                extra: extras(raw), destaque: raw.destaque ? true : undefined
            };
            const out = [];
            for (const temp of raw.seasons) {
                const s = parseInt(temp.season ?? temp.number ?? 1, 10);
                for (const ep of (temp.episodes || [])) {
                    const e = parseInt(ep.episode ?? ep.number ?? out.length + 1, 10);
                    const url = normUrl(ep.url || ep.streamUrl || ep.link);
                    if (!url) continue;
                    out.push(clean({
                        ...extras(ep),
                        id: makeId(prefix, `ep|${seriesId}|${s}|${e}`),
                        _key: `ep|${seriesId}|${s}|${e}`,
                        title: ep.title ? `${serie} - T${s}E${e} - ${ep.title}` : `${serie} - T${s}E${e}`,
                        epTitle: ep.title,
                        serie, seriesId, season: s, episode: e,
                        thumb: ep.thumb || ep.still || meta.thumb,
                        bannerThumb: meta.bannerThumb,
                        url,
                        desc: ep.overview || ep.desc || meta.desc,
                        year: meta.year, genre: meta.genre,
                        cat: baseCat, categoryType: 'episode',
                        origem, _dest, _seriesMeta: meta
                    }));
                }
            }
            return out;
        }

        const url = normUrl(raw.url || raw.streamUrl || raw.stream_url || raw.link || raw.rom || raw.file || raw.src);
        if (!url) return [];
        const title = String(raw.title || raw.name || raw.nome || raw.tvgName || 'Sem nome').trim();

        // Tipo do item
        let categoryType;
        if (src.categoryType) categoryType = src.categoryType;
        else if (src.tipo === 'emulator_json') categoryType = 'game';
        else if (src.tipo === 'radio') categoryType = 'radio';
        else if (src.tipo === 'vod_json') categoryType = 'vod';
        else categoryType = VOD_EXT.test(url) ? 'vod' : 'live';

        const item = {
            ...extras(raw),
            title,
            thumb: raw.thumb || raw.posterUrl || raw.poster || raw.logo || raw.image || raw.cover,
            bannerThumb: raw.bannerThumb || raw.backdropUrl || raw.backdrop,
            url,
            desc: raw.desc || raw.overview || raw.description,
            year: raw.year ? parseInt(raw.year, 10) || undefined : undefined,
            genre: asGenre(raw.genre || raw.genres),
            cat: baseCat,
            categoryType,
            console: src.console || raw.console,
            tvgId: raw.tvgId || raw.tvg_id,
            headers: raw.headers,
            destaque: raw.destaque ? true : undefined,
            origem, _dest
        };

        // Episódio solto em lista M3U/JSON de VOD? ("Naruto S01E03")
        if (src.agruparSeries !== false && (categoryType === 'vod' || (categoryType === 'live' && VOD_EXT.test(url)))) {
            const ep = detectEpisode(title);
            if (ep) {
                const seriesId = makeId(prefix, 'serie|' + normText(ep.serie) + '|');
                Object.assign(item, {
                    categoryType: 'episode', serie: ep.serie, seriesId,
                    season: ep.season, episode: ep.episode,
                    _seriesMeta: { serie: ep.serie, seriesId, thumb: item.thumb, bannerThumb: item.bannerThumb, desc: item.desc, year: item.year, genre: item.genre }
                });
                item._key = `ep|${seriesId}|${ep.season}|${ep.episode}`;
            }
        }

        // Chave de deduplicação: mesma obra de fontes diferentes vira UM item com espelhos
        if (!item._key) {
            if (categoryType === 'vod' && item.year) item._key = `vod|${normText(title)}|${item.year}`;
            else if (categoryType === 'live' && item.tvgId) item._key = `live|${item.tvgId.toLowerCase()}`;
            else if (categoryType === 'game') item._key = `game|${item.console || ''}|${normText(title)}`;
            else item._key = `${categoryType}|${url}`;
        }
        item.id = raw.id && src.manterIdOriginal ? String(raw.id) : makeId(prefix, item._key);
        return [clean(item)];
    }

    // ------------------------------------------------------------------
    // CatalogBuilder: junta, deduplica, agrupa séries e organiza por categoria
    // ------------------------------------------------------------------
    class CatalogBuilder {
        constructor(opts = {}) {
            this.maxItems = opts.maxItems || Infinity;
            this.items = new Map();       // id -> item completo
            this.keyToId = new Map();     // _key -> id
            this.series = new Map();      // seriesId -> {meta, cats:Set, episodes:[]}
            this.catOrder = [];           // ordem de aparição das categorias
            this.catCards = new Map();    // cat -> [ids de cards]
            this.catType = new Map();     // cat -> tipo predominante
            this.catDest = new Map();     // cat -> destino (videos|iptv|radio|games)
            this.catConsole = new Map();  // cat -> console (jogos)
            this.stats = { recebidos: 0, duplicados: 0, descartados: 0 };
        }

        _addCard(cat, id, type, dest, consoleId) {
            if (consoleId && !this.catConsole.has(cat)) this.catConsole.set(cat, consoleId);
            if (!this.catCards.has(cat)) {
                this.catCards.set(cat, []);
                this.catOrder.push(cat);
                this.catType.set(cat, type);
                this.catDest.set(cat, dest || 'videos');
            }
            this.catCards.get(cat).push(id);
        }

        add(item) {
            this.stats.recebidos++;
            const existingId = this.keyToId.get(item._key);
            if (existingId) {
                // Duplicado: vira espelho (mirror) do original + herda campos faltantes
                const orig = this.items.get(existingId);
                this.stats.duplicados++;
                if (item.url && item.url !== orig.url) {
                    orig.mirrors = orig.mirrors || [];
                    if (!orig.mirrors.includes(item.url) && orig.mirrors.length < 8) orig.mirrors.push(item.url);
                }
                for (const k of ['thumb', 'bannerThumb', 'desc', 'year', 'genre', 'tvgId']) {
                    if (orig[k] == null && item[k] != null) orig[k] = item[k];
                }
                if (item.cat !== orig.cat && orig.categoryType !== 'episode') {
                    orig.cats = orig.cats || [orig.cat];
                    if (!orig.cats.includes(item.cat)) {
                        orig.cats.push(item.cat);
                        this._addCard(item.cat, orig.id, orig.categoryType, item._dest);
                    }
                }
                return false;
            }
            if (this.items.size >= this.maxItems) { this.stats.descartados++; return false; }

            // Colisão de hash (raríssima): desambigua
            if (this.items.has(item.id)) item.id = item.id + '_' + this.items.size.toString(36);

            const meta = item._seriesMeta;
            const dest = item._dest;
            delete item._seriesMeta;
            delete item._dest;
            this.keyToId.set(item._key, item.id);
            delete item._key;
            this.items.set(item.id, item);

            if (item.categoryType === 'episode') {
                let s = this.series.get(item.seriesId);
                if (!s) {
                    s = { meta: clean(Object.assign({}, meta)), cats: new Set(), episodes: [] };
                    this.series.set(item.seriesId, s);
                }
                s.episodes.push(item.id);
                if (!s.cats.has(item.cat)) {
                    s.cats.add(item.cat);
                    this._addCard(item.cat, item.seriesId, 'series', dest);
                }
            } else {
                this._addCard(item.cat, item.id, item.categoryType, dest, item.console);
            }
            return true;
        }

        addRaw(raw, src) {
            let n = 0;
            for (const it of normalize(raw, src)) if (this.add(it)) n++;
            return n;
        }

        /** Card de série (um por série, não um por episódio). */
        seriesCard(seriesId, cat) {
            const s = this.series.get(seriesId);
            if (!s) return null;
            const seasons = new Set();
            for (const id of s.episodes) seasons.add(this.items.get(id).season);
            return clean({
                ...(s.meta.extra || {}),
                id: seriesId, seriesId,
                destaque: s.meta.destaque,
                title: s.meta.serie,
                thumb: s.meta.thumb || PLACEHOLDER,
                bannerThumb: s.meta.bannerThumb || s.meta.thumb || PLACEHOLDER,
                desc: s.meta.desc, year: s.meta.year, genre: s.meta.genre,
                cat: cat || [...s.cats][0],
                categoryType: 'series',
                seasons: seasons.size,
                episodes: s.episodes.length
            });
        }

        /** Detalhe completo da série: temporadas ordenadas com episódios. */
        seriesDetail(seriesId) {
            const s = this.series.get(seriesId);
            if (!s) return null;
            const bySeason = new Map();
            for (const id of s.episodes) {
                const ep = this.items.get(id);
                if (!bySeason.has(ep.season)) bySeason.set(ep.season, []);
                bySeason.get(ep.season).push(toFull(ep));
            }
            const seasons = [...bySeason.keys()].sort((a, b) => a - b).map(n => ({
                season: n,
                episodes: bySeason.get(n).sort((a, b) => a.episode - b.episode)
            }));
            return Object.assign(this.seriesCard(seriesId), { seasons });
        }

        /**
         * Episódios no FORMATO DO MOTOR ANTIGO (um item por episódio, com "serie"),
         * para apps que montam a lista de episódios filtrando window.DB.videos.
         */
        compatEpisodes(seriesId, cat) {
            const s = this.series.get(seriesId);
            if (!s) return [];
            const m = s.meta;
            const genero = Array.isArray(m.genre) ? m.genre.join(', ') : m.genre;
            const eps = s.episodes.map(id => this.items.get(id))
                .sort((a, b) => a.season - b.season || a.episode - b.episode);
            return eps.map(ep => {
                const extra = {};
                for (const k of Object.keys(ep)) if (!CAMPOS_CONHECIDOS.has(k) && k !== 'epTitle' && !k.startsWith('_')) extra[k] = ep[k];
                return clean(Object.assign(extra, {
                    id: ep.id,
                    serie: m.serie,
                    title: `${m.serie} - T${ep.season}E${ep.episode}`,
                    epTitle: ep.epTitle,
                    thumb: m.thumb || PLACEHOLDER,
                    bannerThumb: m.bannerThumb || m.thumb || PLACEHOLDER,
                    url: ep.url,
                    mirrors: ep.mirrors,
                    headers: ep.headers,
                    desc: m.desc || 'Disponível sob demanda.',
                    year: m.year,
                    genre: genero,
                    cat: cat || ep.cat,
                    categoryType: 'vod',
                    provider: 'legacy',
                    seriesId, season: ep.season, episode: ep.episode,
                    destaque: m.destaque
                }));
            });
        }

        /** Card enxuto p/ grades (descrição curta). */
        card(id, cat) {
            if (this.series.has(id)) return this.seriesCard(id, cat);
            const it = this.items.get(id);
            return it ? toCard(it, cat) : null;
        }

        categories() {
            return this.catOrder.map(nome => ({
                nome,
                slug: slug(nome),
                type: this.catType.get(nome),
                destino: this.catDest.get(nome),
                console: this.catConsole.get(nome),
                total: this.catCards.get(nome).length
            }));
        }

        /** Remove itens (ex.: streams mortos) e limpa categorias/séries. */
        remove(ids) {
            const dead = ids instanceof Set ? ids : new Set(ids);
            if (!dead.size) return 0;
            for (const id of dead) this.items.delete(id);
            for (const [sid, s] of this.series) {
                s.episodes = s.episodes.filter(id => !dead.has(id));
                if (!s.episodes.length) { this.series.delete(sid); dead.add(sid); }
            }
            for (const [cat, list] of this.catCards) {
                const f = list.filter(id => !dead.has(id));
                if (f.length) this.catCards.set(cat, f);
                else { this.catCards.delete(cat); this.catOrder = this.catOrder.filter(c => c !== cat); }
            }
            return dead.size;
        }
    }

    function toCard(it, cat) {
        const c = Object.assign({}, it);
        c.thumb = c.thumb || PLACEHOLDER;
        c.bannerThumb = c.bannerThumb || c.thumb;
        if (cat) c.cat = cat;
        if (c.desc && c.desc.length > DESC_CARD_MAX) c.desc = c.desc.slice(0, DESC_CARD_MAX - 1) + '…';
        delete c.cats;
        return c;
    }

    function toFull(it) {
        const c = Object.assign({}, it);
        c.thumb = c.thumb || PLACEHOLDER;
        c.bannerThumb = c.bannerThumb || c.thumb;
        return c;
    }

    /** URLs para o player tentar em ordem (failover automático). */
    function streamCandidates(item) {
        return [item.url].concat(item.mirrors || []).filter(Boolean);
    }


    // ------------------------------------------------------------------
    // Busca: ranqueia linhas [tituloNorm, id, titulo, thumb, cat, tipo]
    // ------------------------------------------------------------------
    function rankSearch(rows, query, limit = 60) {
        const qTokens = normText(query).split(' ').filter(Boolean);
        if (!qTokens.length) return [];
        const qFull = qTokens.join(' ');
        const seen = new Set();
        const hits = [];
        for (const r of rows) {
            if (seen.has(r[1]) || !matchesQuery(r[0], qTokens)) continue;
            seen.add(r[1]);
            // pontuação: título igual > começa com a busca > contém a frase > só palavras;
            // desempate: mais palavras exatas > título mais curto
            const score = r[0] === qFull ? 0 : r[0].startsWith(qFull) ? 1 : r[0].includes(qFull) ? 2 : 3;
            const words = r[0].split(' ');
            const exatas = qTokens.reduce((n, q) => n + (words.includes(q) ? 1 : 0), 0);
            hits.push([score, -exatas, r[0].length, r]);
        }
        hits.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
        return hits.slice(0, limit).map(([, , , r]) => ({
            id: r[1], title: r[2], thumb: r[3], cat: r[4], categoryType: r[5]
        }));
    }

    function makeLimiter(n) {
        let active = 0; const q = [];
        const next = () => {
            if (active >= n || !q.length) return;
            active++;
            const { fn, res, rej } = q.shift();
            Promise.resolve().then(fn).then(res, rej).finally(() => { active--; next(); });
        };
        return fn => new Promise((res, rej) => { q.push({ fn, res, rej }); next(); });
    }

    async function fetchWithRetry(url, { timeoutMs = 20000, tentativas = 2, fetchFn, init = {} } = {}) {
        const f = fetchFn || fetch;
        let last;
        for (let t = 0; t <= tentativas; t++) {
            const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
            const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
            try {
                const r = await f(url, Object.assign({}, init, ac ? { signal: ac.signal } : {}));
                if (!r.ok) {
                    const err = new Error(`HTTP ${r.status} em ${url}`);
                    err.status = r.status;
                    throw err;
                }
                return { res: r, done: () => timer && clearTimeout(timer) };
            } catch (e) {
                if (timer) clearTimeout(timer);
                last = e;
                if (e.status === 404) break;             // não adianta insistir
                if (t < tentativas) await new Promise(ok => setTimeout(ok, 600 * 2 ** t));
            }
        }
        throw last;
    }

    /** Lê a resposta em pedaços (streaming) quando possível. */
    async function readChunks(res, onChunk) {
        if (res.body && typeof res.body.getReader === 'function') {
            const reader = res.body.getReader();
            const dec = new TextDecoder();
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                onChunk(dec.decode(value, { stream: true }));
            }
            onChunk(dec.decode());
        } else {
            onChunk(await res.text());
        }
    }

    // ------------------------------------------------------------------
    // LocalCatalog: catálogo montado AO VIVO a partir das fontes.
    // Usado no modo legado (sem build) e para fontes marcadas "aoVivo".
    // Expõe a mesma interface do catálogo estático (páginas, busca, séries).
    // ------------------------------------------------------------------
    class LocalCatalog {
        constructor(opts = {}) {
            this.pageSize = opts.pageSize || 120;
            this.b = new CatalogBuilder({ maxItems: opts.maxItems });
            this.epg = new Set();
            this.fontes = [];
            this._cats = null;
            this._rows = null;
        }

        async ingest(fontes, opts = {}) {
            const run = makeLimiter(opts.concorrencia || 6);
            const usable = fontes.filter(s => s.ativo !== false && isUsableUrl(s.url));
            const progress = opts.onProgress || (() => {});
            let concluidas = 0;

            // Baixa em paralelo (limitado); cada fonte é parseada assim que chega.
            // A ORDEM das categorias segue o manifesto: fontes que chegam antes
            // esperam a vez numa fila (os dados brutos ficam guardados).
            const tarefas = usable.map(src => run(async () => {
                const { res, done } = await fetchWithRetry(src.url, opts);
                try {
                    if (sourceFormat(src) === 'm3u') {
                        const entries = [];
                        const p = createM3UParser(e => entries.push(e), h => h.epg.forEach(u => this.epg.add(u)));
                        await readChunks(res, c => p.push(c));
                        p.end();
                        return entries;
                    }
                    return extractList(await res.json());
                } finally { done(); }
            }));
            tarefas.forEach(t => t.catch(() => {}));   // erros são tratados abaixo, na ordem

            for (let i = 0; i < usable.length; i++) {
                const src = usable[i];
                try {
                    const lista = await tarefas[i];
                    let n = 0;
                    for (const raw of lista) n += this.b.addRaw(raw, src);
                    this.fontes.push({ nome: src.nome, ok: true, itens: n });
                } catch (e) {
                    this.fontes.push({ nome: src.nome, ok: false, erro: String(e && e.message || e) });
                }
                progress({ fonte: src.nome, concluidas: ++concluidas, total: usable.length, itens: this.b.items.size });
            }
            this._cats = null;
            this._rows = null;
            return this.manifest();
        }

        /** Adiciona itens já prontos (ex.: vindos de outro worker). */
        addRawList(lista, src) {
            let n = 0;
            for (const raw of lista) n += this.b.addRaw(raw, src);
            this._cats = null; this._rows = null;
            return n;
        }

        _categories() {
            if (this._cats) return this._cats;
            const used = new Set();
            this._cats = this.b.categories().map(c => {
                let s = c.slug, i = 2;
                while (used.has(s)) s = `${c.slug}-${i++}`;
                used.add(s);
                const extra = {};
                if (c.type === 'series') {
                    let eps = 0;
                    for (const sid of this.b.catCards.get(c.nome) || []) { const se = this.b.series.get(sid); if (se) eps += se.episodes.length; }
                    extra.compatPages = Math.ceil(eps / 5000);
                    extra.compatTotal = eps;
                }
                return Object.assign(c, { slug: s, pages: Math.ceil(c.total / this.pageSize) }, extra);
            });
            this._bySlug = new Map(this._cats.map(c => [c.slug, c]));
            return this._cats;
        }

        manifest() {
            const categories = this._categories();
            const destaques = [];
            for (const it of this.b.items.values()) {
                if (it.destaque) { destaques.push(this.b.card(it.id)); if (destaques.length >= 40) break; }
            }
            return {
                schema: 2, version: 'local-' + this.b.items.size, generatedAt: new Date().toISOString(),
                pageSize: this.pageSize,
                totals: { itens: this.b.items.size, series: this.b.series.size, categorias: categories.length },
                categories, destaques, epg: [...this.epg], fontes: this.fontes
            };
        }

        page(slugOrName, n = 0) {
            this._categories();
            const cat = this._bySlug.get(slugOrName) || this._cats.find(c => c.nome === slugOrName);
            if (!cat) return [];
            const ids = this.b.catCards.get(cat.nome) || [];
            return ids.slice(n * this.pageSize, (n + 1) * this.pageSize).map(id => this.b.card(id, cat.nome));
        }

        /** Episódios de uma categoria de séries no formato antigo, em lotes. */
        compatPage(slugOrName, n = 0, tamanho = 5000) {
            this._categories();
            const cat = this._bySlug.get(slugOrName) || this._cats.find(c => c.nome === slugOrName);
            if (!cat) return [];
            if (!this._compat) this._compat = new Map();
            if (!this._compat.has(cat.nome)) {
                const all = [];
                for (const sid of this.b.catCards.get(cat.nome) || []) if (this.b.series.has(sid)) all.push(...this.b.compatEpisodes(sid, cat.nome));
                this._compat.set(cat.nome, all);
            }
            return this._compat.get(cat.nome).slice(n * tamanho, (n + 1) * tamanho);
        }

        item(id) {
            if (this.b.series.has(id)) return this.b.seriesCard(id);
            const it = this.b.items.get(id);
            return it ? Object.assign({}, it) : null;
        }

        series(id) { return this.b.seriesDetail(id); }

        search(q, limit) {
            if (!this._rows) {
                this._rows = [];
                for (const it of this.b.items.values()) {
                    if (it.categoryType !== 'episode') this._rows.push([normText(it.title), it.id, it.title, it.thumb || PLACEHOLDER, it.cat, it.categoryType]);
                }
                for (const sid of this.b.series.keys()) {
                    const c = this.b.seriesCard(sid);
                    this._rows.push([normText(c.title), c.id, c.title, c.thumb, c.cat, 'series']);
                }
            }
            return rankSearch(this._rows, q, limit);
        }
    }

    return {
        VERSION: '2.0.0',
        PLACEHOLDER,
        cyrb53, makeId, idShard,
        normText, slug, normUrl, searchTokens, searchShardKey, matchesQuery,
        detectEpisode, createM3UParser, parseM3U,
        sourceFormat, isUsableUrl, extractList, normalize,
        CatalogBuilder, streamCandidates, destinoDe,
        rankSearch, makeLimiter, fetchWithRetry, readChunks, LocalCatalog
    };
});
