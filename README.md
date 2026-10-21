# Astra Instagram

Estúdio local para preparar mídia, gerar conteúdo com IA, revisar e **publicar
agora ou agendar** no Instagram. Interface em HTML/CSS/JavaScript e backend em
Node.js, sem dependências de execução.

## Escopo

O projeto cobre Instagram, IA, upload de mídia, geração de conteúdo, revisão,
publicação imediata e agendamento. A publicação imediata também permite uma
Página do Facebook como destino opcional. Meta Ads e impulsionamento não fazem
parte do fluxo. A agenda de período também permite Facebook Page como destino independente.

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
Variáveis: `MEDIA_UPLOAD_URL`, `MEDIA_UPLOAD_KEY`, `MEDIA_PUBLIC_BASE_URL`,
`MEDIA_PUBLIC_VERIFY_TIMEOUT_MS`.

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
MEDIA_UPLOAD_URL, MEDIA_UPLOAD_KEY, MEDIA_PUBLIC_BASE_URL, MEDIA_PUBLIC_VERIFY_TIMEOUT_MS
```

Timezone padrão: `Asia/Tokyo`. Tokens e chaves nunca são retornados pelo servidor.

## Testes

```powershell
npm test
npm run test:ui   # servidor simulado, sem .env e sem chamadas externas
```

Consulte [docs/MODELOS-ASTRA.md](docs/MODELOS-ASTRA.md) para a seleção de modelos.
