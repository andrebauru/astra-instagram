# PROMPT DE CORREÇÃO — ASTRA: PUBLICAÇÃO E LOGS

## Objetivo
Corrigir o fluxo de revisão e publicação do Astra e implementar registro persistente de atividades e erros na página **Logs**. Trabalhar no projeto existente, preservando integrações, credenciais, IDs, portas, aparência e funcionalidades já operacionais. Não publicar conteúdo real durante os testes.

## 1. Fluxo obrigatório de revisão
1. Inicialmente, **Publicar Agora** deve permanecer desativado.
2. Ao clicar em **Marcar Revisão Humana**, registrar a revisão e habilitar **Confirmar Conteúdo**.
3. Ao clicar em **Confirmar Conteúdo**, persistir a confirmação e habilitar **Publicar Agora**, desde que exista ao menos um destino selecionado e válido.
4. Não exigir seleção simultânea de Instagram e Facebook. Não exigir Stories quando somente Feed foi escolhido, nem Feed quando somente Stories foi escolhido.
5. **Salvar e ir para agendamento** é um caminho independente: deve salvar o rascunho/configuração e seguir para agendamento sem publicar imediatamente. Após publicação imediata, salvar o resultado e os estados de cada destino; não agendar automaticamente uma segunda publicação.
6. Recarregar a página não deve perder o estado de revisão e confirmação já persistido. Se o conteúdo ou destinos forem alterados após confirmação, invalidar a confirmação quando necessário e explicar o motivo na interface.

## 2. Destinos selecionados — execução estrita
- Instagram selecionado, Facebook não selecionado: publicar **somente Instagram**.
- Facebook selecionado, Instagram não selecionado: publicar **somente Facebook**.
- Ambos selecionados: publicar em ambos e acompanhar o resultado de cada um separadamente.
- Respeitar individualmente as opções **Feed** e **Stories** de cada plataforma, apenas quando explicitamente selecionadas e suportadas pela API/permissões vigentes.
- Não publicar em destino não selecionado, mesmo que a conta esteja conectada.
- Validar permissões, token, conta/página, formato de mídia e requisitos específicos no momento de publicar. Se uma opção não for suportada, mostrar erro específico e não fingir sucesso.
- Se um destino falhar e outro tiver sucesso, apresentar **sucesso parcial** e não republicar automaticamente no destino que já teve sucesso.
- Evitar duplicação por duplo clique, timeout ou retentativa: bloquear envio simultâneo e usar identificador/idempotência por operação e destino.

## 3. Diagnóstico do botão Publicar Agora
- Rastrear no frontend e backend todas as condições de habilitação, inclusive estados desatualizados, validações antigas e discrepâncias entre rascunho salvo e estado da interface.
- Corrigir a causa real, sem simplesmente remover todas as validações.
- O botão deve refletir a revisão e confirmação persistidas, com pelo menos um destino válido.
- Quando desativado, exibir a razão exata e verificável; quando clicado, mostrar progresso e resultado por destino.
- Não modificar tokens, IDs, segredos, porta 8080 ou configurações existentes sem necessidade demonstrada.

## 4. Página Logs — atividade e erros
Implementar logs **reais, persistentes e consultáveis** na página **Logs**, usando backend e armazenamento já existentes (ou migração mínima compatível). Não criar apenas mensagens decorativas no frontend.

Registrar, no mínimo:
- Data/hora com fuso e timestamp UTC; nível (DEBUG, INFO, WARNING, ERROR); módulo; ação; status; identificador de correlação; usuário/ator quando disponível.
- Abertura/salvamento de rascunho; mudança de destinos; revisão humana; confirmação de conteúdo; clique em Publicar Agora; início/fim da tentativa por plataforma e superfície (Feed/Stories); agendamento; sucesso, falha e sucesso parcial.
- Erros de validação, API Meta, autenticação/permissão, mídia/URL pública, rede, backend, frontend e banco de dados.
- Para erros: mensagem legível, código HTTP/código da API quando existir, etapa e contexto técnico suficiente para depuração, com stack trace **somente no armazenamento protegido**, quando apropriado.
- Nunca registrar tokens, senhas, cookies, chaves, dados sensíveis ou payloads pessoais completos. Mascarar segredos.
- Filtrar por data, nível, módulo, plataforma, status e ID da operação; permitir busca, paginação, atualização e visualização dos detalhes.
- Exibir estados vazios honestos; registrar eventos em tempo real ou por atualização periódica sem degradar o desempenho.
- Definir retenção e rotação para impedir crescimento ilimitado; controlar acesso à página e ao endpoint de logs.
- Garantir que erros sejam registrados mesmo quando a operação falhar; não silenciar exceções.

## 5. Testes obrigatórios — sem publicações reais
Criar testes automatizados e/ou simulações com mocks para:
1. Revisão não marcada → Confirmar Conteúdo inativo; Publicar Agora inativo.
2. Revisão marcada → Confirmar Conteúdo ativo; publicação ainda inativa.
3. Conteúdo confirmado + Instagram somente → Publicar Agora ativo; chamada apenas ao Instagram.
4. Conteúdo confirmado + Facebook somente → ativo; chamada apenas ao Facebook.
5. Ambos → duas execuções independentes, com status individual.
6. Feed/Stories → apenas superfícies selecionadas; casos não suportados geram erro claro.
7. Nenhum destino válido → não publicar e explicar bloqueio.
8. Falha parcial, token inválido, erro de mídia, timeout e clique duplicado → comportamento seguro, sem duplicação.
9. Persistência após refresh e invalidação apropriada após edição.
10. Logs aparecem na página, filtros funcionam, erros persistem e segredos ficam mascarados.
11. Fluxo de agendamento não dispara publicação imediata.

## 6. Entrega exigida ao agente
- Inspecionar a arquitetura e identificar arquivos e funções responsáveis pelo fluxo; **implementar** as alterações no código existente, não apenas descrever.
- Mostrar causa raiz identificada e arquivos alterados.
- Executar testes e apresentar resultados, incluindo falhas remanescentes.
- Não afirmar que publicou nas plataformas se foram usados mocks.
- Não alterar funcionalidades não relacionadas nem efetuar publicação real sem autorização explícita.

**Critério de aceite:** após Marcar Revisão Humana e Confirmar Conteúdo, Publicar Agora habilita para Instagram, Facebook ou ambos, publica exclusivamente os destinos/superfícies escolhidos, salva resultados, e a página Logs exibe atividades e erros persistidos.
