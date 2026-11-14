# Site público para o OAuth Google

As páginas estáticas ficam em `site/` e são publicadas no Cloudflare Pages, separadas do Worker privado do addon.

Endereços desejados:

- Página inicial: `https://stremio.kenoshy.top/`
- Política de privacidade: `https://stremio.kenoshy.top/privacy/`
- Domínio autorizado no Google: `kenoshy.top`
- Contato público: `kenfabio@kenoshy.top`

O nome do aplicativo apresentado nas páginas é **Stremio GDrive** e deve coincidir com o nome mostrado na tela de consentimento Google.

## Hospedagem e atualização

No Cloudflare Pages, conectar o fork `kenfabioh/stremio-gdrive-addon`:

- Branch de produção: `main`.
- Framework: nenhum (HTML estático).
- Comando de build: vazio.
- Diretório raiz do repositório: `/`.
- Diretório de saída: `site`.
- Builds de preview: desativados.
- Nenhum Secret Google deve ser configurado no Pages.

As páginas não contêm JavaScript de coleta, analytics, formulários, chaves privadas ou URLs de instalação do addon. Os cabeçalhos do site são definidos em `site/_headers`. Antes de publicar mudanças na política, conferir se o texto corresponde ao comportamento real do aplicativo e ao contato escolhido pelo responsável.

Atualizações são feitas por PR neste fork. O projeto Pages deve observar `site/**` para publicar o site quando essas páginas mudarem. O Worker continua usando sua integração Workers Builds.

## NameSilo e Google Workspace

O domínio pode permanecer registrado no NameSilo. Para o subdomínio do Pages, não é necessário transferir o registro do domínio nem migrar os nameservers.

1. Primeiro, adicionar `stremio.kenoshy.top` aos domínios personalizados do projeto Pages.
2. No provedor que efetivamente gerencia o DNS, adicionar um registro **CNAME** com host `stremio` apontando para o hostname `*.pages.dev` retornado pelo projeto. Não adivinhar o hostname antes da criação do projeto.
3. Aguardar o Cloudflare confirmar o domínio e emitir o certificado HTTPS.

Preservar os registros existentes de e-mail e verificação do Google Workspace: MX, SPF, DKIM, DMARC e TXT. Não alterar os nameservers ou substituir registros de outros serviços para concluir esta configuração. Se já houver um registro no host `stremio`, investigar antes de substituí-lo.

## Google OAuth

Com os dois endereços HTTPS públicos funcionando:

1. Selecionar o projeto Google do CLIENT_ID usado pela instância.
2. Em Plataforma de autenticação do Google / Branding ou Identidade visual, preencher a página inicial e a política com os endereços acima, o contato e o nome do aplicativo.
3. Adicionar `kenoshy.top` aos domínios autorizados.
4. Se solicitado, comprovar a propriedade do domínio pelo Google Search Console. Um novo TXT de verificação deve ser adicionado sem substituir os TXT existentes do Workspace.
5. Em Público-alvo, solicitar a publicação do aplicativo. A verificação pública de escopos e o status de produção são processos distintos; hospedar estas páginas não garante aprovação do Google.
6. Após sair do modo de teste, gerar um novo refresh token e atualizar apenas o Worker Secret REFRESH_TOKEN, se o cliente OAuth continuar sendo o mesmo. Nunca inserir valores de credenciais neste site ou no GitHub.

A chave de instalação e a biblioteca continuam no Worker. Associar o site ao domínio não publica seus vídeos nem altera automaticamente as credenciais ou o status OAuth.
