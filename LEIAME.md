# Cloud Engine v2 — Cartoonzine

Motor de catálogo feito para **milhões** de vídeos, séries, canais, rádios e jogos, em JavaScript puro.

## A ideia central (o que a Netflix faz)

O motor antigo baixava **todas** as listas e jogava tudo em `window.DB.videos` a cada abertura do app.
Com 1 milhão de itens isso significa centenas de MB baixados, parse travando a tela e o celular sem memória.

O v2 separa em duas etapas:

1. **Fábrica (fora do navegador)**: `tools/build-catalog.mjs` baixa as fontes, limpa, remove duplicados,
   agrupa séries e gera um catálogo **fatiado** em arquivos pequenos. Roda no GitHub Actions a cada 6h.
2. **App (navegador)**: `cloud-engine.js` baixa só o que aparece na tela — a 1ª página de cada fileira,
   a próxima quando o usuário rola, o detalhe quando clica, a fatia da busca quando digita.

Resultado medido com 830 mil itens: app pronto em **~80 ms com 0,6 MB baixados** (antes: centenas de MB).

## Arquivos

| Arquivo | Função |
|---|---|
| `catalog-core.js` | Núcleo compartilhado (navegador + Node): IDs estáveis, parser M3U, normalização, deduplicação, séries, busca |
| `cloud-engine.js` | Motor do app: modo estático, legado e híbrido; cache RAM + IndexedDB; API |
| `sources.json` | Lista única de fontes (substitui o `MODULOS_NUVEM` de dentro do JS) |
| `tools/build-catalog.mjs` | Gera a pasta `catalog/` |
| `.github/workflows/build-catalog.yml` | Roda o build sozinho a cada 6h |
| `exemplo.html` | Página de exemplo com home em fileiras, rolagem infinita e busca |
| `test/` | Gerador de 1 milhão de itens + testes (Node e navegador) |

## Instalação

```html
<script src="catalog-core.js"></script>
<script src="cloud-engine.js"></script>
```

Sem nenhum build ele já funciona em **modo legado** (lê o `sources.json` direto, mas agora dentro de
um Web Worker, sem travar a tela). Quando existir `catalog/manifest.json`, ele muda sozinho para o
**modo estático**.

Gerar o catálogo no seu PC (Node 18+):

```bash
node tools/build-catalog.mjs --sources sources.json --out catalog
```

## Usando no app

```js
await CloudEngine.ready;

CloudEngine.categorias();                       // [{nome, slug, type, destino, total, pages}]
CloudEngine.categorias({ destino: 'iptv' });    // só as de TV

const cards = await CloudEngine.getPage('Filmes', 0);   // 120 cards
const serie = await CloudEngine.getSeries(card.id);     // temporadas + episódios
const item  = await CloudEngine.getItem(card.id);       // detalhe completo
const achou = await CloudEngine.search('naruto');       // sem acento, por prefixo

// Player com failover: se a 1ª URL cair, tenta os espelhos
for (const url of CloudEngine.streamCandidates(item)) { /* tenta tocar */ }

// Rolagem infinita pronta (render devolve um Element)
CloudEngine.montarGrade(divDaFileira, 'Filmes', card => criarCard(card), { root: divDaFileira });
```

**Compatibilidade:** `window.DB.videos`, `window.CZ_IPTV`, `window.CZ_VIDEOS_RADIO`, `window.DB.games`
e `DB.destaques` continuam sendo preenchidos, e o evento `cloud_engine_ready` + `window.render()`
continuam iguais. A diferença: por padrão entra só a **1ª página de cada categoria**. Para o
comportamento antigo (tudo na memória), use `paginasIniciaisPorCategoria: Infinity` — mas o
recomendado é migrar as telas para `getPage`/`montarGrade`.

**Séries mudaram:** antes cada episódio virava um card (65 mil cards para poucas séries). Agora cada
série é **um card** (`categoryType: 'series'`) e os episódios vêm de `getSeries(id)`.

## Fontes (`sources.json`)

Mesmos campos do antigo `MODULOS_NUVEM`, mais alguns opcionais:

| Campo | Para quê |
|---|---|
| `aoVivo: true` | Não entra no build; o navegador carrega direto (listas pequenas que mudam toda hora) |
| `ativo: false` | Desliga a fonte sem apagar |
| `categoryType` | Força o tipo (`vod`, `live`, `radio`, `game`) — ex.: M3U de filmes |
| `formato` | `json` ou `m3u`, quando a extensão não deixa claro |
| `destino` | Em qual lista antiga cai: `videos`, `iptv`, `radio`, `games` |

Fontes sem URL ou com `SEU_USER` são ignoradas automaticamente.

## O que o motor faz sozinho

- **IDs estáveis** (mesmo item = mesmo ID sempre) → favoritos e "continuar assistindo" não se perdem.
- **Duplicados viram espelhos**: mesmo filme (título+ano), mesmo canal (`tvg-id`) ou mesmo episódio
  em fontes diferentes vira 1 card com até 8 URLs de reserva.
- **Séries detectadas** em listas M3U pelo título (`S01E02`, `T1E2`, `1x02`).
- **Streams mortos** (`--check-streams`): testa links e só remove depois de 3 falhas seguidas;
  se o principal cai e um espelho funciona, o espelho vira o principal.
- **Travas de segurança**: se todas as fontes falharem, ou o catálogo encolher mais de 50%, o build
  **não publica** e mantém o anterior.
- **Offline**: sem internet, o app abre com o último catálogo salvo no IndexedDB.
- **Atualização**: a cada 30 min procura catálogo novo e dispara `cloud_engine_update`.
- `#EXTVLCOPT` (User-Agent/Referer) vira `item.headers`; `url-tvg` do M3U alimenta o `EPGManager`.

## Hospedagem (importante para milhões)

O catálogo de teste com 830 mil itens ocupou ~760 MB em ~15 mil arquivos. Confira os limites atuais,
mas em linhas gerais:

- **Até algumas centenas de milhares de itens**: o workflow que já vem pronto (commita `catalog/` no
  repositório e serve pelo GitHub Pages) resolve.
- **Milhões**: publique `catalog/` num storage de objetos com CDN, como **Cloudflare R2** (sem custo de
  tráfego de saída), usando `rclone sync` no lugar do `git push` no workflow — ele só envia os arquivos
  que mudaram. Aponte `CLOUD_ENGINE_CONFIG.manifestUrl` para lá (com CORS liberado).

## Testes

```bash
node test/gen-data.mjs                                   # gera ~1 milhão de itens falsos
node tools/build-catalog.mjs --sources test/sources.test.json --out test/catalog
node test/node-client-test.mjs                           # 30+ verificações do motor
node test/browser-test.cjs                               # Chromium real (precisa do playwright)
```
