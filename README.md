# Astra Instagram

Estúdio local para preparar mídia, gerar conteúdo com IA, revisar e **publicar
agora ou agendar** no Instagram. Interface em HTML/CSS/JavaScript e backend em
Node.js, sem dependências de execução.

## Escopo

O projeto cobre Instagram, IA, upload de mídia, geração de conteúdo, revisão,
publicação imediata e agendamento. A publicação imediata também permite uma
Página do Facebook como destino opcional. Meta Ads e impulsionamento não fazem
parte do fluxo. A agenda de período também permite Facebook Page como destino independente.

## Release 1.2.1: destinos e histórico

### Prazo e cancelamento na 1.2.3

- Data do evento no dia 7 implica último dia de divulgação no dia 6 (até o fim do dia, no fuso de cada item). Se o limite do conteúdo ou o campo **Prazo máximo do agendamento** for menor, prevalece o menor. A data do evento não é inferida de registros antigos; revise-os explicitamente.
- Planos novos exigem prazo máximo no painel. A prévia não gera horários posteriores e a execução não ultrapassa o limite, nem pelo botão Executar plano. Pendências vencidas são canceladas no próximo ciclo, inclusive pausadas. Resultados incertos continuam preservados para conferência, sem reenvio.
- Agendamentos oferece Cancelar plano, Cancelar vencidos, Excluir plano e Excluir agendamento. Exclusão é lógica: oculta da lista, mantém registros em disco e recibos no histórico e bloqueia restauração acidental por cache. Não apaga arquivos nem posts nas redes. Não há desfazer pelo painel; gere um novo plano revisado se necessário.
- Editar/reagendar permite informar o prazo máximo do item e recusa data posterior ao limite do evento. Gerar agendamento cria um ID novo, sem reativar planos cancelados.

Validação desta revisão: 235 testes automatizados passaram, sem chamadas reais de publicação. A configuração de produção e os planos existentes não foram alterados por migração manual.

### Proteções adicionadas na 1.2.2

No Editor, classifique o conteúdo como atemporal ou evento com último dia permitido e confirme a revisão das datas na arte e no texto. Alterar texto ou mídia invalida a revisão para novos agendamentos. Não há OCR automático: conteúdo sem revisão fica bloqueado, inclusive em planos antigos. A validade usa o fuso do plano e inclui o último dia informado. Gere um novo plano após revisar; variar a legenda não estende a validade.

O agendador confere a validade na seleção, na data planejada e antes de enviar. Para Reels Instagram, a duração deve ser medida no botão do Editor e estar entre 3 e 900 segundos; envios imediatos também verificam esse requisito. A medição é feita pelo navegador na URL pública, não por inspeção do arquivo no servidor; substituir o conteúdo na mesma URL exige nova medição e revisão. A regra não define intervalo mínimo entre postagens. Referência: https://www.postman.com/meta/instagram/folder/830j7my/reels-publishing

O erro original de “tempo mínimo” não foi encontrado nos logs locais e não foi atribuído a uma causa presumida. Nenhuma publicação real foi usada para validar estas proteções.

- A agenda oferece Instagram Feed, Instagram Story, Facebook Page e Facebook Story separadamente. Escolher Facebook em **Publicar agora** não seleciona Facebook na agenda. Gere a prévia e confirme as redes explicitamente.
- Planos antigos mantêm os destinos aprovados. Para incluir outra rede, crie e revise um novo plano com horários futuros; nada é republicado automaticamente.
- **Agendamentos** mostra destinos e resultados separados. **Histórico de publicações** reúne recibos locais e permite consultar o link canônico na Meta, sem publicar. Stories podem expirar ou não fornecer link; não são inventadas URLs.
- Sem configuração válida, o botão Meta conduz aos campos pendentes. OAuth real ainda exige aplicativo Meta configurado, callback correspondente e permissões da Página. Segredos não acompanham o release.
- Mantenha o Astra e o computador ligados para executar horários futuros. Itens vencidos exigem ação explícita.

Validação local desta revisão: 220 testes automatizados passaram; o pacote foi verificado em porta efêmera com `/health`, painel e histórico vazio, sem credenciais reais. Login Meta, publicação real e inspeção visual no navegador não foram validados nesta revisão.

## Requisitos e execução

- Node.js 24 ou posterior.
- Navegador moderno com IndexedDB.
- `.env` local com as credenciais do backend (criado no primeiro `npm start`, nunca versionado).

```powershell
npm start     # bridge + painel em http://localhost:8080/painel/
npm test      # suíte automatizada (provedores fictícios)
npm run build:windows # pacote Astra.exe para Windows x64
```

Na primeira execução, `npm start` cria `.env` a partir do modelo sem segredos
em `.env.example`. O arquivo existente nunca é substituído; preencha as
credenciais somente no `.env` local.

O pacote Windows inclui o executável de inicialização, o runtime Node.js e os
arquivos necessários do Astra. Na primeira execução, `Astra.exe` cria `.env`
local a partir do modelo; credenciais e dados locais não entram no ZIP.

O painel também pode ser servido isoladamente com `npm run painel`
(`http://127.0.0.1:4317`), acessando o bridge em `http://127.0.0.1:8080`.

## Fluxo

```text
Mídia → Informações → IA → Revisão → Publicar agora OU Agendar
```

1. **Editor**: selecione imagens/vídeos (com progresso por arquivo), informe tema,
   fatos, objetivo e informações adicionais, peça análise de mídia e gere a
   legenda com a Astra (ou escreva manualmente).
2. **Revisão**: confira a prévia, resolva o checklist e confirme o conteúdo.
   Confirmar não publica.
3. **Publicar agora**: confirme a conta, a mídia e a legenda no diálogo.
4. **Agendar**: escolha data, hora e timezone IANA e adicione à agenda.

## IA

A IA usa o OpenRouter com o modelo configurável por `OPENROUTER_MODEL`
(padrão `z-ai/glm-5.3-flash`). A integração fica isolada no AIService. A IA
apenas prepara conteúdo: falha da IA não impede escrever manualmente nem
publicar/agendar.

## Mídia e URL pública

A API do Instagram precisa de uma URL HTTPS pública. O MediaService envia a
imagem ao storage configurado e valida a URL. Caminhos locais são recusados.
Variáveis: `MEDIA_UPLOAD_URL`, `MEDIA_INVENTORY_URL`, `MEDIA_UPLOAD_KEY`, `MEDIA_PUBLIC_BASE_URL`,
`MEDIA_PUBLIC_VERIFY_TIMEOUT_MS`.

O botão **Sincronizar mídias** consulta um inventário autenticado pelo backend,
percorre todas as páginas e mescla as URLs sem apagar nomes ou outros metadados
já salvos. A base histórica continua sendo
`https://quimbanda.jp/astra/media/public/`. O arquivo opcional
`inventario-midias.php` é fornecido para hospedagens sem endpoint de listagem;
ele não é instalado automaticamente. No servidor, configure `ASTRA_MEDIA_KEY`,
`ASTRA_MEDIA_DIR` e `ASTRA_MEDIA_PUBLIC_BASE`, publique o arquivo ao lado do
fluxo de upload e informe sua URL HTTPS em `MEDIA_INVENTORY_URL`. A pasta lida
fica restrita a `ASTRA_MEDIA_DIR`; a chave permanece somente no backend.

## Agendamentos

A página **Agendamentos** lista, cria, edita, pausa e cancela. A execução usa o
mesmo serviço de publicação imediata de cada destino (Instagram ou Facebook). Os planos são
persistidos em `dados/agendamentos.json` e sobrevivem a reinícios; resultados
incertos são reconciliados antes de qualquer reenvio, e a política de atraso
evita publicar em massa o que venceu com o servidor desligado.

## Diagnóstico

Em **Configurações → Diagnóstico** é possível iniciar uma sessão de 48 horas,
acompanhar expiração e tamanho, marcar um problema, encerrar e baixar um `.log`
sanitizado em JSON Lines. Reiniciar o servidor não renova o prazo. Nenhum token,
cookie, mídia em base64 ou corpo completo é registrado.

## Configuração

Em **Configurações → Integrações Meta e OpenRouter**, configure o aplicativo e use
o assistente **Conectar com Facebook**. Credenciais manuais continuam na área avançada.
Consulte [Conexão Meta](docs/CONEXAO-META.md) para requisitos e limitações.
Cada campo possui um link oficial de apoio, aberto em nova aba sem enviar os valores.
IDs são visíveis; tokens e a chave OpenRouter ficam mascarados e nunca são retornados
pelo backend. Deixar um segredo vazio mantém o valor existente. O App ID é cadastral;
não substitui o token nem concede permissões na Meta.

O painel salva sobreposições em `dados/integracoes.json` (ou no caminho indicado por
`ASTRA_INTEGRACOES_ARQUIVO`), preservando o `.env`. Esse arquivo privado usa
AES-256-GCM, com chave protegida pelo usuário Windows via DPAPI:
não o compartilhe, publique ou inclua em backups públicos. A pasta `dados/` é ignorada
pelo Git e não é servida por HTTP. Os valores salvos prevalecem sobre o `.env` nos
próximos inícios; clientes são atualizados imediatamente ao salvar.

Para publicação imediata, selecione Instagram, Facebook ou ambos; teste os destinos
e confirme o envio no diálogo. Facebook exige `FACEBOOK_PAGE_ID` e um token próprio
de Página (`FACEBOOK_PAGE_ACCESS_TOKEN`). Suporta foto, conjunto de 2 a 10 fotos e
vídeo da Página (não criação de Facebook Reel). Falhas sem confirmação não são
reenviadas automaticamente; confira a Página. O assistente solicita consentimento
na Meta; revogação é uma ação separada com confirmação. A configuração por si só
não comprova que o token possui autorização de publicação.

Stories usam a conta de Instagram configurada para consultar o tipo Business e
preservam o tipo vídeo no envio direto. Story adicional de carrossel é recusado
antes de publicar o Feed. A confirmação real depende da conta e da resposta Meta.

Rotas: `GET/POST /config/integracoes`, `GET /facebook/me`. A rota existente
`POST /instagram/publish` aceita `publicarInstagram` (padrão `true`) e
`publicarFacebook` (padrão `false`), com resultados separados por destino.

```text
INSTAGRAM_ACCESS_TOKEN, INSTAGRAM_ACCOUNT_ID
META_APP_ID, FACEBOOK_PAGE_ID, FACEBOOK_PAGE_ACCESS_TOKEN
OPENROUTER_API_KEY, OPENROUTER_MODEL (ou ASTRA_MODEL)
PORT, META_GRAPH_BASE_URL, META_GRAPH_VERSION
MEDIA_UPLOAD_URL, MEDIA_INVENTORY_URL, MEDIA_UPLOAD_KEY, MEDIA_PUBLIC_BASE_URL, MEDIA_PUBLIC_VERIFY_TIMEOUT_MS
```

Timezone padrão: `Asia/Tokyo`. Tokens e chaves não são retornados em texto aberto; o backup autorizado contém apenas um envelope criptografado.

## Testes

```powershell
npm test
npm run test:ui   # servidor simulado, sem .env e sem chamadas externas
```

Consulte [docs/MODELOS-ASTRA.md](docs/MODELOS-ASTRA.md) para a seleção de modelos.

## Backup portátil das integrações

Em Configurações, use **Exportar configurações** com uma senha de pelo menos 12 caracteres. O arquivo `.astra-backup` usa AES-256-GCM e chave derivada por scrypt; guarde a senha separadamente. Não há recuperação de senha.

Use **Importar configurações** na instalação de destino, selecione o arquivo e informe a mesma senha. A importação atualiza as integrações presentes no arquivo; campos ausentes são preservados. Confira as conexões antes de publicar. Sessões OAuth não são transferidas e a Meta pode exigir nova autorização.

Inclui os campos das integrações Meta, Instagram, Facebook e chave da IA. Não inclui o `.env` inteiro, configurações de upload de mídia, projetos, arquivos de mídia, agendamentos ou histórico. Arquivos `.astra-backup`, `.env` e dados locais ficam fora do Git. Nenhum backup real é criado pelos testes.
