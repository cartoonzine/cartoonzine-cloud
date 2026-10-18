/**
 * validador/motor.mjs — testa MUITOS links com educação e dentro do orçamento.
 *
 *   • concorrência global limitada e no máximo N conexões por servidor (porHost)
 *   • intervalo mínimo entre pedidos ao mesmo servidor
 *   • nova tentativa SÓ para falha passageira (timeout, 5xx, 429...), com espera crescente
 *   • 429 com Retry-After: o servidor é pausado; se pedir espera longa, os links dele
 *     ficam para o próximo ciclo (não insiste)
 *   • "disjuntor" por servidor: várias falhas passageiras seguidas → para de testar
 *     aquele servidor neste ciclo
 *   • cache entre execuções: link bom só é retestado depois de `ttlOkHoras`; ruim, todo ciclo
 *   • orçamento de tempo e de memória: o que não couber fica para o próximo ciclo
 *   • interrupção (SIGTERM do GitHub, Ctrl+C): para limpo, o que não terminou não conta
 *   • links repetidos em vários itens são testados uma vez só
 */
import { criarRequisitor, chaveDoLink, redigir } from './seguranca.mjs';
import { verificar, detectarTipo } from './verificadores.mjs';

export const PADRAO = {
    concorrencia: 16,
    porHost: 2,
    intervaloPorHostMs: 150,
    timeoutMs: 8000,
    tentativas: 1,              // tentativas EXTRAS em falha passageira
    esperaMs: [1500, 4000],     // espera antes da 1ª, 2ª... nova tentativa
    retryAfterMaxS: 30,         // pausa máxima aceita de um 429 (acima disso: próximo ciclo)
    disjuntorPorHost: 5,        // falhas passageiras seguidas que "desligam" o servidor no ciclo
    ttlOkHoras: 24,             // link bom: retesta depois disso
    ttlNaoVerificavelHoras: 168,
    limiteLinks: 3000,          // máximo de links testados por execução
    orcamentoMin: 20,           // tempo máximo do teste por execução
    limiteMemoriaMB: 1536,
    alfa: 0.3                   // peso do resultado novo na nota de confiabilidade
};

const agora = () => Date.now();
const dormir = (ms, sinal) => new Promise(ok => {
    const t = setTimeout(ok, ms);
    if (sinal) sinal.addEventListener('abort', () => { clearTimeout(t); ok(); }, { once: true });
});
const hostDe = (url) => { try { return new URL(url).host.toLowerCase(); } catch { return '?'; } };

// ------------------------------------------------------------------ cache
/** Lê o health-cache.json (aceita o formato antigo { id: {at, fails} }). */
export function carregarCache(json) {
    if (json && json.versao === 2) return { versao: 2, links: json.links || {}, itens: json.itens || {} };
    // formato antigo do checkStreams: tudo era por item
    const itens = {};
    if (json && typeof json === 'object') for (const [id, h] of Object.entries(json)) if (h && typeof h === 'object' && 'fails' in h) itens[id] = { sf: h.fails | 0, t: h.at || 0 };
    return { versao: 2, links: {}, itens };
}

/** O link precisa ser testado de novo agora? */
export function precisaTestar(entrada, cfg, t = agora()) {
    if (!entrada) return true;
    const idade = t - (entrada.t || 0);
    if (entrada.e === 'ok') return idade > cfg.ttlOkHoras * 3600e3 * entrada.j;            // j = espalhamento (0.85–1.15)
    if (entrada.e === 'protegido' || entrada.e === 'nao_verificavel') return idade > cfg.ttlNaoVerificavelHoras * 3600e3;
    return true; // falhou / bloqueado / nunca concluído: todo ciclo
}

// ------------------------------------------------------------------ motor
export function criarMotor(opcoes = {}) {
    const cfg = { ...PADRAO, ...opcoes };
    const { requisitar, encerrar } = criarRequisitor({ redesPermitidas: opcoes.redesPermitidas, resolver: opcoes.resolver });
    const log = opcoes.log || (() => {});

    /**
     * Testa a lista de links.
     * @param {{url:string, headers?:object}[]} links  já sem repetição
     * @param {object} cache  vindo de carregarCache()
     * @param {AbortSignal} [sinal]
     * @returns {Promise<{resultados: Map<string,object>, estat: object}>}
     */
    async function testar(links, cache, sinal) {
        const inicio = agora();
        const limiteTempo = inicio + cfg.orcamentoMin * 60e3;
        const resultados = new Map();
        const estat = {
            links: links.length, testados: 0, doCache: 0, pulados: 0, ok: 0, falhou: 0, protegido: 0,
            naoVerificavel: 0, bloqueado: 0, novasTentativas: 0, porMotivo: {}, porTipo: {},
            servidoresDesligados: [], motivoParada: null
        };

        // 1) o que dá para responder pelo cache; o resto entra na fila (nunca testados primeiro, depois os mais antigos)
        const fila = [];
        for (const l of links) {
            const ent = cache.links[chaveDoLink(l.url)];
            if (!precisaTestar(ent, cfg)) { resultados.set(l.url, { estado: ent.e, tipo: ent.tipo, codigo: ent.c, doCache: true, ttfb: ent.l }); estat.doCache++; continue; }
            fila.push({ ...l, idade: ent ? ent.t : 0 });
        }
        fila.sort((a, b) => a.idade - b.idade);
        const excedente = fila.splice(cfg.limiteLinks);
        for (const l of excedente) resultados.set(l.url, { estado: 'pulado', motivo: 'limite de links por execução' });
        estat.pulados += excedente.length;

        // 2) filas por servidor (rodízio entre servidores)
        const hosts = new Map();
        for (const l of fila) {
            const h = hostDe(l.url);
            if (!hosts.has(h)) hosts.set(h, { fila: [], ativos: 0, livreEm: 0, falhasSeguidas: 0, desligado: false });
            hosts.get(h).fila.push(l);
        }
        const listaHosts = [...hosts.entries()];
        let ativos = 0, rodizio = 0, parar = null, relogio = null;
        const memoriaMB = () => process.memoryUsage().heapUsed / 1048576;

        await new Promise(fimGeral => {
            let pendentes = fila.length;
            if (!pendentes) return fimGeral();
            const concluir = (l, r) => {
                resultados.set(l.url, r);
                if (--pendentes === 0) fimGeral();
            };
            const pularResto = (motivo) => {
                for (const [, H] of listaHosts) while (H.fila.length) { estat.pulados++; concluir(H.fila.shift(), { estado: 'pulado', motivo }); }
            };
            const bomba = () => {
                if (!parar) {
                    if (sinal && sinal.aborted) parar = 'interrompido';
                    else if (agora() > limiteTempo) parar = `orçamento de ${cfg.orcamentoMin} min esgotado`;
                    else if (memoriaMB() > cfg.limiteMemoriaMB) parar = `memória acima de ${cfg.limiteMemoriaMB} MB`;
                    if (parar) { estat.motivoParada = parar; log(`⏸ Teste parado: ${parar}. O restante fica para o próximo ciclo.`); }
                }
                if (parar) return pularResto(parar);
                let voltas = 0;
                while (ativos < cfg.concorrencia && voltas < listaHosts.length) {
                    const [h, H] = listaHosts[rodizio++ % listaHosts.length];
                    voltas++;
                    if (!H.fila.length) continue;
                    if (H.desligado) { while (H.fila.length) { estat.pulados++; concluir(H.fila.shift(), { estado: 'pulado', motivo: `servidor ${h} desligado neste ciclo` }); } continue; }
                    if (H.ativos >= cfg.porHost) continue;
                    const espera = H.livreEm - agora();
                    if (espera > 0) { if (!relogio) relogio = setTimeout(() => { relogio = null; bomba(); }, espera); continue; }
                    voltas = 0;
                    const l = H.fila.shift();
                    H.ativos++; ativos++;
                    H.livreEm = agora() + cfg.intervaloPorHostMs;
                    testarUm(l, H, h).then(r => {
                        H.ativos--; ativos--;
                        concluir(l, r);
                        bomba();
                    });
                }
            };

            async function testarUm(l, H, h) {
                let r;
                for (let t = 0; ; t++) {
                    r = await verificar(l.url, { req: requisitar, timeoutMs: cfg.timeoutMs, headers: l.headers, sinal });
                    if (r.codigo === 'interrompido') return { estado: 'pulado', motivo: 'interrompido' };
                    if (r.estado !== 'falhou' || !r.transitorio) { H.falhasSeguidas = 0; break; }
                    H.falhasSeguidas++;
                    if (H.falhasSeguidas >= cfg.disjuntorPorHost && !H.desligado) {
                        H.desligado = true; estat.servidoresDesligados.push(h);
                        log(`⚡ ${h}: ${H.falhasSeguidas} falhas passageiras seguidas — servidor fora deste ciclo`);
                    }
                    if (t >= cfg.tentativas || H.desligado || (sinal && sinal.aborted)) break;
                    let espera = cfg.esperaMs[Math.min(t, cfg.esperaMs.length - 1)] * (0.8 + Math.random() * 0.4);
                    if (r.codigo === 'http_429') {
                        const ra = parseInt(r.retryAfter, 10);
                        if (Number.isFinite(ra) && ra > cfg.retryAfterMaxS) {
                            H.desligado = true; estat.servidoresDesligados.push(h);
                            log(`⏳ ${h}: pediu ${ra}s de pausa — os links dele ficam para o próximo ciclo`);
                            break;
                        }
                        if (Number.isFinite(ra)) espera = Math.max(espera, ra * 1000);
                        H.livreEm = Math.max(H.livreEm, agora() + espera);
                    }
                    estat.novasTentativas++;
                    await dormir(espera, sinal);
                }
                estat.testados++;
                return r;
            }

            bomba();
        });

        for (const r of resultados.values()) {
            if (r.doCache || r.estado === 'pulado') continue;
            if (r.estado === 'ok') estat.ok++;
            else if (r.estado === 'falhou') { estat.falhou++; estat.porMotivo[r.codigo] = (estat.porMotivo[r.codigo] || 0) + 1; }
            else if (r.estado === 'protegido') estat.protegido++;
            else if (r.estado === 'nao_verificavel') estat.naoVerificavel++;
            else if (r.estado === 'bloqueado') { estat.bloqueado++; estat.porMotivo[r.codigo] = (estat.porMotivo[r.codigo] || 0) + 1; }
            if (r.tipo) estat.porTipo[r.tipo] = (estat.porTipo[r.tipo] || 0) + 1;
        }
        estat.duracaoS = +((agora() - inicio) / 1000).toFixed(1);
        return { resultados, estat };
    }

    /**
     * Grava os resultados no cache (só chamar DEPOIS que o catálogo novo foi gerado).
     * @param {boolean} cicloSuspeito  se a maioria falhou (provável problema da rede do robô),
     *                                 não aumenta a contagem de falhas seguidas.
     */
    function registrar(cache, resultados, cicloSuspeito = false) {
        const t = agora();
        for (const [url, r] of resultados) {
            if (r.doCache || r.estado === 'pulado') continue;
            const k = chaveDoLink(url);
            const e = cache.links[k] || { ok: 0, f: 0, sf: 0, s: null, l: null, j: +(0.85 + Math.random() * 0.3).toFixed(2) };
            e.t = t; e.e = r.estado; e.tipo = r.tipo; e.c = r.codigo || undefined;
            if (r.estado === 'ok') {
                e.ok++; e.sf = 0;
                e.s = e.s == null ? 0.8 : +(e.s * (1 - cfg.alfa) + cfg.alfa).toFixed(3);
                if (Number.isFinite(r.ttfb)) e.l = e.l == null ? r.ttfb : Math.round(e.l * (1 - cfg.alfa) + r.ttfb * cfg.alfa);
            } else if (r.estado === 'falhou' && !cicloSuspeito) {
                e.f++; e.sf++;
                e.s = e.s == null ? 0.2 : +(e.s * (1 - cfg.alfa)).toFixed(3);
            }
            cache.links[k] = e;
        }
        return cache;
    }

    /** Remove do cache links que não aparecem mais no catálogo há muito tempo. */
    function podar(cache, urlsAtuais, dias = 30) {
        const vivos = new Set([...urlsAtuais].map(chaveDoLink));
        const limite = agora() - dias * 864e5;
        for (const [k, e] of Object.entries(cache.links)) if (!vivos.has(k) && (e.t || 0) < limite) delete cache.links[k];
        return cache;
    }

    return { testar, registrar, podar, encerrar, cfg };
}

export { redigir, chaveDoLink, detectarTipo };
