# Continuação do Astra Instagram

## Finalidade deste handoff

Este documento permite retomar o trabalho no projeto existente em `D:\Programacao\astra-instagram` sem apagar, sobrescrever ou refazer alterações já produzidas. O estado descrito foi conferido em 2026-10-10 no branch `master`, commit-base `d7b279b`, com uma árvore de trabalho extensa e não commitada.

O próximo chat deve considerar todos os arquivos existentes como trabalho do usuário até provar o contrário. Não limpar a árvore, não descartar alterações, não usar `git reset --hard`, não restaurar arquivos por checkout e não remover arquivos não rastreados.

## Objetivo do Astra Instagram

O Astra Instagram é um estúdio local para:

- selecionar e revisar mídia local;
- enviar a mídia para uma URL HTTPS pública;
- preparar conteúdo e variações editoriais com IA;
- manter templates e dados recorrentes;
- revisar e aprovar uma publicação;
- publicar imediatamente somente após confirmação explícita;
- criar e administrar agendamentos persistentes;
- ler publicações e métricas orgânicas do Instagram;
- manter histórico, rastreabilidade, diagnóstico e prevenção de duplicidade.

O escopo é Instagram orgânico. Facebook, Meta Ads, impulsionamento, orçamento e criação de anúncios não devem ser reintroduzidos sem uma autorização nova e específica.

## Regras prioritárias e restrições do usuário

1. **Nunca executar publicação real, reiniciar serviços reais ou acionar mudanças externas sem autorização explícita do usuário.**
2. Nunca publicar na Meta durante testes. Usar exclusivamente provedores simulados/fictícios.
3. Não reiniciar, interromper, matar nem substituir o processo real da porta `8080`.
4. Para testes de servidor, usar portas temporárias e encerrar somente os processos iniciados pelo próprio teste.
5. Não editar, reformatar, substituir, renomear ou recriar `.env`.
6. Não alterar tokens, IDs, credenciais ou permissões Meta.
7. Não registrar nem exibir tokens, chaves, cookies, cabeçalhos de autorização ou conteúdo do `.env`.
8. Não apagar nem sobrescrever trabalho existente. A árvore está suja e contém alterações do usuário e de rodadas anteriores.
9. Manter backend/arquivos como fonte de verdade para persistência; IndexedDB é cache/fallback do navegador.
10. Preservar a integração que reconhece a conta do Instagram e lê publicações anteriores.
11. Confirmar conteúdo não deve publicar. “Publicar agora” exige decisão e confirmação separadas.
12. O navegador não deve ser requisito estrutural do backend ou dos testes unitários. Entretanto, a validação da interface realmente servida continua pendente neste checkpoint e deve ser repetida antes de declarar conclusão visual.

## Como o próximo chat deve começar

Antes de alterar qualquer código:

1. Pesquisar dentro do projeto nesta ordem:
   - `AGENTS.md` no diretório e diretórios-pai;
   - `README.md` e documentação do projeto;
   - `package.json`;
   - código e testes relacionados;
   - `git status --short`, `git diff --stat`, `git diff --check` e diffs focados.
2. Na inspeção de 2026-10-10 não havia `AGENTS.md` dentro deste projeto, mas isso deve ser verificado novamente porque instruções podem ter sido adicionadas.
3. Depois, pesquisar os chats anteriores com `list_threads` e `read_thread`, usando os títulos e resumos apenas para localizar contexto. Priorizar o chat **“Implementar diagnóstico e carrosséis”**.
4. Só então propor ou aplicar alterações focadas.

Chats úteis conhecidos:

- `01a0d5ae-b44b-7b42-a955-cc6877bdd8c3` — **Implementar diagnóstico e carrosséis**; principal chat de implementação do Astra.
- `01a0ec1b-ab2f-7670-9dbc-5d543c5c9310` — **Corrigir bloqueios de publicação**; tipo de mídia e URL pública.
- `01a11dcd-94a4-7823-982f-b925abdb3fb9` — **Ajustar upload para 256 MB e MP4**; alterações posteriores no upload, não confundir com o checkpoint de 119 testes.
- `01a0ae7c-c2a9-7453-b6aa-2a4af2de0e27` — **Implementar plano com abas**; origem da interface em abas.
- `01a0e677-7c22-7d21-98c5-cf97ec738817` — **Astra APP**; resumo relacionado a publicações e bloqueios, mas localizado em outro projeto/cwd e deve ser usado apenas como referência contextual.

## Estado das correções anteriores

### Polling e idempotência da publicação

- `services/instagram-service.js` consulta `status_code,status` do contêiner.
- A publicação aguarda `FINISHED`; `PUBLISHED` é reconciliado sem novo `media_publish`.
- `ERROR`, `EXPIRED` e timeout produzem erros controlados.
- O timeout preserva o `containerId` para retry/reconciliação e não solicita publicação prematuramente.
- `services/publicacao-meta-store.js` e `dados/publicacoes-meta.json` guardam estado de contêiner/publicação para evitar duplicidade após reinício.
- Imagem, Reel, carrossel e Story passam pelo mesmo `InstagramService.publish()`.

### Templates

- Existe biblioteca de múltiplos templates, não apenas um template padrão.
- Backend: `services/templates-store.js`.
- Persistência: `dados/templates.json`.
- API: `GET/POST /empresa/templates`.
- A interface possui nome, seletor, criação e atualização de templates.
- Migração do template padrão/dados recorrentes foi prevista.

### Navegação e persistência editorial

- O fluxo continua em abas: Mídia → Informações → IA → Revisão → Agendamento → Desempenho.
- Salvar e avançar valida a etapa, persiste e só depois navega.
- Não criar handlers duplicados para o botão Salvar.
- O backend é fonte de verdade dos rascunhos; IndexedDB permanece como cache/fallback.

### Miniaturas e publicações anteriores

- A interface tenta fontes de miniatura em ordem e exibe “Sem miniatura” quando todas falham.
- Publicações anteriores oferecem a ação visível **“Usar como exemplo e criar rascunho”**.
- O post histórico original não deve ser editado.
- A miniatura histórica é somente referência; não deve ser tratada como mídia publicável.

### Publicar agora

- A ação é explícita e separada da confirmação editorial.
- Há diálogo de confirmação e controle para impedir repetição acidental.
- Resultado, `media_id`, permalink, contêiner e erros são persistidos.
- Uma publicação já confirmada não deve ser duplicada em retry.

### IA

- A IA prepara legenda/variações, mas não publica.
- Templates, hashtags, links e dados fixos devem permanecer protegidos durante variações.
- Erro, timeout ou resposta vazia não podem destruir o plano/conteúdo original.
- O usuário pode escrever manualmente quando a IA falhar.

## Último escopo autorizado antes da interrupção

O último escopo autorizado desta rodada foi:

1. Reels somente em arquivo e URL de vídeo MP4.
2. Checkbox **“Publicar também no Story”** no conteúdo individual e nos itens/planos de agenda.
3. Story permitido somente para conta Instagram Business verificada.
4. Feed/Reel e Story com resultados independentes; carrossel não deve ser convertido automaticamente em Story.
5. Biblioteca com múltiplos templates persistida em `dados/templates.json`.
6. Rascunhos persistidos no backend em `dados/publicacoes.json`, sem base64/miniaturas embutidos.
7. Posts antigos usados apenas como exemplo para criar um **novo rascunho**.
8. Agenda persistida em `dados/agendamentos.json`.
9. Persistência de contêiner Meta em `dados/publicacoes-meta.json`.
10. O browser não é obrigatório para a arquitetura nem para a suíte unitária, mas a interface servida ainda precisa ser validada como etapa separada.

## Arquivos envolvidos/modificados na última rodada

Núcleo e persistência:

- `server.js`
- `midia-publica.js`
- `services/config.js`
- `services/empresa-store.js`
- `services/instagram-service.js`
- `services/media-service.js`
- `services/scheduler-service.js`
- `services/publicacao-meta-store.js` — novo
- `services/publicacoes-store.js` — novo
- `services/templates-store.js` — novo

Interface:

- `painel-meta-prototipo/index.html`
- `painel-meta-prototipo/painel.js`
- `painel-meta-prototipo/publicacoes.js`
- `painel-meta-prototipo/integracao-regras.js`
- `painel-meta-prototipo/planejamento-semanal.js`
- `painel-meta-prototipo/fluxo-editorial.js`
- `painel-meta-prototipo/servidor.js`
- `painel-meta-prototipo/regras.js`
- `painel-meta-prototipo/regras.test.js`

Testes e configuração de scripts:

- `package.json`
- `testes/api.test.js`
- `testes/fluxo.test.js`
- `testes/fluxo-editorial.test.js`
- `testes/frontend-smoke.test.js`
- `testes/instagram-service.test.js`
- `testes/media-service.test.js`
- `testes/persistencia-backend.test.js` — novo
- `testes/restauracao.test.js`
- `testes/scheduler-service.test.js`
- `testes/servidor-ui-simulado.js`
- `testes/upload-url.test.js`

### Estado atual adicional observado

O `git status --short` inspecionado em 2026-10-10 mostrava 36 entradas e aproximadamente 1.092 adições/171 remoções entre arquivos rastreados. Além dos arquivos acima, havia alterações ou artefatos posteriores em:

- `astra-visao.js`;
- `.user.ini`;
- `UPLOAD-PHP-SERVIDOR.md`;
- `upload.php`;
- `media/`;
- ajustes posteriores de upload de até 256 MB e análise visual de MP4.

Esses itens posteriores não devem ser apagados nem automaticamente atribuídos ao checkpoint original. O arquivo `upload.php` contém material de autenticação derivado; não imprimir nem copiar seu conteúdo ou hashes para logs/relatórios. Revisar o chat **“Ajustar upload para 256 MB e MP4”** antes de mexer neles.

## Testes conhecidos e ponto exato da interrupção

Checkpoint conhecido da rodada: **119 testes aprovados, 0 falhas**.

Não transformar esse número em confirmação do estado atual sem executar novamente a suíte, pois a árvore recebeu alterações posteriores.

O executor atingiu o limite de uso enquanto estavam em andamento duas verificações obrigatórias:

1. **Persistência após reinício:** confirmar que múltiplos templates, rascunhos, estado de plano/agendamento e destinos Feed/Story sobrevivem a parar e iniciar novamente um servidor de teste.
2. **Validação servida no navegador:** conferir no painel realmente servido o fluxo Business/Story, seletor de templates, criação de rascunho a partir de post histórico, miniaturas e bloqueio explícito de Reel não MP4.

Essas duas verificações **não estão concluídas neste checkpoint**. Não declarar que passaram sem repeti-las e guardar evidência objetiva.

## Comandos reais e verificados

Executar a partir de `D:\Programacao\astra-instagram`.

Inspeção segura:

```powershell
git status --short
git diff --stat
git diff --check
git diff --name-only
```

Suíte automatizada completa, com provedores fictícios nos testes:

```powershell
npm test
```

Testes focados de persistência/backend e API:

```powershell
node --test testes/persistencia-backend.test.js testes/api.test.js
```

Servidor simulado de interface, sem carregar `.env` e sem chamadas externas:

```powershell
npm run test:ui
```

Esse comando usa `http://127.0.0.1:4320/painel/`. Encerrar com `Ctrl+C` no mesmo processo após a verificação.

Verificação somente leitura da porta real:

```powershell
Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue
```

O comando documentado `npm start` usa a configuração real e normalmente a porta `8080`; **não executá-lo nesta retomada** sem autorização explícita.

## Como repetir a verificação pendente com segurança

### Persistência após reinício

1. Não usar a porta 8080 nem os arquivos reais de `dados/` como massa descartável.
2. Usar uma porta temporária e caminhos temporários para `ASTRA_EMPRESA_ARQUIVO`, `ASTRA_TEMPLATES_ARQUIVO`, `ASTRA_PUBLICACOES_ARQUIVO`, `ASTRA_PUBLICACOES_META_ARQUIVO` e `ASTRA_AGENDADOR_ARQUIVO`.
3. Usar somente credenciais/provedores fictícios, como faz `testes/servidor-ui-simulado.js`.
4. Na primeira execução, gravar pelo backend:
   - pelo menos dois templates;
   - um rascunho;
   - um plano aprovado com destinos Feed e Story.
5. Encerrar somente esse processo de teste.
6. Iniciar uma segunda instância apontando para os mesmos arquivos temporários.
7. Ler os endpoints e confirmar IDs, conteúdo, estado e destinos exatamente iguais.
8. Encerrar a segunda instância e registrar evidência sem segredos.

### Interface servida

1. Executar `npm run test:ui`.
2. Abrir `http://127.0.0.1:4320/painel/`.
3. Confirmar que o teste de conta fictícia Business habilita Story.
4. Confirmar que carrossel mantém Story indisponível com explicação.
5. Confirmar criação, seleção e atualização de múltiplos templates.
6. Confirmar que “Usar como exemplo e criar rascunho” cria novo conteúdo sem mídia publicável herdada.
7. Confirmar que Reel aceita somente MP4 e que a revisão mostra a pendência correta para formato inválido.
8. Confirmar navegação/salvamento sem recarregar a página.
9. Não clicar em qualquer ação que possa alcançar uma conta real; o servidor simulado deve permanecer como única origem.
10. Encerrar o processo criado com `Ctrl+C`.

## Riscos e pendências

- A árvore está muito suja e sem commit; qualquer limpeza pode destruir trabalho.
- A persistência após reinício ainda precisa de prova repetível no estado atual.
- A validação visual servida ainda precisa ser repetida no estado atual.
- A suíte deve ser rodada novamente depois das alterações posteriores; o único checkpoint obrigatório deste handoff é 119/119.
- Permissões e readiness reais de Instagram Business/Story não foram verificadas nesta retomada.
- Não inferir readiness de Facebook/Marketing API a partir da leitura do Instagram.
- MP4 público depende de o storage remoto devolver URL HTTPS acessível e `Content-Type` compatível.
- O agendador precisa de processo Node em execução; não transformar isso em serviço do sistema sem autorização.
- Arquivos em `dados/` podem conter estado real do usuário. Não zerar, recriar ou usar como fixture destrutiva.
- Artefatos posteriores de upload (`upload.php`, `.user.ini`, documentação e `media/`) exigem revisão separada e não fazem parte da validação pendente de 119 testes.
- Não fazer commit, push, criar branch, inicializar Git ou publicar PR sem pedido do usuário.

## Checklist de retomada

- [ ] Ler instruções do projeto e chats anteriores antes de editar.
- [ ] Registrar `git status --short` e `git diff --stat` sem modificar arquivos.
- [ ] Confirmar que `.env` não será alterado.
- [ ] Confirmar que a porta 8080 permanecerá intocada.
- [ ] Rodar `npm test` e registrar contagem atual, sem substituir retroativamente o checkpoint de 119.
- [ ] Rodar testes focados de persistência/backend.
- [ ] Repetir a persistência após reinício em porta e arquivos temporários.
- [ ] Repetir a validação da interface com `npm run test:ui` na porta 4320.
- [ ] Encerrar apenas processos temporários criados pelo teste.
- [ ] Rodar `git diff --check`.
- [ ] Informar claramente o que foi comprovado, o que falhou e o que continua pendente.

## Critérios de conclusão

Uma retomada só pode declarar esta rodada concluída quando houver evidência de que:

1. a suíte atual passa integralmente;
2. templates, rascunhos, contêineres e agendamentos persistem após reinício de servidor de teste;
3. a interface servida apresenta corretamente Story/Business, múltiplos templates, rascunho baseado em post antigo, miniaturas e regra MP4;
4. nenhuma publicação real, chamada externa não simulada ou alteração de credencial ocorreu;
5. `.env` permaneceu byte a byte intocado;
6. a porta 8080 e seu processo permaneceram intocados;
7. nenhum trabalho existente foi apagado ou sobrescrito;
8. processos e arquivos temporários usados pelo teste foram tratados sem afetar dados reais;
9. riscos ou bloqueios externos restantes foram reportados como pendentes, sem inventar sucesso.
