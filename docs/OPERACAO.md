# Operação do fork com SRT

Repositório: https://github.com/kenfabioh/stremio-gdrive-addon

## Estado e arquitetura

O Worker faz OAuth Google com refresh token, pesquisa arquivos via Drive v3 (incluindo shared drives), resolve metadados via Cinemeta/IMDb/Kitsu e opcionalmente TMDB, e retorna catálogos e streams Stremio. O vídeo passa pelo Worker como ReadableStream; não é carregado integralmente na memória nem baixado para procurar legendas. Continuam disponíveis os filtros de qualidade/resolução, busca, episódios, pastas e metadados originais.

A versão com SRT usa Node 24, Wrangler fixado no lockfile e a data de compatibilidade de Workers em `wrangler.toml`. `npm run check` executa testes e compilação dry-run, sem publicar. Há testes com Google simulado em Node e no runtime workerd. Isso não valida uma conta Google real, um deploy público, a rede do usuário ou um Android TV.

O `stream.subtitles` contém as legendas da versão exata selecionada. O manifesto também anuncia o recurso `subtitles`, com resposta `{ subtitles: [{ id, url, lang, label }] }`. Para IDs `gdrive:` a associação usa o ID do vídeo; para IMDb/Kitsu o handler usa `filename` e, quando fornecido, `videoSize`. Se o nome for ambíguo entre dois vídeos, o handler retorna vazio em vez de misturar pastas; as legendas anexadas ao stream continuam sendo específicas do arquivo.

Fontes do protocolo:
- https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/responses/stream.md
- https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/responses/subtitles.md
- https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/requests/defineSubtitlesHandler.md

## Credenciais e acesso

Não coloque credenciais no código, em issues, PRs ou mensagens. Nunca envie tokens no chat. Segredos de execução ficam como **Worker Secrets** no Cloudflare; segredos de deploy ficam no ambiente seguro Codex ou no provedor de CI.

| Nome | Tipo e finalidade |
| --- | --- |
| `CLIENT_ID` | Worker Secret: cliente OAuth Google |
| `CLIENT_SECRET` | Worker Secret: segredo OAuth Google |
| `REFRESH_TOKEN` | Worker Secret: autorização de leitura Google com acesso offline |
| `ADDON_TOKEN` | Worker Secret: chave aleatória base64url/hex com pelo menos 32 caracteres; protege todas as rotas |
| `DRIVE_FOLDER_IDS` | Worker variável: IDs das pastas principais separados por vírgula. Inclui subpastas automaticamente. Opcional, mas recomendado |
| `DRIVE_RECURSIVE` | Worker variável opcional: `false` desativa a recursão; o padrão é incluir subpastas |
| `TMDB_API_KEY` | Worker Secret opcional |
| `CLOUDFLARE_API_TOKEN` | Apenas deploy: token com Account / Workers Scripts / Edit para a conta específica |
| `CLOUDFLARE_ACCOUNT_ID` | Apenas deploy: ID da conta Cloudflare |

O proxy de segredos Codex pode fornecer placeholders para chamadas HTTPS. Não copie placeholders para `.dev.vars` ou para Worker Secrets: configure os valores reais diretamente no painel seguro Cloudflare. Variáveis de shell não viram automaticamente bindings do Worker.

No Google Cloud, habilite a Drive API, configure o consentimento OAuth e um cliente OAuth. Use o escopo **`https://www.googleapis.com/auth/drive.readonly`**, acesso offline e consentimento explícito para obter um refresh token. `drive.file` não permite pesquisar todos os vídeos preexistentes. Prefira uma conta Google dedicada, com acesso somente às pastas de mídia. A restrição `DRIVE_FOLDER_IDS` é uma proteção no aplicativo, não uma redução do escopo OAuth da conta. Faça o fluxo OAuth em ferramenta confiável sob seu controle; não forneça client secret a sites de terceiros. Aplicações externas em modo Testing podem gerar refresh tokens que expiram após sete dias; consulte as políticas de OAuth do Google antes de definir o modo de publicação.

No Cloudflare, configure os segredos do Worker em Settings / Variables and Secrets. Não os declare como texto em `wrangler.toml`. O Codex pode criar o Worker após autenticação; antes de qualquer deploy deve verificar que o nome `stremio-gdrive` está livre, como informado pelo proprietário. Se houver colisão, pare para preservar o addon antigo. Não habilite planos pagos ou recursos com custo sem aprovação.

## Instalação local

```sh
npm ci
npm run check
npm run dev -- --local
```

Para desenvolvimento autenticado, use `.dev.vars` (ignorado pelo Git), com as mesmas chaves de execução da tabela. Não sobrescreva um arquivo existente. Gere `ADDON_TOKEN` por um gerenciador de senhas ou fonte criptográfica e armazene diretamente no campo seguro. Os testes usam somente credenciais fictícias, sem depender de `.dev.vars` ou serviços externos. Sem uma chave válida o Worker falha fechado com HTTP 503.

## Convenção das legendas

Na mesma pasta do Drive:

```text
Avatar.2009.mkv
Avatar.2009.srt
Avatar.2009.pt-BR.srt
Avatar.2009.pt.srt
Avatar.2009.en.srt
Avatar.2009.en.sdh.srt
```

O nome antes da extensão do vídeo deve ser o mesmo prefixo da legenda. A comparação ignora maiúsculas/minúsculas e normaliza Unicode NFC, mas não mistura releases, cortes ou episódios diferentes. Idioma ausente usa `und`; português usa `por`, inglês `eng`, francês `fre` e demais códigos ISO 639-2/B suportados estão em `src/subtitles.js`. O nome completo no `label` preserva `pt-BR`, SDH e forced. Mantenha os SRT preferencialmente em UTF-8; os bytes originais são servidos sem conversão, para preservar conteúdo, e a interpretação de outros encodings depende do player.

A busca inclui as pastas configuradas em `DRIVE_FOLDER_IDS` **e suas subpastas**, por padrão. Basta configurar a pasta principal, por exemplo `Séries`, para incluir `Séries/Nome da Série/Temporada 01`. Catálogo, busca, streams, metadados e acesso direto a vídeos/SRT seguem a mesma árvore autorizada. As legendas continuam sendo procuradas somente na pasta exata do vídeo, não nas pastas vizinhas. Para voltar ao filtro direto, configure `DRIVE_RECURSIVE=false`. Pastas compartilhadas funcionam se a conta OAuth tiver permissão; atalhos do Drive não são seguidos. Para vídeos sem legendas, ou quando a API de legendas estiver indisponível, `subtitles` é uma lista vazia e o stream continua disponível.

A árvore de subpastas é descoberta em lotes de 50 pais por consulta e fica em cache por cinco minutos. A descoberta é limitada a 1.000 pastas e 24 requisições por varredura para conter uso de CPU/subrequests no Workers Free; árvores que excedem os limites, retornam erro ou têm busca incompleta são recusadas, sem ampliar o acesso para fora das raízes. Novas pastas podem levar até cinco minutos para aparecer em instâncias já ativas. Consultas de vídeos usam lotes para evitar URLs muito grandes, com deduplicação e ordenação global do catálogo por última modificação.

A listagem de SRT é paginada e fica em cache por cinco minutos por pasta, com até 32 pastas e 2.000 registros por pasta. Metadados para acesso a arquivos ficam em cache por um minuto, até 200 arquivos. O access token é reutilizado até pouco antes de expirar, com deduplicação de renovações simultâneas. São caches em memória por instância, não globais/duráveis: podem ser descartados a qualquer momento. Mudanças de nomes/permissões podem levar até esses prazos para aparecer. Em bibliotecas muito grandes, limites de subrequests/CPU do plano Workers podem impedir consultas completas; limite as pastas. O catálogo mantém o limite original de 1.000 vídeos. Usa `modifiedTime desc`, conforme a recomendação da API Drive para coleções grandes; `createdTime` pode causar timeouts nessas coleções. Falhas na consulta retornam HTTP 502, em vez de um catálogo vazio enganoso.

## Primeiro deploy e instalação no Stremio

Após testar, autenticar e confirmar que o nome está livre:

```sh
npm run check
npm run deploy
```

Guarde a URL `https://stremio-gdrive.<subdominio-da-conta>.workers.dev` retornada pelo deploy. Este é apenas um formato: não é uma URL publicada/verificada nesta entrega.

A instalação é a URL HTTPS `<URL_DO_WORKER>/<ADDON_TOKEN>/manifest.json` adicionada manualmente ao Stremio. Também pode ser aberta com o protocolo `stremio://` substituindo `https://` quando suportado pelo dispositivo. Configure os Worker Secrets antes da validação pública. A raiz sem a chave retorna 404; isso é intencional. Não publique o link completo de instalação em GitHub ou chat: ele é uma credencial de acesso à sua biblioteca.

Quem possui a URL do addon pode acessar os vídeos/SRT das pastas autorizadas. Isso é autenticação por chave de instalação, não identidade individual por usuário. Trocar `ADDON_TOKEN` revoga instalações e URLs antigas. Os IDs de arquivos são validados, os tipos são restritos a mídia/SRT e `DRIVE_FOLDER_IDS` também vale para acesso direto por ID. CORS permite os clientes Stremio; não substitui autenticação. Os logs de observabilidade estão desabilitados para evitar registrar URLs com a chave. Cloudflare ainda processa os dados/URLs do tráfego; proteja logs de suporte, ferramentas de monitoramento e capturas de tela.

O proxy preserva Content-Type, Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified e status 200/206/304/416. HEAD não devolve corpo. Range/If-Range são encaminhados sem calcular ou ler bytes do vídeo. Redirecionamentos de download são limitados a HTTPS em domínios Google, sem encaminhar o token OAuth.

## Publicação automática: preferir Workers Builds

No Worker novo: Settings / Builds / Connect, autorize o app oficial Cloudflare no **fork** `kenfabioh/stremio-gdrive-addon`, selecionando apenas esse repositório.

- Branch de produção: `main`.
- Diretório raiz: `/`.
- Build command: `npm run check` (a instalação deve respeitar `package-lock.json`, usando `npm ci`).
- Deploy command: `npm run deploy`.
- Runtime de build: Node 24.
- Desabilite builds/deploys de branches não produtivas. Não configure rotas/domínios de um addon antigo.
- Deixe `DEPLOY_WITH_ACTIONS` ausente/false para evitar duas publicações do mesmo commit.
- Secrets do Google pertencem ao runtime do Worker; não são necessários no build.

A instalação do app GitHub e a escolha da conta requerem autorização do proprietário. Os arquivos do repositório não configuram essa conexão sozinhos.

Fallback pronto em `.github/workflows/deploy.yml`: configure o secret `CLOUDFLARE_API_TOKEN`, a variável `CLOUDFLARE_ACCOUNT_ID`, e a variável `DEPLOY_WITH_ACTIONS=true` no GitHub. O job usa o environment `production`; configure restrições de branches/aprovações ali se desejar. Ele só publica `refs/heads/main`, inclusive na execução manual, e roda testes + bundle antes de publicar. Não habilite simultaneamente com Workers Builds. Valide a disponibilidade de minutos de CI/plano antes de ativar recursos pagos.

`.github/workflows/validate.yml` valida PRs e a main sem credenciais de produção. Configure a proteção da main para exigir o check `check`, quando as permissões do GitHub estiverem disponíveis.

## Atualizações e verificação no Android TV

Crie branch no fork, altere código, rode `npm ci` / `npm run check`, abra PR e faça merge após revisão. O mecanismo de deploy escolhido publica somente a main. Atualizações normais de código preservam os Worker Secrets; rotação de segredos é um procedimento separado.

Após o primeiro deploy real, conferir com a chave mantida fora dos logs:

1. Manifesto autenticado 200 com `stream`, `catalog`, `meta`, `subtitles`; sem chave, 404.
2. Catálogo lista um vídeo real e stream retorna URL protegida e idiomas esperados.
3. URL SRT retorna arquivo esperado; GET Range do vídeo retorna 206 com Content-Range correto; Range inválido retorna 416 quando suportado pelo Drive.
4. No Android TV/Google TV, instalar o manifesto, reproduzir um arquivo grande, avançar/retroceder, selecionar SRT pt-BR/en e verificar acentos/sincronia.
5. Repetir com vídeo sem SRT, episódio e pasta compartilhada.
6. Confirmar que o addon antigo permanece intacto.

Não marcar reprodução Android TV como validada sem esse teste real. Não presumir que um teste mock substitui autorização OAuth real, quotas do Drive, desempenho da rede ou limitações do player. Se houver limite do plano Workers ou restrições de streaming de vídeo no serviço, não habilitar cobrança automaticamente; revisar a arquitetura/plano com o proprietário.
