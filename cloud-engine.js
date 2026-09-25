/**
 * @fileoverview cloud-engine.js v2 — Orquestrador Mestre do Cartoonzine
 *
 * Motor HÍBRIDO de catálogo para milhões de itens (VOD, séries, IPTV, rádio, jogos):
 *
 *  • MODO ESTÁTICO (o "jeito Netflix"): o catálogo é pré-processado fora do
 *    navegador (tools/build-catalog.mjs) e fatiado em arquivos pequenos.
 *    O app baixa só o que aparece na tela: páginas de cada fileira, detalhe
 *    do item, episódios da série e fatias do índice de busca.
 *  • MODO LEGADO: sem catálogo gerado, as fontes são baixadas e processadas
 *    no navegador — dentro de um Web Worker, para não travar a interface.
 *  • HÍBRIDO: fontes marcadas com "aoVivo": true no sources.json são sempre
 *    carregadas ao vivo e somadas ao catálogo estático.
 *
 * Requer: <script src="catalog-core.js"></script> ANTES deste arquivo.
 *
 * Configuração opcional (antes dos scripts):
 *   <script>window.CLOUD_ENGINE_CONFIG = { modo: 'auto', manifestUrl: './catalog/manifest.json' }</script>
 *
 * API principal (window.CloudEngine):
 *   await CloudEngine.ready
 *   CloudEngine.categorias()                  -> [{nome, slug, type, destino, total, pages}]
 *   await CloudEngine.getPage(cat, n)         -> cards da página n (cat = nome ou slug)
 *   await CloudEngine.search('naruto')        -> resultados ranqueados
 *   await CloudEngine.getItem(id)             -> item completo (url, espelhos, headers...)
 *   await CloudEngine.getSeries(id)           -> série com temporadas e episódios
 *   CloudEngine.streamCandidates(item)        -> [url, ...espelhos] p/ failover no player
 *   CloudEngine.montarGrade(el, cat, render)  -> rolagem infinita pronta
 *
 * Eventos no document: cloud_engine_progress, cloud_engine_ready, cloud_engine_update
 */
(function () {
    'use strict';

    // O núcleo pode chegar depois (ordem trocada, defer/async, type="module",
    // scripts injetados) — o motor espera por ele e, se preciso, carrega sozinho.
    const MEU_SRC = (document.currentScript && document.currentScript.src) ||
        ([...document.scripts].map(s => s.src).find(u => /cloud-engine(\.min)?\.js/.test(u)) || '');
    let Core = window.CatalogCore || null;

    function urlDoCore() {
        const cfg = window.CLOUD_ENGINE_CONFIG || {};
        if (cfg.coreUrl) return new URL(cfg.coreUrl, location.href).href;
        const tag = [...document.scripts].find(s => /catalog-core(\.min)?\.js/.test(s.src));
        if (tag) return tag.src;
        // mesma pasta do cloud-engine.js
        return new URL('catalog-core.js', MEU_SRC || location.href).href;
    }

    function carregarCore() {
        if (window.CatalogCore) return Promise.resolve(window.CatalogCore);
        return new Promise((resolve, reject) => {
            let feito = false;
            const ok = () => {
                if (feito || !window.CatalogCore) return;
                feito = true;
                window.removeEventListener('catalogcore:ready', ok);
                resolve(window.CatalogCore);
            };
            window.addEventListener('catalogcore:ready', ok);
            document.addEventListener('DOMContentLoaded', ok);
            // Dá um instante para um <script> que já está na página terminar;
            // se não chegar, injeta o catalog-core.js da mesma pasta.
            setTimeout(() => {
                if (feito) return;
                if (window.CatalogCore) return ok();
                const url = urlDoCore();
                console.warn('☁️ [Cloud Engine] catalog-core.js não estava carregado — carregando de', url);
                const sc = document.createElement('script');
                sc.src = url;
                sc.onload = () => {
                    ok();
                    if (!feito) reject(new Error(`${url} carregou mas não definiu window.CatalogCore (arquivo errado/antigo?)`));
                };
                sc.onerror = () => reject(new Error(`não foi possível baixar ${url} (confira o caminho)`));
                document.head.appendChild(sc);
            }, 50);
        });
    }

    // Igual ao motor antigo: as listas existem desde o primeiro instante (outros
    // scripts do app, como o player, contam com isso). Nada é apagado: o motor
    // só SOMA os itens da nuvem depois (ver preencherCompat).
    window.DB = window.DB || { videos: [], games: [], destaques: [] };
    window.CZ_IPTV = window.CZ_IPTV || [];
    window.CZ_VIDEOS_RADIO = window.CZ_VIDEOS_RADIO || [];

    const CFG = Object.assign({
        modo: 'auto',                          // 'auto' | 'estatico' | 'legado'
        manifestUrl: './catalog/manifest.json',
        sourcesUrl: './sources.json',
        fontes: null,                          // opcional: array de fontes inline (ignora sourcesUrl)
        coreUrl: null,                         // detectado automaticamente pela tag <script>
        concorrencia: 6,                       // downloads simultâneos
        timeoutMs: 20000,
        tentativas: 2,
        paginasEmMemoria: 200,                 // cache LRU em RAM (páginas/fatias)
        paginasIniciaisPorCategoria: 1,        // páginas por categoria no window.DB ANTES do "pronto"
        modoNetflix: true,                     // window.DB recebe o catálogo AOS POUCOS (carregarMais) e episódios só ao abrir a série
        compatCompleto: false,                 // true = despeja o catálogo inteiro no window.DB (modo antigo, pesado)
        seriesComoEpisodios: false,            // true = todos os episódios de todas as séries no window.DB (modo antigo, pesado)
        renderAoCompletar: true,               // (só com compatCompleto) chama window.render() quando terminar
        paginasPorCarga: 2,                    // páginas (120 cards cada) trazidas a cada carregarMais()
        carregarCompleto: ['iptv', 'radio', 'streams', 'audio', 'filmes', 'series'],  // listas que entram INTEIRAS (TV/rádio/TVzine VOD)
        legadoMaxItens: 500000,
        usarWorker: true,                      // modo legado/aoVivo roda num Web Worker
        checarAtualizacaoMs: 30 * 60 * 1000,   // procura catálogo novo a cada 30 min (0 = nunca)
        renderAutomatico: true                 // chama window.render() quando pronto
    }, window.CLOUD_ENGINE_CONFIG || {});

    // URLs sempre absolutas (Workers e alguns WebViews não resolvem relativas)
    const abs = (u) => new URL(u, location.href).href;
    CFG.manifestUrl = abs(CFG.manifestUrl);
    CFG.sourcesUrl = abs(CFG.sourcesUrl);

    const log = (...m) => console.log('☁️ [Cloud Engine]', ...m);
    const emit = (name, detail) => document.dispatchEvent(new CustomEvent(name, { detail }));
    const fetchOpts = { timeoutMs: CFG.timeoutMs, tentativas: CFG.tentativas };
    const baseUrl = CFG.manifestUrl.replace(/[^/]*$/, '');

    // ==================================================================
    // Cache em 2 níveis: RAM (LRU) + IndexedDB (sobrevive a recarregar)
    // ==================================================================
    class LRU {
        constructor(max) { this.max = max; this.m = new Map(); }
        get(k) {
            if (!this.m.has(k)) return undefined;
            const v = this.m.get(k); this.m.delete(k); this.m.set(k, v); return v;
        }
        set(k, v) {
            this.m.delete(k); this.m.set(k, v);
            if (this.m.size > this.max) this.m.delete(this.m.keys().next().value);
        }
        clear() { this.m.clear(); }
    }

    const KV = (() => {
        let dbp = null;
        const open = () => dbp || (dbp = new Promise((res) => {
            try {
                const rq = indexedDB.open('cloud-engine-v2', 1);
                rq.onupgradeneeded = () => rq.result.createObjectStore('kv');
                rq.onsuccess = () => res(rq.result);
                rq.onerror = () => res(null);
                rq.onblocked = () => res(null);
            } catch { res(null); }
        }));
        const tx = async (mode, fn) => {
            const db = await open();
            if (!db) return undefined;
            return new Promise((res) => {
                try {
                    const t = db.transaction('kv', mode);
                    const r = fn(t.objectStore('kv'));
                    t.oncomplete = () => res(r && r.result);
                    t.onerror = t.onabort = () => res(undefined);
                } catch { res(undefined); }
            });
        };
        return {
            get: k => tx('readonly', s => s.get(k)),
            set: (k, v) => tx('readwrite', s => s.put(v, k)),
            /** Remove entradas de versões antigas do catálogo. */
            async purgeExcept(prefix) {
                const db = await open();
                if (!db) return;
                try {
                    const t = db.transaction('kv', 'readwrite');
                    const st = t.objectStore('kv');
                    const rq = st.openCursor();
                    rq.onsuccess = () => {
                        const c = rq.result;
                        if (!c) return;
                        const k = String(c.key);
                        if (k.startsWith('v:') && !k.startsWith(prefix)) c.delete();
                        c.continue();
                    };
                } catch { /* ignore */ }
            }
        };
    })();

    // ==================================================================
    // Provedor ESTÁTICO: lê o catálogo fatiado gerado pelo build
    // ==================================================================
    class StaticProvider {
        constructor() {
            this.mem = new LRU(CFG.paginasEmMemoria);
            this.inflight = new Map();
            this.run = Core.makeLimiter(CFG.concorrencia);
            this.manifest = null;
            this.mkey = 'manifest:' + CFG.manifestUrl;
        }

        async init() {
            let m = null;
            try {
                const { res, done } = await Core.fetchWithRetry(CFG.manifestUrl, Object.assign({ init: { cache: 'no-cache' } }, fetchOpts, { tentativas: 1 }));
                try { m = await res.json(); } finally { done(); }
                if (!m || m.schema !== 2 || !Array.isArray(m.categories)) throw new Error('manifest inválido');
                KV.set(this.mkey, m);
            } catch (e) {
                // Só usa o cache se foi falta de REDE/servidor (sem status ou 5xx).
                // 404 = o catálogo não existe mais -> não finge que existe.
                const semRede = !e.status || e.status >= 500;
                m = semRede ? await KV.get(this.mkey) : null;
                if (!m) throw e;
                log('📴 Sem rede — usando catálogo em cache', m.version);
            }
            this._setManifest(m);
            setTimeout(() => KV.purgeExcept(`v:${m.version}:`), 5000);
            return m;
        }

        _setManifest(m) {
            this.manifest = m;
            this.mem.clear();
            this.bySlug = new Map(m.categories.map(c => [c.slug, c]));
            this.byName = new Map(m.categories.map(c => [c.nome, c]));
            this.shardSet = new Set(m.searchShards || []);
        }

        async checkUpdate() {
            try {
                const { res, done } = await Core.fetchWithRetry(CFG.manifestUrl, Object.assign({ init: { cache: 'no-cache' } }, fetchOpts, { tentativas: 0 }));
                let m; try { m = await res.json(); } finally { done(); }
                if (m && m.schema === 2 && m.version !== this.manifest.version) {
                    KV.set(this.mkey, m);
                    this._setManifest(m);
                    KV.purgeExcept(`v:${m.version}:`);
                    return m;
                }
            } catch { /* tenta de novo depois */ }
            return null;
        }

        /** Busca um arquivo do catálogo: RAM -> IndexedDB -> rede (com deduplicação). */
        async file(rel, { opcional = false } = {}) {
            const key = `v:${this.manifest.version}:${rel}`;
            const hit = this.mem.get(key);
            if (hit !== undefined) return hit;
            if (this.inflight.has(key)) return this.inflight.get(key);

            const p = (async () => {
                let v = await KV.get(key);
                if (v === undefined) {
                    try {
                        v = await this.run(async () => {
                            const { res, done } = await Core.fetchWithRetry(`${baseUrl}${rel}?v=${this.manifest.version}`, fetchOpts);
                            try { return await res.json(); } finally { done(); }
                        });
                    } catch (e) {
                        if (opcional && e.status === 404) v = null;
                        else throw e;
                    }
                    KV.set(key, v);
                }
                this.mem.set(key, v);
                return v;
            })().finally(() => this.inflight.delete(key));
            this.inflight.set(key, p);
            return p;
        }

        cat(c) { return this.bySlug.get(c) || this.byName.get(c); }

        async page(c, n) {
            const cat = this.cat(c);
            if (!cat || n < 0 || n >= cat.pages) return [];
            const cards = await this.file(`cat/${cat.slug}/${n}.json`);
            // Pré-carrega a próxima página em segundo plano (rolagem sem espera)
            if (n + 1 < cat.pages) idle(() => this.file(`cat/${cat.slug}/${n + 1}.json`).catch(() => {}));
            return cards;
        }

        async compatPage(c, n) {
            const cat = this.cat(c);
            if (!cat || !cat.compatPages || n >= cat.compatPages) return [];
            return (await this.file(`compat/${cat.slug}/${n}.json`, { opcional: true })) || [];
        }

        async item(id) {
            const shard = await this.file(`items/${Core.idShard(id)}.json`, { opcional: true });
            return (shard && shard[id]) || null;
        }

        async series(id) {
            return this.file(`series/${encodeURIComponent(id)}.json`, { opcional: true });
        }

        /** Acha a fatia de busca mais específica que existe para a palavra. */
        _shardFor(tk) {
            for (let d = Math.min(tk.length, 6); d >= 2; d--) {
                const k = tk.slice(0, d);
                if (this.shardSet.has(k)) return k;
                if (d === tk.length && this.shardSet.has(k + '_')) return k + '_';
            }
            return null;
        }

        async search(q, limit) {
            const tokens = [...new Set(Core.normText(q).split(' ').filter(t => t.length >= 2))];
            if (!tokens.length) return [];
            // Baixa as fatias das (até 3) palavras mais longas e filtra pela MENOR:
            // a palavra mais rara é a que mais restringe o resultado.
            const keys = [...new Set(tokens.sort((a, b) => b.length - a.length).slice(0, 3)
                .map(tk => this._shardFor(tk)).filter(Boolean))];
            if (!keys.length) return [];
            const sets = await Promise.all(keys.map(k => this.file(`search/${k}.json`, { opcional: true }).catch(() => null)));
            const valid = sets.filter(Boolean);
            if (!valid.length) return [];
            const rows = valid.reduce((a, b) => (b.length < a.length ? b : a));
            return Core.rankSearch(rows, q, limit);
        }
    }

    // ==================================================================
    // Provedor LOCAL: monta o catálogo no navegador (em Worker se possível)
    // ==================================================================
    function coreScriptUrl() {
        return urlDoCore();
    }

    const WORKER_SRC = `
        importScripts(self.CORE_URL);
        let cat = null;
        self.onmessage = async (e) => {
            const { id, op, args } = e.data;
            try {
                let result;
                if (op === 'ingest') {
                    cat = new CatalogCore.LocalCatalog({ maxItems: args.maxItems });
                    result = await cat.ingest(args.fontes, Object.assign({}, args.opts, {
                        onProgress: p => self.postMessage({ progress: p })
                    }));
                } else if (op === 'page') result = cat.page(args[0], args[1]);
                else if (op === 'compatPage') result = cat.compatPage(args[0], args[1]);
                else if (op === 'item') result = cat.item(args[0]);
                else if (op === 'series') result = cat.series(args[0]);
                else if (op === 'search') result = cat.search(args[0], args[1]);
                self.postMessage({ id, ok: true, result });
            } catch (err) {
                self.postMessage({ id, ok: false, error: String(err && err.message || err) });
            }
        };`;

    class LocalProvider {
        constructor(fontes) { this.fontes = fontes; this.manifest = null; }

        async init() {
            const opts = { concorrencia: CFG.concorrencia, timeoutMs: CFG.timeoutMs, tentativas: CFG.tentativas };
            // Workers não enxergam URLs relativas: resolve tudo para absoluto
            const fontes = this.fontes.map(f => Object.assign({}, f, f.url ? { url: abs(f.url) } : {}));

            if (CFG.usarWorker && typeof Worker !== 'undefined') {
                try {
                    this._startWorker();
                    this.manifest = await this._call('ingest', { fontes, opts, maxItems: CFG.legadoMaxItens });
                    return this.manifest;
                } catch (e) {
                    log('⚠️ Worker indisponível, processando na thread principal:', e.message);
                    if (this.w) this.w.terminate();
                    this.w = null;
                }
            }
            this.local = new Core.LocalCatalog({ maxItems: CFG.legadoMaxItens });
            this.manifest = await this.local.ingest(fontes, Object.assign({}, opts, {
                onProgress: p => emit('cloud_engine_progress', p)
            }));
            return this.manifest;
        }

        _startWorker() {
            const src = `self.CORE_URL = ${JSON.stringify(coreScriptUrl())};\n` + WORKER_SRC;
            this.w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
            this.seq = 0;
            this.pending = new Map();
            this.w.onmessage = (e) => {
                const d = e.data;
                if (d.progress) return emit('cloud_engine_progress', d.progress);
                const p = this.pending.get(d.id);
                if (!p) return;
                this.pending.delete(d.id);
                d.ok ? p.res(d.result) : p.rej(new Error(d.error));
            };
            // Erro no worker (ex.: catalog-core.js não encontrado) NUNCA deixa promessas penduradas
            this.w.onerror = (e) => {
                e.preventDefault && e.preventDefault();
                const err = new Error(e.message || 'falha no worker');
                for (const p of this.pending.values()) p.rej(err);
                this.pending.clear();
            };
        }

        _call(op, args) {
            if (!this.w) return Promise.resolve(this.local[op](...args));
            return new Promise((res, rej) => {
                const id = ++this.seq;
                this.pending.set(id, { res, rej });
                this.w.postMessage({ id, op, args });
            });
        }

        destruir() { if (this.w) this.w.terminate(); this.w = null; }
        page(c, n) { return this._call('page', [c, n]); }
        compatPage(c, n) { return this._call('compatPage', [c, n]); }
        item(id) { return this._call('item', [id]); }
        series(id) { return this._call('series', [id]); }
        search(q, limit) { return this._call('search', [q, limit]); }
    }

    // ==================================================================
    // Roteador: junta estático + local e decide quem responde cada pedido
    // ==================================================================
    const idle = (fn) => (window.requestIdleCallback || ((f) => setTimeout(f, 200)))(fn);

    const Engine = {
        modo: null,
        manifest: null,
        _static: null,
        _local: null,
        _catOwner: new Map(),   // slug/nome -> provedor

        async _carregarFontes() {
            if (Array.isArray(CFG.fontes)) return CFG.fontes;
            if (Array.isArray(window.CZ_FONTES)) return window.CZ_FONTES;
            try {
                const { res, done } = await Core.fetchWithRetry(CFG.sourcesUrl, fetchOpts);
                try {
                    const j = await res.json();
                    return Array.isArray(j) ? j : (j.fontes || j.sources || []);
                } finally { done(); }
            } catch (e) {
                log('⚠️ Não consegui ler', CFG.sourcesUrl, e.message);
                return [];
            }
        },

        _juntarManifestos() {
            const cats = [];
            const add = (m, prov, origem) => {
                if (!m) return;
                for (const c of m.categories) {
                    let slug = c.slug;
                    if (this._catOwner.has(slug)) slug = `${slug}-${origem}`;   // evita colisão
                    const cc = Object.assign({}, c, { slug, provedor: origem, _slugInterno: c.slug });
                    this._catOwner.set(slug, prov);
                    cats.push(cc);
                }
            };
            this._catOwner.clear();
            add(this._static && this._static.manifest, this._static, 'estatico');
            add(this._local && this._local.manifest, this._local, 'local');
            const sm = (this._static && this._static.manifest) || {};
            const lm = (this._local && this._local.manifest) || {};
            this.manifest = {
                version: [sm.version, lm.version].filter(Boolean).join('+'),
                generatedAt: sm.generatedAt || lm.generatedAt,
                pageSize: sm.pageSize || lm.pageSize,
                categories: cats,
                destaques: [...(sm.destaques || []), ...(lm.destaques || [])],
                epg: [...new Set([...(sm.epg || []), ...(lm.epg || [])])],
                totals: {
                    itens: ((sm.totals || {}).itens || 0) + ((lm.totals || {}).itens || 0),
                    series: ((sm.totals || {}).series || 0) + ((lm.totals || {}).series || 0),
                    categorias: cats.length
                },
                fontes: [...(sm.fontes || []), ...(lm.fontes || [])]
            };
        },

        _resolver(c) {
            const cat = typeof c === 'object' ? c : this.manifest.categories.find(x => x.slug === c || x.nome === c);
            if (!cat) return null;
            return { cat, prov: this._catOwner.get(cat.slug) };
        },

        // ---------------------------------------------------- API pública
        categorias(filtro) {
            const cats = this.manifest ? this.manifest.categories : [];
            if (!filtro) return cats;
            return cats.filter(c => (!filtro.destino || c.destino === filtro.destino) && (!filtro.type || c.type === filtro.type));
        },

        async getPage(c, n = 0) {
            const r = this._resolver(c);
            if (!r) return [];
            return (await r.prov.page(r.cat._slugInterno, n)) || [];
        },

        /** Lote n de episódios no formato do motor antigo (categorias de séries). */
        async getCompatPage(c, n = 0) {
            const r = this._resolver(c);
            if (!r || !r.prov.compatPage) return [];
            return (await r.prov.compatPage(r.cat._slugInterno, n)) || [];
        },

        /** Percorre todas as páginas de uma categoria: for await (const lote of CloudEngine.percorrer('Filmes')) */
        async *percorrer(c) {
            const r = this._resolver(c);
            if (!r) return;
            for (let n = 0; n < r.cat.pages; n++) yield await this.getPage(r.cat, n);
        },

        async getItem(id) {
            for (const p of [this._local, this._static]) {
                if (!p) continue;
                const it = await p.item(id).catch(() => null);
                if (it) return it;
            }
            return null;
        },

        async getSeries(id) {
            for (const p of [this._local, this._static]) {
                if (!p) continue;
                const s = await p.series(id).catch(() => null);
                if (s) return s;
            }
            return null;
        },

        async search(q, { limite = 60 } = {}) {
            const partes = await Promise.all([this._static, this._local].filter(Boolean)
                .map(p => p.search(q, limite).catch(() => [])));
            const vistos = new Set();
            return partes.flat().filter(r => !vistos.has(r.id) && vistos.add(r.id)).slice(0, limite);
        },

        streamCandidates: (item) => Core.streamCandidates(item),

        /**
         * Rolagem infinita pronta: vai anexando páginas conforme o usuário rola.
         * render(card) deve devolver um Element (ou string HTML).
         * opts.root = elemento que rola (para fileiras horizontais); opts.maxPaginas p/ limitar.
         */
        montarGrade(container, c, render, opts = {}) {
            const r = this._resolver(c);
            if (!r) return { destruir() {} };
            let n = 0, carregando = false, fim = r.cat.pages === 0;
            const maxPag = opts.maxPaginas || Infinity;
            const sentinela = document.createElement('div');
            sentinela.style.cssText = 'width:1px;height:1px;flex:0 0 1px';
            container.appendChild(sentinela);

            const carregar = async () => {
                if (carregando || fim) return;
                carregando = true;
                try {
                    const cards = await this.getPage(r.cat, n++);
                    const frag = document.createDocumentFragment();
                    for (const card of cards) {
                        const el = render(card);
                        if (!el) continue;
                        if (typeof el === 'string') {
                            const t = document.createElement('template');
                            t.innerHTML = el.trim();
                            frag.append(...t.content.childNodes);
                        } else frag.appendChild(el);
                    }
                    container.insertBefore(frag, sentinela);
                    if (n >= r.cat.pages || n >= maxPag) { fim = true; obs.disconnect(); sentinela.remove(); }
                } catch (e) {
                    n--;   // deixa tentar de novo na próxima rolagem
                    log('⚠️ Falha ao carregar página', e.message);
                } finally {
                    carregando = false;
                }
                // Se a tela ainda não encheu, continua carregando
                if (!fim && isVisible(sentinela, opts.root)) carregar();
            };

            const obs = new IntersectionObserver((ents) => {
                if (ents.some(e => e.isIntersecting)) carregar();
            }, { root: opts.root || null, rootMargin: opts.margem || '800px' });
            obs.observe(sentinela);

            return { destruir() { obs.disconnect(); sentinela.remove(); fim = true; } };
        },

        /** Monta as fileiras da home só quando chegam perto da tela (lazy rows). */
        montarHome(container, renderFileira, opts = {}) {
            const cats = opts.categorias || this.categorias(opts.filtro);
            const obs = new IntersectionObserver((ents) => {
                for (const e of ents) {
                    if (!e.isIntersecting) continue;
                    obs.unobserve(e.target);
                    renderFileira(e.target._cat, e.target);
                }
            }, { rootMargin: '600px' });
            for (const c of cats) {
                const el = document.createElement('section');
                el.className = opts.classe || 'cz-fileira';
                el.dataset.cat = c.slug;
                el._cat = c;
                el.style.minHeight = opts.alturaMinima || '220px';
                container.appendChild(el);
                obs.observe(el);
            }
            return { destruir() { obs.disconnect(); } };
        },

        async recarregar() { return iniciar(true); }
    };

    function isVisible(el, root) {
        const r = el.getBoundingClientRect();
        const b = root ? root.getBoundingClientRect() : { top: 0, left: 0, bottom: innerHeight, right: innerWidth };
        return r.top < b.bottom + 800 && r.left < b.right + 800;
    }

    // ==================================================================
    // Compatibilidade: preenche window.DB / CZ_IPTV / rádio / games
    // ==================================================================
    // Regras: NUNCA apaga o que o app já tem (DB legado). Só soma itens da nuvem,
    // marcados com _cz:'cloud', e numa atualização troca apenas esses.
    // Itens que o app já tem (mesmo id ou mesma url) têm prioridade.
    function lista(obj, chave) {
        if (!Array.isArray(obj[chave])) obj[chave] = [];
        return obj[chave];
    }
    function dbDoApp() {
        if (!window.DB || typeof window.DB !== 'object') window.DB = {};
        return window.DB;
    }
    function removerNossos(arr) {
        let w = 0;
        for (let i = 0; i < arr.length; i++) if (!(arr[i] && arr[i]._cz === 'cloud')) arr[w++] = arr[i];
        arr.length = w;
    }
    function domPronto() {
        if (document.readyState !== 'loading') return new Promise(r => setTimeout(r, 0));
        return new Promise(r => document.addEventListener('DOMContentLoaded', () => setTimeout(r, 0), { once: true }));
    }

    let compatGeracao = 0;
    let compatCtx = null;

    /** Mesmos TIPOS de campo do motor antigo (o app faz .trim(), .split() etc.). */
    function formatoAntigo(card) {
        if (!card) return card;
        if (Array.isArray(card.genre)) card.genre = card.genre.join(', ');
        if (typeof card.year === 'number') card.year = String(card.year);
        for (const k of ['title', 'desc', 'thumb', 'bannerThumb', 'cat', 'url']) {
            if (card[k] != null && typeof card[k] !== 'string') card[k] = String(card[k]);
        }
        if (!card.provider) card.provider = 'legacy';
        return card;
    }

    async function preencherCompat() {
        const lim = CFG.paginasIniciaisPorCategoria;
        if (!lim) return;
        const geracao = ++compatGeracao;          // cancela um preenchimento anterior em andamento
        // Espera o app terminar de montar o DB legado dele (evita ser sobrescrito)
        await domPronto();

        // Resolve os alvos só AGORA (o app pode ter recriado window.DB)
        const db = dbDoApp();
        const global = (nome) => Array.isArray(window[nome]) ? window[nome] : (window[nome] = []);
        const alvo = {
            videos: lista(db, 'videos'),
            games: lista(db, 'games'),
            filmes: lista(db, 'filmes'),                  // TVzine → aba Filmes (DB.filmes)
            series: lista(db, 'series'),                  // TVzine → aba Séries (DB.series)
            iptv: global('CZ_IPTV'),
            radio: global('CZ_VIDEOS_RADIO'),             // Radio Hub → Tuner
            streams: global('CZ_M3U_STREAMS'),            // Radio Hub → Listas Stream
            audio: global('CZ_AUDIO_FILES')               // Radio Hub → Mídia & Áudio
        };
        // Home: categorias da nuvem viram fileiras (o app lista as fileiras por DB.categories)
        if (Array.isArray(db.categories)) {
            for (const c of Engine.manifest.categories) {
                if ((c.destino || 'videos') === 'videos' && !db.categories.includes(c.nome)) db.categories.push(c.nome);
            }
        }
        const destaques = lista(db, 'destaques');
        for (const arr of [...Object.values(alvo), destaques]) removerNossos(arr);

        // O que o app já tem, por id e por url (o DB legado tem prioridade)
        const jaTem = new Map();
        for (const [k, arr] of Object.entries(alvo)) {
            const set = new Set();
            for (const it of arr) { if (!it) continue; if (it.id) set.add('i:' + it.id); if (it.url) set.add('u:' + it.url); if (it.streamUrl) set.add('u:' + it.streamUrl); }
            jaTem.set(k, set);
        }

        const marcar = (card) => {
            formatoAntigo(card);
            card._cz = 'cloud';
            if (!card.provider) card.provider = 'legacy';     // mesmo provider do motor antigo (PlaybackService)
            if (card.categoryType === 'series' && !card.serie) card.serie = card.title;
            return card;
        };

        const somar = (cat, cards) => {
            const k = alvo[cat.destino] ? cat.destino : 'videos';
            const destino = alvo[k];
            const set = jaTem.get(k);
            let n = 0;
            for (const card of cards || []) {
                if (set.has('i:' + card.id) || (card.url && set.has('u:' + card.url))) continue;
                set.add('i:' + card.id);
                if (k !== 'videos' && k !== 'games') {            // apelidos que listas IPTV/rádio costumam usar
                    card.name = card.name || card.title;
                    card.logo = card.logo || card.thumb;
                    card.group = card.group || card.cat;
                    if (card.tvgId && !card.tvg_id) card.tvg_id = card.tvgId;
                    // Rádio: a tela filtra por país em "country" (vem do JSON, de "pais" ou do group-title do M3U)
                    if ((k === 'radio' || k === 'streams') && !card.country) card.country = card.pais || card.cat;
                }
                destino.push(marcar(card));
                n++;
            }
            return n;
        };

        // 1) Primeiras páginas de cada categoria ANTES do "pronto" (abertura rápida)
        const cats = Engine.manifest.categories;
        // Séries no formato antigo: cada EPISÓDIO vira um item (com "serie"),
        // exatamente como o motor antigo — é assim que o app monta a lista de episódios.
        const usaCompat = c => CFG.seriesComoEpisodios && c.type === 'series' &&
            (c.destino || 'videos') === 'videos' && c.compatPages > 0;
        const buscar = t => (t.compat ? Engine.getCompatPage(t.c, t.n) : Engine.getPage(t.c, t.n)).catch(() => []);

        // 1) Primeiro lote de cada categoria ANTES do "pronto" (abertura rápida)
        const primeiras = [];
        for (const c of cats) {
            if (usaCompat(c)) primeiras.push({ c, n: 0, compat: true });
            else for (let n = 0; n < Math.min(c.pages, lim); n++) primeiras.push({ c, n });
        }
        const res = await Promise.all(primeiras.map(buscar));
        res.forEach((cards, i) => somar(primeiras[i].c, cards));

        const idsDest = new Set(destaques.map(d => d && d.id));
        for (const d of (Engine.manifest.destaques || [])) if (!idsDest.has(d.id)) destaques.push(marcar(Object.assign({}, d)));

        // Contexto para carregar mais sob demanda (modo Netflix)
        const cursor = new Map();
        for (const c of cats) cursor.set(c, usaCompat(c) ? { compat: true, n: 1, max: c.compatPages } : { compat: false, n: Math.min(c.pages, lim), max: c.pages });
        compatCtx = { geracao, somar, marcar, cursor, buscar };
        completarDestinos(geracao);

        // 2) O RESTO do catálogo em segundo plano (como o motor antigo: tudo no window.DB)
        if (CFG.compatCompleto) {
            const resto = [];
            for (const c of cats) {
                if (usaCompat(c)) for (let n = 1; n < c.compatPages; n++) resto.push({ c, n, compat: true });
                else for (let n = Math.min(c.pages, lim); n < c.pages; n++) resto.push({ c, n });
            }
            if (resto.length) completarCompat(resto, somar, geracao, buscar);
        }
    }

    /**
     * TV, rádio e as abas VOD do TVzine trabalham com a lista INTEIRA (filtram por país,
     * grupo, busca). Essas entram completas em segundo plano, como no motor antigo.
     */
    async function completarDestinos(geracao) {
        const destinos = CFG.carregarCompleto || [];
        if (!destinos.length) return;
        const cats = Engine.manifest.categories.filter(c => destinos.includes(c.destino));
        const feitos = new Set();
        for (const c of cats) {
            if (geracao !== compatGeracao) return;
            try { await Engine.carregarCategoriaInteira(c.nome); } catch (e) { /* segue */ }
        }
        for (const c of cats) feitos.add(c.destino);
        for (const d of feitos) {
            log(`📡 Lista "${d}" completa`);
            emit('cloud_engine_destino_completo', { destino: d });
        }
    }

    async function completarCompat(resto, somar, geracao, buscar) {
        const t0 = performance.now();
        const LOTE = 12;
        for (let i = 0; i < resto.length; i += LOTE) {
            const lote = resto.slice(i, i + LOTE);
            const res = await Promise.all(lote.map(buscar));
            if (geracao !== compatGeracao) return;            // catálogo atualizado no meio: para
            res.forEach((cards, j) => somar(lote[j].c, cards));
            await new Promise(r => setTimeout(r, 0));         // deixa a interface respirar
        }
        const db = window.DB || {};
        log(`📚 Catálogo completo no window.DB em ${Math.round(performance.now() - t0)}ms — VOD ${(db.videos || []).length} · TV ${(window.CZ_IPTV || []).length}`);
        emit('cloud_engine_compat_completo', { videos: (db.videos || []).length });
        if (CFG.renderAoCompletar && typeof window.render === 'function') {
            try { window.render(); } catch (e) { console.warn('⚠️ [Cloud Engine] render():', e); }
        }
    }

    // ==================================================================
    // Modo Netflix: o app pede MAIS conteúdo conforme o usuário navega
    // ==================================================================
    function catsPorNome(nome) {
        if (!compatCtx) return [];
        return [...compatCtx.cursor.keys()].filter(c => c.nome === nome || c.slug === nome);
    }

    /** Ainda há páginas da categoria que não entraram no window.DB? */
    Engine.temMais = function (nome) {
        return catsPorNome(nome).some(c => { const k = compatCtx.cursor.get(c); return k.n < k.max; });
    };

    /** Total de títulos da categoria no catálogo (não só os já carregados). */
    Engine.totalCategoria = function (nome) {
        return (Engine.manifest ? Engine.manifest.categories : [])
            .filter(c => c.nome === nome || c.slug === nome).reduce((t, c) => t + (c.total || 0), 0);
    };

    /** Nomes das categorias da nuvem que pertencem a um console de jogos ("snes", "megadrive"...). */
    Engine.categoriasDoConsole = function (consoleId) {
        const cats = Engine.manifest ? Engine.manifest.categories : [];
        const nomes = new Set(cats.filter(c => c.destino === 'games' && c.console === consoleId).map(c => c.nome));
        // catálogos gerados antes do campo "console": descobre pelos jogos já carregados
        for (const g of ((window.DB && window.DB.games) || [])) if (g && g._cz && g.console === consoleId && g.cat) nomes.add(g.cat);
        return [...nomes];
    };

    const carregando = new Map();
    /**
     * Traz as próximas páginas da categoria para o window.DB.videos (formato antigo).
     * Devolve quantos itens novos entraram. Chamadas simultâneas são unificadas.
     */
    Engine.carregarMais = function (nome, paginas) {
        const qtd = paginas || CFG.paginasPorCarga || 2;
        if (carregando.has(nome)) return carregando.get(nome);
        const p = (async () => {
            if (!compatCtx) await Engine.ready;
            const ctx = compatCtx;
            if (!ctx) return 0;
            const tarefas = [];
            for (const c of catsPorNome(nome)) {
                const k = ctx.cursor.get(c);
                for (let i = 0; i < qtd && k.n < k.max; i++, k.n++) tarefas.push({ c, n: k.n, compat: k.compat });
            }
            if (!tarefas.length) return 0;
            const res = await Promise.all(tarefas.map(ctx.buscar));
            if (ctx !== compatCtx) return 0;                  // catálogo trocou no meio
            let novos = 0;
            res.forEach((cards, i) => { novos += ctx.somar(tarefas[i].c, cards) || 0; });
            emit('cloud_engine_mais', { categoria: nome, novos, temMais: Engine.temMais(nome) });
            return novos;
        })().finally(() => carregando.delete(nome));
        carregando.set(nome, p);
        return p;
    };

    /** Traz a categoria INTEIRA (usado quando o usuário aplica um filtro). */
    Engine.carregarCategoriaInteira = async function (nome, onProgress) {
        let total = 0;
        while (Engine.temMais(nome)) {
            total += await Engine.carregarMais(nome, 12);
            if (onProgress) try { onProgress(total); } catch (e) { /* ignore */ }
            await new Promise(r => setTimeout(r, 0));
        }
        return total;
    };

    /**
     * Abre uma série: busca SÓ os episódios dela e coloca no window.DB.videos
     * no formato antigo (um item por episódio, com "serie"), NO LUGAR do card.
     * Aceita o card, o id do card ou o seriesId. Devolve a lista de episódios.
     */
    Engine.carregarEpisodios = async function (cardOuId) {
        const db = dbDoApp();
        const lista = lista_(db);
        const card = typeof cardOuId === 'object' ? cardOuId : lista.find(v => v && (v.id === cardOuId || v.seriesId === cardOuId));
        const sid = (card && (card.seriesId || card.id)) || cardOuId;
        const jaTem = lista.filter(v => v && v._czEp && v.seriesId === sid);
        if (jaTem.length) return jaTem;
        const s = await Engine.getSeries(sid);
        if (!s || !s.seasons) return [];
        const eps = [];
        for (const t of s.seasons) for (const ep of t.episodes) {
            const extra = {};
            for (const k of Object.keys(ep)) if (!(k in extra) && !['genre', 'year', 'cats'].includes(k)) extra[k] = ep[k];
            const it = Object.assign(extra, {
                id: ep.id,
                serie: s.title,
                title: `${s.title} - T${ep.season}E${ep.episode}`,
                thumb: s.thumb || ep.thumb,
                bannerThumb: s.bannerThumb || s.thumb,
                url: ep.url,
                desc: s.desc || ep.desc || 'Disponível sob demanda.',
                year: s.year, genre: s.genre,
                cat: (card && card.cat) || ep.cat,
                categoryType: 'vod', provider: 'legacy',
                seriesId: sid, season: ep.season, episode: ep.episode,
                _czEp: true
            });
            if (compatCtx) compatCtx.marcar(it); else { formatoAntigo(it); it._cz = 'cloud'; }
            eps.push(it);
        }
        // Coloca os episódios exatamente onde o card estava (a grade não muda de ordem)
        const idx = card ? lista.indexOf(card) : -1;
        if (idx >= 0) lista.splice(idx, 1, ...eps);
        else lista.push(...eps);
        emit('cloud_engine_episodios', { seriesId: sid, serie: s.title, episodios: eps.length });
        return eps;
    };
    function lista_(db) { return lista(db, 'videos'); }

    /**
     * Intercepta setView('player', id): se o id for um card de série da nuvem, ou um
     * episódio que ainda não está no window.DB (ex.: "continuar assistindo"), carrega
     * os episódios daquela série ANTES de abrir o player. Vale para qualquer tela do app.
     */
    function instalarInterceptadorPlayer() {
        if (typeof window.setView !== 'function' || window.setView.__czWrapped) return !!(window.setView && window.setView.__czWrapped);
        const original = window.setView;
        const wrapped = function (view, param) {
            const args = arguments, self = this;
            if (view !== 'player' || param == null || !Engine.manifest) return original.apply(self, args);
            const lista = (window.DB && window.DB.videos) || [];
            const v = lista.find(x => x && x.id === param);
            const abrir = (novoId) => { const a = Array.from(args); a[1] = novoId; return original.apply(self, a); };
            if (v && !(v._cz === 'cloud' && v.categoryType === 'series')) return original.apply(self, args);
            (async () => {
                try {
                    if (v) {                                          // card de série da nuvem
                        const eps = await Engine.carregarEpisodios(v);
                        if (!eps.length) return abrir(param);
                        const salvo = localStorage.getItem('last_watched_' + (v.serie || v.title));
                        const alvo = eps.find(e => e.id === salvo) || eps[0];
                        return abrir(alvo.id);
                    }
                    // id que não está no DB: pode ser episódio salvo em "continuar assistindo"
                    const it = await Engine.getItem(param);
                    if (it && it.seriesId) await Engine.carregarEpisodios(it.seriesId);
                    else if (it && it.url && !lista.some(x => x && x.id === it.id)) lista.push(compatCtx ? compatCtx.marcar(Object.assign({}, it)) : formatoAntigo(Object.assign({}, it)));
                } catch (e) {
                    console.warn('⚠️ [Cloud Engine] não consegui preparar o player:', e);
                }
                return abrir(param);
            })();
        };
        wrapped.__czWrapped = true;
        window.setView = wrapped;
        return true;
    }
    // Instala assim que o app definir setView, e reinstala se o app redefinir depois
    (function vigiar() {
        instalarInterceptadorPlayer();
        setTimeout(vigiar, window.setView && window.setView.__czWrapped ? 1000 : 100);
    })();

    /**
     * Garante um item TOCÁVEL: card de série vira o 1º episódio (ou o pedido),
     * card sem url busca o detalhe completo. Usado pelo legacy-provider.js.
     */
    Engine.resolverParaTocar = async function (item, opts = {}) {
        if (!item) return null;
        // Com link: mantém o item EXATAMENTE como está; só troca a url se o
        // principal não responder e existir reserva.
        if (item.url || item.streamUrl) return escolherLinkQueFunciona(item);

        // Sem link (card de série do modo novo): pega o episódio no formato antigo
        if (item.categoryType === 'series' || item.seriesId) {
            const s = await Engine.getSeries(item.seriesId || item.id);
            if (!s || !s.seasons || !s.seasons.length) return item;
            const temp = s.seasons.find(t => t.season === opts.temporada) || s.seasons[0];
            const ep = temp.episodes.find(e => e.episode === opts.episodio) || temp.episodes[0];
            return escolherLinkQueFunciona(formatoAntigo(Object.assign({}, item, {
                id: ep.id, url: ep.url, mirrors: ep.mirrors, headers: ep.headers,
                serie: s.title, season: ep.season, episode: ep.episode,
                title: `${s.title} - T${ep.season}E${ep.episode}`, categoryType: 'vod'
            })));
        }
        const full = await Engine.getItem(item.id).catch(() => null);
        if (!full || !full.url) return item;
        return escolherLinkQueFunciona(Object.assign({}, item, { url: full.url, mirrors: full.mirrors, headers: full.headers }));
    };

    /**
     * Testa os links (principal + reservas) e devolve o item com o PRIMEIRO que
     * responde. Pega DNS bloqueado pela operadora, servidor fora do ar etc.
     * Só testa quando existe reserva — sem reserva, devolve direto (sem atraso).
     */
    async function alcancavel(url, ms) {
        if (!/^https?:/i.test(url)) return true;
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), ms);
        try {
            await fetch(url, { method: 'HEAD', mode: 'no-cors', cache: 'no-store', signal: ac.signal });
            return true;                      // qualquer resposta (até 404/405) = o servidor existe
        } catch (e) {
            return false;                     // DNS não resolveu, conexão recusada ou timeout
        } finally { clearTimeout(t); }
    }

    async function escolherLinkQueFunciona(item) {
        const principal = item.url || item.streamUrl;
        const reservas = (item.mirrors || []).filter(u => u && u !== principal);
        if (!principal || !reservas.length || CFG.testarLinks === false) return item;
        const candidatos = [principal, ...reservas];
        // testa todos em paralelo, mas respeita a ordem de preferência
        const testes = candidatos.map(u => alcancavel(u, CFG.testeLinkMs || 4000));
        for (let i = 0; i < candidatos.length; i++) {
            if (await testes[i]) {
                if (i === 0) return item;
                log(`🔀 Link principal inacessível, usando reserva ${i}: ${candidatos[i].slice(0, 60)}`);
                return Object.assign({}, item, {
                    url: candidatos[i],
                    mirrors: candidatos.filter((_, j) => j !== i)
                });
            }
        }
        return item;                          // nenhum respondeu: deixa o player tentar o principal
    }
    Engine.escolherLinkQueFunciona = escolherLinkQueFunciona;
    Engine.preencherCompat = preencherCompat;

    // ==================================================================
    // Ignição
    // ==================================================================
    let timerUpdate = null;

    async function iniciar(recarga = false) {
        const t0 = performance.now();
        log(recarga ? 'Recarregando...' : 'Iniciando ignição...', `(modo: ${CFG.modo})`);
        if (Engine._local) Engine._local.destruir();
        Engine._static = null;
        Engine._local = null;

        // 1) Catálogo estático
        if (CFG.modo !== 'legado') {
            try {
                const sp = new StaticProvider();
                await sp.init();
                Engine._static = sp;
            } catch (e) {
                if (CFG.modo === 'estatico') throw e;
                log('ℹ️ Catálogo estático indisponível (' + e.message + ') — usando modo legado.');
            }
        }

        // 2) Fontes locais: tudo (modo legado) ou só as "aoVivo" (híbrido)
        const fontes = await Engine._carregarFontes();
        const locais = Engine._static ? fontes.filter(f => f.aoVivo === true) : fontes;
        if (locais.some(f => f.ativo !== false && Core.isUsableUrl(f.url))) {
            const lp = new LocalProvider(locais);
            await lp.init();
            Engine._local = lp;
        }

        Engine.modo = Engine._static && Engine._local ? 'hibrido' : Engine._static ? 'estatico' : 'legado';
        Engine._juntarManifestos();

        if (window.EPGManager && Engine.manifest.epg.length) window.EPGManager.loadUrls(Engine.manifest.epg);
        try {
            await preencherCompat();
        } catch (e) {
            // Compatibilidade nunca derruba o motor: a API (getPage/search...) continua funcionando
            console.warn('⚠️ [Cloud Engine] Não consegui preencher window.DB:', e);
        }

        const falhas = (Engine.manifest.fontes || []).filter(f => !f.ok);
        falhas.forEach(f => console.warn(`❌ [Cloud Engine] Fonte "${f.nome}": ${f.erro}`));
        log(`✅ Pronto em ${Math.round(performance.now() - t0)}ms — modo ${Engine.modo} | ` +
            `${Engine.manifest.totals.itens.toLocaleString('pt-BR')} itens em ${Engine.manifest.categories.length} categorias | ` +
            `na memória: VOD ${((window.DB || {}).videos || []).length} · TV ${(window.CZ_IPTV || []).length} · Rádio ${(window.CZ_VIDEOS_RADIO || []).length} · Jogos ${((window.DB || {}).games || []).length}`);

        emit('cloud_engine_ready', { modo: Engine.modo, manifest: Engine.manifest });
        if (CFG.renderAutomatico && typeof window.render === 'function') window.render();

        // 3) Atualizações automáticas do catálogo estático
        clearInterval(timerUpdate);
        if (Engine._static && CFG.checarAtualizacaoMs > 0) {
            timerUpdate = setInterval(async () => {
                if (document.hidden) return;
                const m = await Engine._static.checkUpdate();
                if (!m) return;
                Engine._juntarManifestos();
                await preencherCompat().catch(e => console.warn('⚠️ [Cloud Engine] compat:', e));
                log('🔄 Catálogo atualizado para a versão', m.version);
                emit('cloud_engine_update', { manifest: Engine.manifest });
            }, CFG.checarAtualizacaoMs);
        }
        return Engine.manifest;
    }

    // ==================================================================
    // Limpeza única: o motor antigo gerava IDs quebrados como
    // "({showId}_S){temporada.season}E3" (bug das barras nas template strings).
    // Se o "continuar assistindo" guardou um desses, o card aponta para um episódio
    // que não existe: o título some e o player volta para o início. Remove esses registros.
    // ==================================================================
    (function limparIdsDoMotorAntigo() {
        try {
            const quebrado = (v) => typeof v === 'string' && /[{}]/.test(v) && /\(|\)/.test(v);
            const remover = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith('last_watched_') && quebrado(localStorage.getItem(k))) remover.push(k);
            }
            remover.forEach(k => localStorage.removeItem(k));
            if (remover.length) log(`🧹 ${remover.length} registro(s) de "continuar assistindo" do motor antigo removido(s):`, remover.map(k => k.slice(13)).join(', '));
        } catch (e) { /* localStorage indisponível */ }
    })();

    window.CloudEngine = Engine;
    Engine.ready = carregarCore().then((c) => { Core = c; return iniciar(); }).catch((e) => {
        console.error('❌ [Cloud Engine] Falha fatal:', e);
        Engine.modo = 'erro';
        Engine.manifest = { categories: [], destaques: [], epg: [], totals: { itens: 0, series: 0, categorias: 0 }, fontes: [] };
        emit('cloud_engine_ready', { modo: 'erro', erro: String(e.message || e) });
        return Engine.manifest;
    });
})();
