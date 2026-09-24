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

    // Compatibilidade com o app antigo
    window.DB = window.DB || { videos: [], games: [], destaques: [] };
    window.DB.videos = window.DB.videos || [];
    window.DB.games = window.DB.games || [];
    window.DB.destaques = window.DB.destaques || [];
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
        paginasIniciaisPorCategoria: 1,        // quanto vai para window.DB no boot (Infinity = tudo, como antes)
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
    async function preencherCompat() {
        const lim = CFG.paginasIniciaisPorCategoria;
        if (!lim) return;
        const alvo = { videos: window.DB.videos, iptv: window.CZ_IPTV, radio: window.CZ_VIDEOS_RADIO, games: window.DB.games };
        for (const k of Object.keys(alvo)) alvo[k].length = 0;
        window.DB.destaques.length = 0;
        window.DB.destaques.push(...(Engine.manifest.destaques || []));

        const tarefas = [];
        for (const c of Engine.manifest.categories) {
            const paginas = Math.min(c.pages, lim);
            for (let n = 0; n < paginas; n++) tarefas.push({ c, n });
        }
        const resultados = await Promise.all(tarefas.map(t => Engine.getPage(t.c, t.n).catch(() => [])));
        resultados.forEach((cards, i) => {
            const destino = alvo[tarefas[i].c.destino] || alvo.videos;
            for (const card of cards) {
                if (destino === window.CZ_IPTV) {           // apelidos que listas IPTV costumam usar
                    card.name = card.name || card.title;
                    card.logo = card.logo || card.thumb;
                    card.group = card.group || card.cat;
                }
                destino.push(card);
            }
        });
    }

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
        await preencherCompat();

        const falhas = (Engine.manifest.fontes || []).filter(f => !f.ok);
        falhas.forEach(f => console.warn(`❌ [Cloud Engine] Fonte "${f.nome}": ${f.erro}`));
        log(`✅ Pronto em ${Math.round(performance.now() - t0)}ms — modo ${Engine.modo} | ` +
            `${Engine.manifest.totals.itens.toLocaleString('pt-BR')} itens em ${Engine.manifest.categories.length} categorias | ` +
            `na memória: VOD ${window.DB.videos.length} · TV ${window.CZ_IPTV.length} · Rádio ${window.CZ_VIDEOS_RADIO.length} · Jogos ${window.DB.games.length}`);

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
                await preencherCompat();
                log('🔄 Catálogo atualizado para a versão', m.version);
                emit('cloud_engine_update', { manifest: Engine.manifest });
            }, CFG.checarAtualizacaoMs);
        }
        return Engine.manifest;
    }

    window.CloudEngine = Engine;
    Engine.ready = carregarCore().then((c) => { Core = c; return iniciar(); }).catch((e) => {
        console.error('❌ [Cloud Engine] Falha fatal:', e);
        Engine.modo = 'erro';
        Engine.manifest = { categories: [], destaques: [], epg: [], totals: { itens: 0, series: 0, categorias: 0 }, fontes: [] };
        emit('cloud_engine_ready', { modo: 'erro', erro: String(e.message || e) });
        return Engine.manifest;
    });
})();
