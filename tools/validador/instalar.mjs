#!/usr/bin/env node
/**
 * Liga o validador no SEU tools/build-catalog.mjs (sem trocar o arquivo inteiro).
 *
 *   node tools/validador/instalar.mjs            → aplica
 *   node tools/validador/instalar.mjs --conferir → só diz se dá para aplicar
 *
 * • Faz cópia de segurança: tools/build-catalog.mjs.antes-do-validador
 * • Só mexe em 8 trechos conhecidos; se algum não for encontrado, NÃO altera nada
 * • Rodar duas vezes não estraga (detecta que já foi instalado)
 * • O antigo checkStreams continua no arquivo (sem uso) — nada é apagado
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const alvo = path.join(raiz, 'tools', 'build-catalog.mjs');
const soConferir = process.argv.includes('--conferir');

let s = fs.readFileSync(alvo, 'utf8');
if (s.includes("from './validador/index.mjs'")) { console.log('✔ O validador já está ligado neste build-catalog.mjs. Nada a fazer.'); process.exit(0); }

const trocas = [
    ["import { fileURLToPath } from 'node:url';\n",
     "import { fileURLToPath } from 'node:url';\nimport { validarCatalogo } from './validador/index.mjs';\n"],
    ["case '--check-limit': a.checkLimit = +v; i++; break;",
     "case '--check-limit': a.checkLimit = +v; a.checkLimitDefinido = true; i++; break;"],
    ["case '--compat-episodios': a.compatEpisodios = true; break;",
     "case '--compat-episodios': a.compatEpisodios = true; break;\n            case '--validar-tudo': a.validarTudo = true; break;"],
    ['async function emit(builder, args, epg, sourcesReport) {',
     'async function emit(builder, args, epg, sourcesReport, validacao) {'],
    [/(\n[ \t]*)fontes: sourcesReport\n([ \t]*)};/,
     (m, i1, i2) => `${i1}fontes: sourcesReport\n${i2}};\n${i2}// campo novo e opcional: diz ao app quando os links foram validados\n${i2}if (validacao) manifest.validacao = { em: validacao.relatorio.geradoEm, modo: validacao.relatorio.modo, cicloSuspeito: validacao.relatorio.cicloSuspeito };`],
    [/([ \t]*)await escreverAnalise\(builder, path\.join\(tmp, 'analise'\), manifest\.generatedAt\);\n/,
     (m, i) => `${m}${i}if (validacao) await validacao.gravarRelatorio(path.join(tmp, 'analise'));\n`],
    [/([ \t]*)if \(args\.checkStreams\) await checkStreams\(builder, args\);\n/,
     (m, i) => [
         `${i}// Validação dos links (tools/validador/). Interrupção = não publica nada (fica o catálogo anterior).`,
         `${i}let validacao = null;`,
         `${i}if (args.checkStreams) {`,
         `${i}    const ac = new AbortController();`,
         `${i}    const parar = () => { log('✋ Sinal de parada recebido — terminando o que está em andamento...'); ac.abort(); };`,
         `${i}    process.once('SIGTERM', parar); process.once('SIGINT', parar);`,
         `${i}    validacao = await validarCatalogo(builder, {`,
         `${i}        config: cfg.validacao, fontes: sources, health: args.health, sinal: ac.signal, log,`,
         `${i}        // SÓ para a suíte de testes (servidor falso em 127.0.0.1). Nunca ligado no workflow.`,
         `${i}        redesPermitidas: process.env.CZ_VALIDADOR_TESTE === '1' ? ['127.0.0.1/32'] : undefined,`,
         `${i}        sobrescrever: {`,
         `${i}            ...(args.checkLimitDefinido ? { limiteLinks: args.checkLimit } : {}),`,
         `${i}            ...(args.validarTudo ? { ttlOkHoras: 0, ttlNaoVerificavelHoras: 0 } : {})`,
         `${i}        }`,
         `${i}    });`,
         `${i}    if (ac.signal.aborted) { log('✖ Execução interrompida — catálogo anterior mantido, nada publicado.'); process.exit(1); }`,
         `${i}}`,
         ''
     ].join('\n')],
    [/([ \t]*)const m = await emit\(builder, args, epg, report\);\n/,
     (m, i) => `${i}const m = await emit(builder, args, epg, report, validacao);\n${i}if (validacao) await validacao.confirmar(); // cache só é gravado depois do catálogo novo publicado\n`]
];

const faltando = [];
for (const [de, para] of trocas) {
    const achou = typeof de === 'string' ? s.split(de).length === 2 : (s.match(new RegExp(de.source, 'g')) || []).length === 1;
    if (!achou) { faltando.push(String(de).slice(0, 70)); continue; }
    s = s.replace(de, para);
}
if (faltando.length) {
    console.error('✖ Não apliquei NADA: estes trechos não foram encontrados exatamente uma vez no seu build-catalog.mjs:');
    for (const f of faltando) console.error('   • ' + f);
    console.error('  Mande o arquivo para revisão manual.');
    process.exit(1);
}
if (soConferir) { console.log('✔ Todos os 8 trechos encontrados. Pode aplicar.'); process.exit(0); }

fs.copyFileSync(alvo, alvo + '.antes-do-validador');
fs.writeFileSync(alvo, s);
console.log('✔ Validador ligado no tools/build-catalog.mjs');
console.log('  Cópia do original: tools/build-catalog.mjs.antes-do-validador (pode apagar depois de conferir)');
