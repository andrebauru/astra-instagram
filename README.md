# Astra Instagram

Estúdio local para preparar mídia, gerar conteúdo com IA, revisar e **publicar
agora ou agendar** no Instagram. Interface em HTML/CSS/JavaScript e backend em
Node.js, sem dependências de execução.

## Escopo

O projeto cobre apenas: Instagram, IA, upload de mídia, geração de conteúdo,
revisão, publicação imediata e agendamento. Facebook, Meta Ads e todo o
impulsionamento foram removidos. Veja [ARQUITETURA-ASTRA-INSTAGRAM.md](ARQUITETURA-ASTRA-INSTAGRAM.md).

## Requisitos e execução

- Node.js 24 ou posterior.
- Navegador moderno com IndexedDB.
- `.env` local com as credenciais do backend (nunca versionado).

```powershell
npm start     # bridge + painel em http://localhost:8080/painel/
npm test      # suíte automatizada (provedores fictícios)
```

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
mesmo `InstagramService.publish()` da publicação imediata. Os planos são
persistidos em `dados/agendamentos.json` e sobrevivem a reinícios; resultados
incertos são reconciliados antes de qualquer reenvio, e a política de atraso
evita publicar em massa o que venceu com o servidor desligado.

## Diagnóstico

Em **Configurações → Diagnóstico** é possível iniciar uma sessão de 48 horas,
acompanhar expiração e tamanho, marcar um problema, encerrar e baixar um `.log`
sanitizado em JSON Lines. Reiniciar o servidor não renova o prazo. Nenhum token,
cookie, mídia em base64 ou corpo completo é registrado.

## Configuração

```text
INSTAGRAM_ACCESS_TOKEN, INSTAGRAM_ACCOUNT_ID
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
