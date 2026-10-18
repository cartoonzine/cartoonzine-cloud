# Validador de links — Cartoonzine Cloud

Testa os links do catálogo a cada execução do robô (6 em 6 horas), escolhe a melhor
fonte de cada item e publica o catálogo já com a fonte boa na frente.

## Arquivos

| Arquivo | Função |
|---|---|
| `seguranca.mjs` | única saída para a internet: bloqueia rede interna/metadados de nuvem, confere o IP depois do DNS, segue redirecionamentos com as mesmas regras, limita tamanho e tempo, não envia Cookie/Authorization, esconde tokens nos logs |
| `verificadores.mjs` | testa cada formato: HLS (playlist → variante → 1 segmento), DASH (manifesto + inicialização), MP4/WebM/MKV (4 KB + assinatura), TS ao vivo, sem extensão |
| `motor.mjs` | fila com limite global e por servidor, novas tentativas só em falha passageira, 429/Retry-After, disjuntor por servidor, cache entre execuções, orçamento de tempo/memória, interrupção |
| `selecao.mjs` | ordena as fontes: funciona › nota de confiabilidade › latência › prioridade › ordem original (com estabilidade) |
| `index.mjs` | liga tudo ao `build-catalog.mjs` e escreve os relatórios |
| `instalar.mjs` | liga o validador no seu `tools/build-catalog.mjs` atual (8 trechos, com cópia de segurança) |

## Configuração (`sources.json` → bloco `"validacao"`)

| Campo | Padrão | O que faz |
|---|---|---|
| `apenasFontes` | (todas) | lista de `"nome"` das fontes que serão validadas; as outras ficam exatamente como vieram |
| `modo` | `"otimizar"` | `"relatorio"` = só testa e escreve o relatório; `"otimizar"` = reordena as fontes no catálogo; `"desligado"` |
| `manterReservas` | `true` | `false` = publica só a fonte escolhida |
| `semFonte` | `"marcar"` | item com TODAS as fontes falhando por N ciclos: `"marcar"` (`indisponivel: true`) ou `"remover"` |
| `falhasParaIndisponivel` | `3` | ciclos seguidos (3 = ~18 h) |
| `limiteRemocaoPorCiclo` | `0.2` | nunca remove mais que 20% de uma vez |
| `cicloSuspeitoAcimaDe` | `0.6` | se mais de 60% falharem, é a rede do robô: nada conta como falha |
| `concorrencia` / `porHost` | `16` / `2` | testes simultâneos no total / por servidor |
| `timeoutMs` / `tentativas` | `8000` / `1` | tempo por pedido / novas tentativas em falha passageira |
| `ttlOkHoras` | `24` | link bom só é retestado depois disso |
| `limiteLinks` / `orcamentoMin` | `3000` / `20` | máximo de links e de minutos por execução (o resto fica para o próximo ciclo) |
| `prioridadeServidores` | `{}` | ex.: `{ "meucdn.com": 10 }` — preferido em empate |

Por fonte: `"validar": false` faz a nuvem não testar os itens daquela fonte.

## Relatórios (`catalog/analise/`)

- `validacao.json` — resumo do ciclo (quantos ok/falharam, por motivo, por formato, tempo)
- `validacao-indisponiveis.json` / `.csv` — itens sem nenhuma fonte funcionando (abre no Excel)
- `validacao-trocas.json` — itens cuja fonte principal mudou e por quê

Os links nos relatórios aparecem **sem** tokens/senhas (`?token=***`, `/live/***/***/123.ts`).

## O que "ok" significa

Que um servidor nos EUA (o robô do GitHub) conseguiu abrir o começo do conteúdo.
Não garante que toca em todo aparelho: bloqueio por país, DRM, codec e links que expiram
só aparecem no aparelho. Por isso a nuvem **nunca apaga** um link — só reordena — e o
player continua passando para a próxima fonte quando uma falha.

## Testes

```
node --test test/validador/validador.test.mjs test/validador/build-e2e.test.mjs
```
Tudo roda contra um servidor falso em 127.0.0.1; nenhum site real é acessado.
