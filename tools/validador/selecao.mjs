/**
 * validador/selecao.mjs — escolhe a melhor fonte de cada item.
 *
 * Ordem de decisão (só entre links que JÁ existem no item — nunca inventa link):
 *   1. situação:   funcionou  >  não testado/não testável  >  falha passageira  >  falha
 *   2. confiabilidade (nota 0–1 acumulada entre ciclos), em faixas de 0.1
 *   3. latência (tempo até o 1º byte), em faixas de 300 ms
 *   4. prioridade configurada para o servidor (sources.json → validacao.prioridadeServidores)
 *   5. ordem original da fonte
 *
 * Estabilidade: se o link principal atual funciona e não é claramente pior que o melhor,
 * ele continua principal (evita o app trocar de servidor a cada 6 horas por diferença mínima).
 */
import { chaveDoLink } from './seguranca.mjs';

const CLASSE = { ok: 3, nao_testado: 2, transitorio: 1, falhou: 0 };

function classe(r, ent) {
    if (r && r.estado === 'ok') return CLASSE.ok;
    if (r && r.estado === 'falhou') return r.transitorio ? CLASSE.transitorio : CLASSE.falhou;
    // pulado / protegido / não verificável / bloqueado / sem resultado: vale o histórico
    if (ent && ent.e === 'ok') return CLASSE.ok;
    if (ent && ent.e === 'falhou' && ent.sf > 0) return CLASSE.transitorio;
    return CLASSE.nao_testado;
}

function hostDe(url) { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } }

function prioridade(url, mapa) {
    if (!mapa) return 0;
    const h = hostDe(url);
    for (const [dom, p] of Object.entries(mapa)) if (h === dom || h.endsWith('.' + dom)) return +p || 0;
    return 0;
}

/**
 * @param {string[]} urls          links do item, na ordem original (url, depois mirrors)
 * @param {Map} resultados         url → resultado do teste deste ciclo
 * @param {object} cache           cache do motor (links por chave)
 * @param {object} [cfg]           { prioridadeServidores, margemEstabilidade }
 * @returns {{ordem: string[], escolhida: string, situacao: 'ok'|'sem_teste'|'indisponivel', trocou: boolean, info: object[]}}
 */
export function ordenarFontes(urls, resultados, cache, cfg = {}) {
    const vistos = new Set();
    const info = [];
    urls.forEach((url, i) => {
        if (!url || vistos.has(url)) return;
        vistos.add(url);
        const r = resultados.get(url);
        const ent = cache.links[chaveDoLink(url)];
        const nota = ent && ent.s != null ? ent.s : (r && r.estado === 'ok' ? 0.8 : 0.5);
        const lat = (r && Number.isFinite(r.ttfb) && r.estado === 'ok') ? r.ttfb : (ent && ent.l != null ? ent.l : 5000);
        info.push({ url, i, classe: classe(r, ent), nota, lat, prio: prioridade(url, cfg.prioridadeServidores), estado: r ? r.estado : (ent ? ent.e : 'nao_testado') });
    });
    if (!info.length) return { ordem: [], escolhida: null, situacao: 'indisponivel', trocou: false, info };

    const cmp = (a, b) =>
        (b.classe - a.classe) ||
        (Math.floor(b.nota * 10) - Math.floor(a.nota * 10)) ||
        (Math.floor(a.lat / 300) - Math.floor(b.lat / 300)) ||
        (b.prio - a.prio) ||
        (a.i - b.i);
    const ordenada = info.slice().sort(cmp);

    // estabilidade: mantém o principal atual se ele funciona e está "perto" do melhor
    const atual = info[0];
    const melhor = ordenada[0];
    const margem = cfg.margemEstabilidade ?? 0.15;
    if (melhor !== atual && atual.classe === CLASSE.ok && melhor.classe === CLASSE.ok &&
        melhor.nota - atual.nota <= margem && atual.lat <= melhor.lat * 2 + 500 && atual.prio >= melhor.prio) {
        ordenada.splice(ordenada.indexOf(atual), 1);
        ordenada.unshift(atual);
    }

    const top = ordenada[0];
    const situacao = top.classe === CLASSE.ok ? 'ok' : top.classe === CLASSE.nao_testado ? 'sem_teste' : 'indisponivel';
    return { ordem: ordenada.map(x => x.url), escolhida: top.url, situacao, trocou: top.url !== urls[0], info };
}
