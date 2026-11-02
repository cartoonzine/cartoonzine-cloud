# 🎛️ Cartoonzine Studio

O lugar onde o conteúdo do Cartoonzine nasce. Você adiciona **cartoons, animes, desenhos 24h, filmes,
séries, rádios, canais do TVzine e jogos retrô**. O Studio organiza, completa e publica os DBs
que o [cartoonzine-cloud](https://github.com/cartoonzine/cartoonzine-cloud) já sabe ler.

```
 você (painel, linha de comando ou arquivo)
        │  "Caverna do Dragão S01E03 | https://…"
        ▼
 conteudo/        um .json por série/filme/canal/rádio/jogo  ← fonte da verdade
        │  GitHub Actions (sozinho, a cada mudança)
        ▼
 dist/            cartoons.json · animes.json · canais.m3u · jogos/megadrive.json …
        │  links fixos, ligados uma vez no sources.json do cloud
        ▼
 cartoonzine-cloud → catálogo fatiado → app Cartoonzine / TVzine / Emulador
```

## O que ele faz sozinho

- **Entende o que você cola**: `Nome | link | capa`, links soltos, listas M3U inteiras, links do
  archive.org e até as **mensagens do @CZStreamBot** (pega o link de download e ignora o `/watch/`).
- **Monta séries pelo nome do arquivo**: `Naruto S01E03`, `1x05`, `T2E10`, `Episódio 12`,
  `Temporada 2 Episódio 7`. Episódio novo de uma série que já existe entra na temporada certa.
- **Junta em vez de duplicar**: mesmo nome = mesmo item. Link repetido vira **link reserva**
  (o player tenta o próximo quando um cai). Nada que você escreveu é apagado.
- **Preenche sozinho pelo TMDB**: sinopse em português, capa, banner, ano, gêneros e, nas séries,
  título, sinopse e imagem de **cada episódio**. Cole o link do TMDB ou do IMDb para acertar a obra
  exata; sem link, ele procura pelo nome. Sem chave do TMDB, usa a Wikipedia.
- **Nota do IMDb** (⭐ 8,4) pelo OMDb, atualizada toda semana.
- **Internet Archive**: todos os vídeos de um item viram filme ou série com um clique.
- **Limpa o nome**: tira `720p`, `WEB-DL`, `x264`, `[grupo]`, detecta `Dublado/Legendado` e o ano.
- **Traduz categorias** de listas em inglês (iptv-org, Pluto TV): `News` → Notícias, `Kids` → Infantil…
- **Valida antes de publicar**: item com erro fica de fora e aparece em `dist/relatorio.json`;
  o resto publica normalmente.
- **Modo automático**: puxa listas M3U, itens e buscas do Internet Archive todo dia
  (`automatico/fontes.json`) sem atropelar o que você fez à mão.
- **Testa os links** todo dia e marca como morto só depois de 3 falhas seguidas.

---

## Instalação (uma vez só)

1. **Crie o repositório** `cartoonzine/cartoonzine-studio` no GitHub (público, igual ao cloud) e suba
   todos os arquivos desta pasta (pelo GitHub Desktop, `git push` ou "Add file → Upload files").
2. **Deixe o robô gravar**: no repositório, *Settings → Actions → General → Workflow permissions* →
   marque **Read and write permissions** → *Save*.
3. **Ligue o painel online**: *Settings → Pages* → *Source: Deploy from a branch* → branch `main`,
   pasta `/ (root)` → *Save*. Em 1–2 minutos o painel abre em
   `https://cartoonzine.github.io/cartoonzine-studio/`.
4. **Crie um token** para o painel salvar no GitHub:
   [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new) →
   *Repository access: Only select repositories* → `cartoonzine-studio` →
   *Permissions → Contents: Read and write* → *Generate*. Cole no painel ao conectar.
5. **Ligue ao cartoonzine-cloud** (uma vez; os links nunca mudam):
   ```bash
   node tools/ligar-cloud.mjs ../cartoonzine-cloud/sources.json
   ```
   Isso preenche as vagas vazias do `sources.json` do cloud (Cartoons VOD, Animes, Desenhos 24 Horas,
   Séries, Rádios e cada console) e adiciona "Filmes (Studio)" e "TVzine - Canais (Studio)".
   Depois é só commit/push do cloud.

> Repositório com outro nome ou em outra conta? Troque `publicacao` no `studio.config.json` antes do passo 5.

---

## TMDB, IMDb e nota (opcional, recomendado)

O Studio funciona sem chave nenhuma (usa a Wikipedia), mas com elas fica muito melhor.

| Chave | Para quê | Onde pegar (grátis) |
|---|---|---|
| **TMDB** | sinopse pt-BR, capas, banner, episódios | themoviedb.org → crie a conta → *Configurações → API* → copie o **Token de leitura da API** |
| **OMDb** | nota do IMDb | omdbapi.com/apikey.aspx → plano *FREE* → confirme pelo e-mail |

**No painel:** botão **🔑 Chaves** no topo → cole as duas → *Salvar e testar*. Ficam só no seu navegador.

**No robô** (para itens do modo automático e para completar o que ficou faltando todo dia):
*Settings → Secrets and variables → Actions → New repository secret* → crie `TMDB_TOKEN` e `OMDB_KEY`.

Como usar:
- Cole o link do TMDB (`themoviedb.org/tv/230050`) ou do IMDb (`imdb.com/title/tt28313387`) sozinho
  numa linha, antes dos links dos episódios, na adição rápida. Vale para os links seguintes até
  uma linha vazia. Ou na mesma linha: `Nome | link do IMDb | link do vídeo`.
- No formulário, há os campos **TMDB** e **IMDb**. Preencha um e clique em **✨ Preencher automaticamente**.
- O que você escreveu nunca é trocado; só o que está vazio é preenchido. A exceção é a nota, que se atualiza.
- Achou pelo nome e não pelo link? O painel avisa para conferir se é a obra certa.

> Os termos do TMDB pedem um crédito no app, por exemplo na tela "Sobre": *"Este produto usa a API
> do TMDB, mas não é endossado nem certificado pelo TMDB."* O uso grátis é para projetos não comerciais.

No app, cada filme/série chega com `imdbRating`, `imdbVotes`, `imdbId` e `tmdbId`, e cada episódio
com `desc` (sinopse) e `thumb` (imagem do episódio).

---

## Três jeitos de adicionar conteúdo

### 1. Painel (o mais fácil)

Online pelo GitHub Pages, ou no seu PC sem token:

```bash
node tools/painel.mjs          # abre em http://localhost:4321 e salva direto em conteudo/
```

- **⚡ Adicionar rápido**: cole qualquer coisa (lista M3U, vários links, mensagens do bot, links do
  archive.org), escolha os padrões (país, categoria, console, áudio) e clique em **Analisar**.
  Aparece uma prévia dizendo o que é novo e o que vai **juntar com o existente**. **Salvar** grava
  tudo de uma vez (no GitHub, um único commit).
- **+ Novo / clicar num card**: formulário completo, editor de temporadas, **📋 Colar vários
  episódios** dentro de uma série e **✨ Preencher automaticamente**.
- **Salvar como rascunho**: guarda sem publicar, para terminar depois.
- **Links publicados**: os endereços fixos de cada DB.

### 2. Linha de comando (Node 18+, sem instalar nada)

```bash
# um item
node tools/add.mjs cartoons "Popeye o Marinheiro (1933)" https://…/popeye.mp4 --wiki
node tools/add.mjs cartoons "Caverna do Dragão S01E03" https://…/ep3.mp4         # entra na série
node tools/add.mjs canais "TV Cultura" https://…/cultura.m3u8 --pais BR --categoria Educativo
node tools/add.mjs radios "Rádio X" https://…/stream --pais BR --cidade "São Paulo"
node tools/add.mjs jogos "Sonic" https://…/sonic.zip --console megadrive
node tools/add.mjs filmes "Nosferatu" https://archive.org/details/<id> --dados    # importa do archive
node tools/add.mjs animes "Série X S02E01" https://…/ep1.mp4 --tmdb https://www.themoviedb.org/tv/230050
node tools/add.mjs filmes "Filme Y" https://…/y.mp4 --imdb tt28313387

# muitos de uma vez
node tools/importar.mjs canais lista.m3u --pais BR --idioma Português
node tools/importar.mjs animes links.txt --dados   # --dados: sinopse/capas pelo nome
node tools/importar.mjs cartoons - --simular      # cole no terminal, Ctrl+D; --simular não salva

node tools/completar.mjs                          # completa o que está sem sinopse/capa/episódios
node tools/build.mjs                              # gera dist/ (o GitHub faz isso sozinho)
```

### 3. Arquivos

Um `.json` por item em `conteudo/<coleção>/`. Modelos prontos em [`exemplos/`](exemplos/).
Dá para editar até pelo site do GitHub: o robô publica sozinho a cada commit.

---

## Coleções

| Coleção | Pasta | Vai para | Arquivos publicados |
|---|---|---|---|
| 🎨 Cartoons | `conteudo/cartoons/` | Cartoonzine | `cartoons.json` |
| 🍥 Animes | `conteudo/animes/` | Cartoonzine | `animes.json` |
| 📺 Desenhos 24 Horas | `conteudo/desenhos-24h/` | Cartoonzine | `desenhos-24h.m3u` + `.json` |
| ▶️ YouToon | `conteudo/youtoon/<idioma>/` | Cartoonzine (aba YouToon do Desenhos 24H) | `youtoon/<idioma>.json` (pt-br, es, en, pt-pt) + `youtoon/idiomas.json` |
| 🎬 Filmes | `conteudo/filmes/` | Cartoonzine | `filmes.json` |
| 🧲 Filmes (torrent) | `conteudo/filmes-torrent/` | Cartoonzine (Ultra Player, torrent) | `filmes-torrent.json` |
| 🎞️ Séries | `conteudo/series/` | Cartoonzine | `series.json` |
| 📚 Bookzine | `conteudo/bookzine/` | Cartoonzine (view em construção) | `bookzine.json` + `bookzine/indice.json` |
| 📻 Rádios | `conteudo/radios/` | Rádio | `radios.json`, `radios.m3u`, `radios/pais/<pais>.m3u` |
| 📡 Canais | `conteudo/canais/<país>/` | TVzine | `canais.json`, `canais.m3u`, `canais/paises.json`, `canais/pais/<pais>.json` e `.m3u` |
| 🕹️ Jogos Retrô | `conteudo/jogos/<console>/` | Emulador | `jogos/<console>.json` (27 consoles + 2 de jogos web) |

Os `.m3u` por país também funcionam direto em qualquer player IPTV (VLC, TiviMate…).

### 🌐 Web Games (cartucho web: jogos que rodam direto no navegador)

Dois "consoles" novos dentro de Jogos Retrô, com o link da **página do jogo** (não de uma ROM):

| console | nome no app | vai para |
|---|---|---|
| `web` | Web Games · TV e PC | TV, PC e celular (jogos leves) |
| `webpc` | Web Games · Só PC | só PC: o app esconde na TV (jogos pesados, mouse/teclado) |

No app, o jogo abre no `cartucho-web.html` (core `web`) com o deck, o CZ Mouz e o Live Factory.
Campos extras (avançados) para esses consoles: **Licença** (`livre`, `autorizada`, `precisa-original`,
`nao-verificada`), Tipo do port, Controle (`gamepad` = o jogo lê o controle sozinho), Mapa controle → teclado
(`A=Space, B=KeyX, START=Enter`), Peso (`pesado` → mova para `webpc`) e Código-fonte.

**Um jogo web só é publicado com a licença conferida** (`nao-verificada` ou vazia dá erro; rascunho pode).

Importar a lista [Ultimate Catalog of Web Game Ports](https://github.com/Carter54git/Ultimate-Catalog-Of-Web-Game-Ports):

```bash
npm run webports                       # baixa o README oficial e cria os rascunhos em conteudo/jogos/web/
node tools/importar-webports.mjs --simular            # só mostra o que faria
node tools/importar-webports.mjs --console webpc      # manda para "Só PC"
node tools/importar-webports.mjs --atualizar          # completa os que já existem (links reserva, repo)
```

Cada jogo jogável (▶) vira **rascunho** com licença `nao-verificada`. Quem só tem código-fonte (📦) fica na
lista `conteudo/jogos/_webports-sem-demo.json` (o build ignora). Reimportar nunca mexe num jogo que você já
conferiu, publicou ou mudou de console. Muitos itens dessa lista são ports de jogos comerciais feitos por fãs:
publique só o que for livre, autorizado ou que peça os arquivos originais do próprio jogador.

### ▶️ YouToon (canais de desenhos do YouTube)

Cada canal é um item com o link do YouTube e o **Idioma**. Cada idioma tem a **própria lista**: o canal
fica em `conteudo/youtoon/<idioma>/` (`portugues/`, `espanhol/`, `ingles/`, `portugues-portugal/`), vira o
arquivo `dist/youtoon/<código>.json` e uma fonte no cloud (`YouToon · Português`, `YouToon · Espanhol`…).
Sem idioma = Português. Os idiomas ficam em `idiomasYouToon` no `studio.config.json`: para abrir uma lista
nova (ex.: Francês), acrescente uma linha com `nome`, `codigo` e `prefixoId` e rode `tools/ligar-cloud.mjs`.
Links aceitos:

| Link | No app |
|---|---|
| `youtube.com/channel/UC…/live` | a live 24h do canal (acompanha sozinho quando a live muda) |
| `youtube.com/channel/UC…` | os vídeos do canal sem parar, em ordem aleatória |
| `youtube.com/playlist?list=…` | a playlist sem parar |
| `youtube.com/watch?v=…` ou `/embed/…` | um vídeo (com "24H" ou "ao vivo" no nome, entra em "Ao vivo 24H") |

O ID do canal (`UC…`): no YouTube, *Mais sobre este canal → Compartilhar canal → Copiar ID do canal*.

### 🧲 Filmes (torrent)

Coleção com `"torrent": true` no `studio.config.json`. Aceita links `magnet:` e `.torrent`. Link do
Internet Archive (`archive.org/details/…`) vira o **.torrent oficial do item** (com os servidores do
archive embutidos, então baixa rápido mesmo sem ninguém compartilhando) e o vídeo direto fica de
reserva. A fonte automática *Filmes em domínio público (Internet Archive · torrent)* puxa os 60 filmes mais
baixados **lançados até 1930** (pela idade, já são domínio público; a marcação de licença feita por
quem envia ao archive não é confiável). Numa fonte `archive-busca`, `"ordem": "downloads desc"` ordena
o resultado.

### 📚 Bookzine (livraria)

Livros, bíblias antigas, gibis, revistas, mangás… em **PDF, EPUB, CBZ/CBR, MOBI, DjVu ou TXT**. Cada livro tem
título, autor, **estante** (`categoriasLivros` no `studio.config.json`: Clássicos da Literatura, Bíblias e
Textos Sagrados, Gibis e HQs, Revistas…), formato (sai sozinho pela extensão do link), idioma, coleção/série
e número (ex.: *Tex* nº 1), editora e páginas. Link do Internet Archive importa sozinho: escolhe o melhor
arquivo de leitura (PDF › EPUB › CBZ/CBR › DjVu › MOBI › TXT) e guarda outro formato de reserva, com autor,
ano, idioma e capa.

Publica `bookzine.json` e `bookzine/indice.json` (quantos livros por estante, formato e idioma). Fica **fora
do cartoonzine-cloud** até a view existir; o `_comentario` da coleção no `studio.config.json` tem a fonte
pronta para colar. Em `automatico/fontes.json` há duas fontes desligadas: clássicos em português do Projeto
Gutenberg e bíblias antigas do Internet Archive.

### Canais por país (seletor do TVzine)

`canais/paises.json` é o índice para o seletor de países: um item por país com bandeira, nome,
total de canais, idiomas, quantos canais por categoria e os links da lista daquele país:

```json
{ "codigo": "BR", "nome": "Brasil", "bandeira": "🇧🇷", "total": 120,
  "idiomas": ["Português"], "categorias": { "Notícias": 18, "Infantil": 9 },
  "json": "…/dist/canais/pais/br.json", "m3u": "…/dist/canais/pais/br.m3u" }
```

O TVzine pode abrir esse índice, mostrar os países e carregar só a lista do país escolhido
(`canais/pais/br.json`, com os canais em `channels`). Pelo cartoonzine-cloud, cada canal também chega
com `country` (`BR`), `countryName` (`Brasil`) e `language`.

### Criar uma coleção nova

Copie um bloco de `colecoes` no `studio.config.json`, troque `id`, `nome`, `icone` e o `fonteCloud`
(nome da fonte e categoria no cloud), e escolha o `tipo`:

| tipo | serve para |
|---|---|
| `video` | filmes, desenhos, séries, animes, documentários (avulso ou com temporadas) |
| `canal24h` | canais que passam um desenho/série sem parar |
| `canal` | canais de TV com país, idioma e categoria |
| `radio` | rádios com país e cidade |
| `jogo` | ROMs, separadas por console |

O painel monta o formulário sozinho. Depois rode `node tools/ligar-cloud.mjs` de novo para a fonte
nova entrar no cloud. Console novo? Adicione em `consoles` do mesmo arquivo.

---

## Modo automático

Em `automatico/fontes.json` já vêm 3 exemplos desligados (iptv-org Brasil e Portugal, desenhos
clássicos do Internet Archive). Troque `"ativo": false` para `true` e o robô puxa todo dia.

| tipo | o que puxa |
|---|---|
| `m3u` | uma lista M3U (`url`), com `padroes` (país, categoria…) e `filtro` (regex no nome/grupo) |
| `texto` | um arquivo de links (`url`), no mesmo formato da adição rápida |
| `archive` | itens do Internet Archive (`ids`) |
| `archive-busca` | uma busca do Internet Archive (`busca`, `limite`) |

Convivência com o manual: itens automáticos ganham `"_origem"`. Itens feitos à mão só **ganham**
episódios e links, nunca perdem. `"removerSumidos": true` apaga só os automáticos que saíram da fonte.
Quer congelar um item automático? Coloque `"_travado": true` nele.

---

## Estrutura

```
studio.config.json      coleções, consoles, categorias, onde publicar
core/studio-core.js     o cérebro (o mesmo arquivo roda no painel e no Node)
painel/                 painel web
tools/                  build, add, importar, sincronizar, verificar-links, ligar-cloud, painel
conteudo/               seus itens (um .json cada)
automatico/fontes.json  fontes do modo automático
dist/                   gerado pelo robô; não edite à mão
exemplos/               modelos de arquivo
test/                   testes (node --test test/*.test.mjs)
```

## Dúvidas rápidas

- **Salvei e não apareceu no app.** Veja a aba *Actions* do repositório (o robô leva 1–2 min) e depois
  o robô do cartoonzine-cloud, que reconstrói o catálogo a cada 6 h ou pelo botão *Run workflow* de lá.
- **Um item não foi publicado.** Ele tem erro: está em `dist/relatorio.json` com o motivo.
- **Links do @CZStreamBot** dependem do bot estar no ar no Render. Se o bot cair, o link para de
  funcionar. Para conteúdo fixo, prefira links permanentes (archive.org, seu servidor).
- **TMDB achou a obra errada.** Cole o link certo do TMDB ou IMDb no campo do item e clique em
  **✨ Preencher automaticamente** de novo. Para refazer do zero, apague a sinopse e as capas antes.
- **Episódios com link reserva**: o cloud de hoje usa só o 1º link de cada episódio; os outros ficam
  guardados em `reservas` para quando o player suportar.
