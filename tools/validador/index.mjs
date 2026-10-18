/**
 * validador/index.mjs — liga o validador ao build do catálogo.
 *
 * Uso dentro do tools/build-catalog.mjs (no lugar do antigo checkStreams):
 *
 *   const val = await validarCatalogo(builder, { config: cfg.validacao, fontes: sources, health: args.health, ... });
 *   const m = await emit(...);           // gera o catálogo novo
 *   await val.gravarRelatorio(dir);      // catalog/analise/validacao.json
 *   await val.confirmar();               // SÓ depois do catálogo publicado: grava o health-cache.json
 *
 * O que muda no item (só se validacao.modo = "otimizar"):
 *   url      → a melhor fonte que JÁ existia no item (nunca inventa link)
 *   mirrors  → as outras fontes, reordenadas da melhor para a pior (nenhuma é apagada)
 *   fontes/urls/sources/links/servidores (se o item tiver) → mesma lista, reordenada
 *   indisponivel: true → depois de N ciclos seguidos com TODAS as fontes falhando
 *                       (ou o item é removido, se validacao.semFonte = "remover")
 *
 * Nada do formato existente é removido ou renomeado: quem lê o catálogo antigo continua lendo.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { criarMotor, carregarCache, redigir } from './motor.mjs';
import { ordenarFontes } from './selecao.mjs';

export const CONFIG_PADRAO = {
    modo: 'otimizar',              // "otimizar" | "relatorio" (só testa e relata) | "desligado"
    manterReservas: true,          // false = publica só a escolhida (as outras somem do item)
    semFonte: 'marcar',            // "marcar" (indisponivel: true) | "remover"
    falhasParaIndisponivel: 3,     // ciclos seguidos com todas as fontes falhando
    limiteRemocaoPorCiclo: 0.2,    // nunca tira mais que 20% dos itens de uma vez
    cicloSuspeitoAcimaDe: 0.6,     // se >60% dos testados falharem, é a rede do robô: não conta falhas
    pularTipos: ['game'],          // categoryType que não são vídeo (ROMs etc.)
    apenasFontes: null,            // ["Filmes Saimo", ...] = SÓ essas fontes são validadas; null/vazio = todas
    prioridadeServidores: {}       // { "meuservidor.com": 10 } → preferido em caso de empate
};

const CAMPOS_LISTA = ['fontes', 'sources', 'links', 'urls', 'servidores'];
const urlDe = (f) => typeof f === 'string' ? f : (f && (f.url || f.link || f.src || f.file || f.stream)) || '';
const ehHttp = (u) => typeof u === 'string' && /^https?:\/\//i.test(u.trim());

/**
 * @param {object} builder   Core.CatalogBuilder já com as fontes carregadas
 * @param {object} o
 * @param {object} [o.config]        bloco "validacao" do sources.json
 * @param {object[]} [o.fontes]      lista de fontes (para respeitar "validar": false)
 * @param {string} o.health          caminho do health-cache.json
 * @param {object} [o.sobrescrever]  opções vindas da linha de comando (limiteLinks, orcamentoMin, timeoutMs...)
 * @param {string[]} [o.redesPermitidas]  SÓ TESTES
 * @param {AbortSignal} [o.sinal]
 * @param {Function} [o.log]
 */
export async function validarCatalogo(builder, o) {
    const log = o.log || console.log;
    const cfg = { ...CONFIG_PADRAO, ...(o.config || {}), ...(o.sobrescrever || {}) };
    if (cfg.modo === 'desligado') { log('🩺 Validação desligada (validacao.modo = "desligado")'); return null; }

    let cache;
    try { cache = carregarCache(JSON.parse(await fs.readFile(o.health, 'utf8'))); }
    catch { cache = carregarCache(null); }

    // nome da fonte comparado sem diferença de maiúsculas/espaços nas pontas
    const nomeN = (n) => String(n || '').trim().toLowerCase();
    const naoValidar = new Set((o.fontes || []).filter(f => f && f.validar === false).map(f => nomeN(f.nome)));
    const apenas = Array.isArray(cfg.apenasFontes) && cfg.apenasFontes.length ? new Set(cfg.apenasFontes.map(nomeN)) : null;
    if (apenas) {
        const existentes = new Set((o.fontes || []).map(f => nomeN(f && f.nome)));
        const naoAchadas = cfg.apenasFontes.filter(n => o.fontes && !existentes.has(nomeN(n)));
        log(`🩺 Validação só nas fontes: ${cfg.apenasFontes.join(', ')} — as demais ficam como vieram`);
        if (naoAchadas.length) log(`⚠ Estas fontes de "apenasFontes" não existem no sources.json (confira o "nome"): ${naoAchadas.join(', ')}`);
    }

    // 1) junta os itens e os links únicos
    const itens = [];
    const links = new Map(); // url → headers
    for (const it of builder.items.values()) {
        const origem = nomeN(it.origem);
        if (cfg.pularTipos.includes(it.categoryType) || naoValidar.has(origem) || (apenas && !apenas.has(origem))) continue;
        const listaCampo = CAMPOS_LISTA.find(k => Array.isArray(it[k]) && it[k].length);
        const urls = [it.url, ...(it.mirrors || []), ...(listaCampo ? it[listaCampo].map(urlDe) : [])].filter(ehHttp);
        if (!urls.length) continue;
        itens.push({ it, urls: [...new Set(urls)], listaCampo });
        for (const u of urls) if (!links.has(u)) links.set(u, it.headers);
    }

    const motor = criarMotor({ ...cfg, log, redesPermitidas: o.redesPermitidas, resolver: o.resolver });
    log(`🩺 Validando ${links.size} links de ${itens.length} itens (até ${motor.cfg.limiteLinks} testes, ${motor.cfg.concorrencia} simultâneos, ${motor.cfg.porHost}/servidor, orçamento ${motor.cfg.orcamentoMin} min)`);
    const { resultados, estat } = await motor.testar([...links].map(([url, headers]) => ({ url, headers })), cache, o.sinal);
    motor.encerrar();

    const testadosAgora = estat.ok + estat.falhou;
    const suspeito = testadosAgora >= 20 && estat.falhou / testadosAgora > cfg.cicloSuspeitoAcimaDe;
    if (suspeito) log(`⚠ ${estat.falhou} de ${testadosAgora} falharam (> ${Math.round(cfg.cicloSuspeitoAcimaDe * 100)}%): provável problema de rede do robô — nenhuma falha será contada neste ciclo`);

    // 2) decide cada item
    const otimizar = cfg.modo === 'otimizar';
    const rel = { trocas: [], indisponiveis: [], recuperados: [], removidos: [], semTeste: 0, ok: 0 };
    const remover = new Set();
    for (const { it, urls, listaCampo } of itens) {
        const sel = ordenarFontes(urls, resultados, cache, cfg);
        const ent = cache.itens[it.id] || { sf: 0 };
        // falha do ITEM só conta se todos os links foram testados AGORA e falharam
        const todosFalharamAgora = urls.every(u => { const r = resultados.get(u); return r && !r.doCache && r.estado === 'falhou'; });

        if (sel.situacao === 'ok') {
            rel.ok++;
            if (ent.sf >= cfg.falhasParaIndisponivel) rel.recuperados.push({ id: it.id, titulo: it.title });
            ent.sf = 0;
            if (otimizar) delete it.indisponivel;
        } else if (sel.situacao === 'indisponivel' && todosFalharamAgora && !suspeito) {
            ent.sf = (ent.sf || 0) + 1;
        } else if (sel.situacao === 'sem_teste') rel.semTeste++;
        ent.t = Date.now();
        cache.itens[it.id] = ent;

        if (ent.sf >= cfg.falhasParaIndisponivel) {
            const motivos = urls.map(u => { const r = resultados.get(u); return r ? (r.codigo || r.estado) : 'sem_resultado'; });
            rel.indisponiveis.push({ id: it.id, titulo: it.title, categoria: it.cat, origem: it.origem, ciclosSeguidos: ent.sf, motivos, links: urls.map(redigir) });
            if (otimizar) {
                if (cfg.semFonte === 'remover') remover.add(it.id);
                else it.indisponivel = true;
            }
        }

        if (!otimizar || sel.ordem.length === 0) continue;
        if (sel.trocou) rel.trocas.push({ id: it.id, titulo: it.title, de: redigir(urls[0]), para: redigir(sel.escolhida), motivo: sel.info.find(x => x.url === urls[0])?.estado });
        // aplica: url + mirrors (só links que o item já tinha)
        const originais = new Set([it.url, ...(it.mirrors || [])].filter(ehHttp));
        const extrasNaoHttp = (it.mirrors || []).filter(u => !ehHttp(u));
        it.url = sel.escolhida;
        if (cfg.manterReservas) {
            const reservas = sel.ordem.filter(u => u !== sel.escolhida && originais.has(u));
            if (reservas.length || it.mirrors) it.mirrors = reservas.concat(extrasNaoHttp);
        } else if (it.mirrors) it.mirrors = extrasNaoHttp;
        // lista com idioma/qualidade (player): mesma lista, só reordenada
        if (listaCampo) {
            const pos = new Map(sel.ordem.map((u, i) => [u, i]));
            it[listaCampo] = it[listaCampo].map((f, i) => [f, i])
                .sort((a, b) => (pos.get(urlDe(a[0])) ?? 1e9) - (pos.get(urlDe(b[0])) ?? 1e9) || a[1] - b[1])
                .map(x => x[0]);
        }
    }

    // 3) trava de remoção em massa
    if (remover.size) {
        const limite = Math.floor(builder.items.size * cfg.limiteRemocaoPorCiclo);
        if (remover.size > limite) {
            log(`⚠ ${remover.size} itens seriam removidos (> ${Math.round(cfg.limiteRemocaoPorCiclo * 100)}% do catálogo): nada removido neste ciclo, só marcados`);
            for (const id of remover) { const it = builder.items.get(id); if (it) it.indisponivel = true; }
        } else {
            rel.removidos = [...remover];
            builder.remove(remover);
        }
    }

    log(`🩺 links: ok=${estat.ok} falhou=${estat.falhou} protegido=${estat.protegido} nãoTestável=${estat.naoVerificavel} bloqueado=${estat.bloqueado} doCache=${estat.doCache} pulados=${estat.pulados} (${estat.duracaoS}s)`);
    log(`🩺 itens: ok=${rel.ok} semTeste=${rel.semTeste} principalTrocado=${rel.trocas.length} indisponíveis=${rel.indisponiveis.length} removidos=${rel.removidos.length}${otimizar ? '' : ' (modo relatório: catálogo NÃO alterado)'}`);

    const relatorio = {
        geradoEm: new Date().toISOString(),
        modo: cfg.modo,
        aviso: 'ok = a nuvem conseguiu abrir o começo do conteúdo a partir de um servidor nos EUA. Não garante que toca em todo aparelho/região.',
        cicloSuspeito: suspeito,
        configuracao: { ...cfg, prioridadeServidores: cfg.prioridadeServidores },
        links: estat,
        itens: { avaliados: itens.length, ok: rel.ok, semTeste: rel.semTeste, principalTrocado: rel.trocas.length, indisponiveis: rel.indisponiveis.length, removidos: rel.removidos.length, recuperados: rel.recuperados.length }
    };

    return {
        relatorio,
        detalhes: rel,
        async gravarRelatorio(dir) {
            await fs.mkdir(dir, { recursive: true });
            const csv = '﻿' + ['titulo;categoria;origem;ciclos;motivos;id',
                ...rel.indisponiveis.map(x => [x.titulo, x.categoria, x.origem, x.ciclosSeguidos, x.motivos.join(' | '), x.id]
                    .map(v => { const t = v == null ? '' : String(v); return /[";\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; }).join(';'))].join('\n');
            await Promise.all([
                fs.writeFile(path.join(dir, 'validacao.json'), JSON.stringify(relatorio, null, 2)),
                fs.writeFile(path.join(dir, 'validacao-indisponiveis.json'), JSON.stringify(rel.indisponiveis, null, 1)),
                fs.writeFile(path.join(dir, 'validacao-indisponiveis.csv'), csv),
                fs.writeFile(path.join(dir, 'validacao-trocas.json'), JSON.stringify(rel.trocas.slice(0, 5000), null, 1))
            ]);
        },
        /** Grava o cache. Chamar SÓ depois que o catálogo novo foi publicado com sucesso. */
        async confirmar() {
            motor.registrar(cache, resultados, suspeito);
            motor.podar(cache, links.keys());
            for (const [id, e] of Object.entries(cache.itens)) if (!builder.items.has(id) && Date.now() - (e.t || 0) > 30 * 864e5) delete cache.itens[id];
            const tmp = o.health + '.tmp';
            await fs.writeFile(tmp, JSON.stringify(cache));
            await fs.rename(tmp, o.health); // troca atômica
        }
    };
}
