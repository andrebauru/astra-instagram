# Arquitetura — Astra Instagram

Documento oficial da arquitetura atual do projeto. Descreve o fluxo, os serviços,
as responsabilidades e a persistência. Código e documentação devem permanecer
coerentes.

## 1. Escopo

O Astra Instagram possui apenas estes blocos:

```text
Instagram · IA · Upload de mídia · Geração de conteúdo · Revisão ·
Publicação imediata · Agendamento
```

Facebook, Meta Ads, campanhas, conjuntos, anúncios, orçamento, posicionamentos,
impulsionamento e sincronização de publicações existentes **foram removidos do
código**. Se publicidade paga voltar, deve ser um módulo separado.

## 2. Fluxo principal

```text
Mídia → Informações → IA → Revisão → Publicar agora OU Agendar
```

A IA prepara o conteúdo; a aplicação executa. Nenhuma publicação ocorre porque a
IA terminou de gerar texto. Se a IA falhar, o usuário continua podendo escrever
manualmente e publicar/agendar quando a mídia tiver URL pública.

## 3. Visão de serviços

```text
                 ┌───────────────┐
                 │      UI       │  painel.js · agendamentos.js
                 └───────┬───────┘
        ┌────────────┬───┴────────┬─────────────┐
   AIService    MediaService  SchedulerService  │
        │            │            │             │
        └────────────┴─────┬──────┘             │
                           ▼                    │
                  InstagramService ◄────────────┘
                           │
                           ▼
                    Instagram API
```

Regra: **uma ação = um caminho**. Publicação imediata e agendamento usam a mesma
função `InstagramService.publish()`.

## 4. Serviços (backend)

### `services/config.js`
Fonte única de configuração: porta, credenciais do Instagram, IA, mídia,
timezone padrão (`Asia/Tokyo`), modelo padrão (`z-ai/glm-5.3-flash`, configurável
por `OPENROUTER_MODEL`) e caminhos de persistência. Nunca revela segredos.

### `services/ai-service.js` — AIService
Responsável por modelo, endpoint, prompt, timeout, tratamento de erro e
resposta. Usa o catálogo real do OpenRouter e valida o modelo escolhido. Não
controla publicação, agendamento, autenticação ou persistência.

### `services/media-service.js` — MediaService
Recebe arquivo, valida tipo/tamanho/integridade, armazena no storage configurado,
gera/valida URL HTTPS pública e retorna metadados. Reutiliza `midia-publica.js` e
`rede-publica.js`. O InstagramService não armazena arquivos.

### `services/instagram-service.js` — InstagramService
Única camada que fala com a API do Instagram. Expõe `perfil()` e
`publish({ formato, ... })` para imagem, Reel e carrossel (preparado para Story).
Cria containers, aguarda processamento de vídeo, publica e traduz erros reais da
Meta. Nunca armazena mídia nem decide agendamento.

### `services/scheduler-service.js` — SchedulerService
Cuida de data, hora, timezone IANA, persistência do agendamento, execução no
momento correto, status e cancelamento. No horário, chama
`InstagramService.publish()` (via `publicarItemNoInstagram`). Não duplica a
lógica da Meta. Recursos: trava de concorrência, retomada após reinício,
deduplicação, resultados por destino, reconciliação de resultado incerto antes de
reenviar e política explícita de atraso com limite por ciclo.

### `services/empresa-store.js` — Store de configuração
Persiste o template fixo e a agenda padrão da empresa em arquivo fora de
diretório público.

### `server.js` — Router HTTP
Fino por design: valida origem, corpo e sessão de diagnóstico e delega aos
serviços. Correlaciona operações com `requestId`/`operationId` via
`AsyncLocalStorage`.

## 5. Rotas

```text
GET  /                         mapa de endpoints
GET  /health                   capacidades, build, timezone, modelo
GET  /meta/me                  perfil do Instagram
POST /instagram/publish        publicação única (imagem | reel | carrossel)
GET  /media/upload/capabilities
POST /media/upload             upload e URL pública
GET  /astra/models             catálogo de modelos
POST /astra/generate           geração de conteúdo/visão
GET  /agenda/planos            lista planos persistidos
POST /agenda/planos            sincroniza planos (rascunho/aprovado)
POST /agenda/executar          executa o ciclo do agendador
POST /agenda/pausar            pausa plano
POST /agenda/retomar           retoma plano
POST /agenda/reagendar         reabilita item com falha (sem reenvio automático)
POST /agenda/cancelar          cancela item ainda não iniciado
GET  /empresa/config           template fixo + agenda padrão
POST /empresa/template         salva template fixo
POST /empresa/agenda           salva agenda padrão
GET/POST /diagnostico/*        sessão, eventos, marcação e exportação
```

Rotas removidas (não existem mais): `/meta/ads-*`, `/instagram/metrics`,
`/publicacoes/*`, `/astra/repost-rewrite`, `/webhook`,
`/instagram/publish/{image,reel,carousel}` (consolidadas em `/instagram/publish`).

## 6. Frontend

```text
index.html                três views: Editor · Agendamentos · Configurações
painel.js                 editor principal (Mídia→Informações→IA→Revisão→Ações)
agendamentos.js           página exclusiva de agendamentos + planejar semana
regras.js                 regras editoriais (composição, instantes, validação)
publicacoes.js            modelo do conteúdo + migração idempotente
planejamento-semanal.js   regras puras do planejamento semanal
empresa.js                template/agenda da empresa (regras)
integracao-regras.js      validação de URL pública + cliente do bridge
diagnostico.js            painel de diagnóstico
```

A UI coordena o usuário e chama os serviços via `integracao-regras.js`.

## 7. Persistência

| Dado | Fonte de verdade |
| --- | --- |
| Conteúdos e biblioteca de mídia | IndexedDB do navegador |
| Agendamentos e execução | `dados/agendamentos.json` (servidor) |
| Template/agenda da empresa | `dados/empresa.json` (servidor) |
| Diagnóstico | `logs/astra-debug-YYYY-MM-DD.log` |
| Credenciais | `.env` (nunca no frontend) |

## 8. Configuração

Variáveis do `.env` (não alteradas pela refatoração):

```text
INSTAGRAM_ACCESS_TOKEN, INSTAGRAM_ACCOUNT_ID
OPENROUTER_API_KEY, OPENROUTER_MODEL (ou ASTRA_MODEL)
PORT, META_GRAPH_BASE_URL, META_GRAPH_VERSION
MEDIA_UPLOAD_URL, MEDIA_UPLOAD_KEY, MEDIA_PUBLIC_BASE_URL
MEDIA_PUBLIC_VERIFY_TIMEOUT_MS
```

Modelo padrão: `z-ai/glm-5.3-flash`, via OpenRouter, centralizado em
`services/config.js` e configurável por `OPENROUTER_MODEL`.

## 9. URL pública de mídia

```text
arquivo local → MediaService → URL HTTPS pública → InstagramService → API
```

Validação: HTTPS, host público (não `localhost`, `127.0.0.1`, IP privado ou
caminho local), URL bem formada e Content-Type de imagem conferido no backend.
São aceitos múltiplos hosts seguros, não apenas um domínio fixo.

## 10. Testes

```powershell
npm test
```

Cobrem: catálogo de IA, regras editoriais, migração, validação de URL,
MediaService, InstagramService (imagem/reel/carrossel e falhas), SchedulerService
(aprovação, atraso, reconciliação, pausa, retomada, cancelamento) e os contratos
HTTP do router. Todos usam provedores fictícios; nenhuma conta real é publicada.
