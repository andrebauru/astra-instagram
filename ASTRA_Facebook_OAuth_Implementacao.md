# ASTRA — Correção e automação do login Facebook (Meta OAuth)

## Objetivo
Corrigir o botão **Conectar com Facebook** e implementar a autorização oficial da Meta de ponta a ponta, sem exigir que o usuário entre no Meta for Developers para obter tokens a cada conexão. **Preservar integralmente a integração existente com Instagram.**

## Contexto observado
- ASTRA roda localmente em `http://localhost:8080/`.
- A interface mostra os campos Meta App ID, Meta App Secret e URL de retorno OAuth.
- A URL exibida como exemplo é `http://localhost:8080/meta/oauth/retorno`; **confirmar no código se a rota existe antes de adotá-la**.
- Mesmo após salvar as configurações, a interface continua exibindo **Configuração inicial necessária** e o botão **Conectar com Facebook** permanece desabilitado.
- **Testar página do Facebook** solicita ID e token da página, mas não há campos correspondentes; a interface promete não exigir cópia manual de tokens.
- A permissão `pages_manage_posts` aparece como **Pronto para teste** no painel da Meta; isso não garante autorização para qualquer usuário nem aprovação para produção.
- O fluxo atual abre o painel Meta for Developers em vez da autorização de login.

## Tarefas de investigação — antes de alterar código
1. Localizar componentes da interface, validação de configuração, persistência de segredos, endpoints OAuth, testes da página e possíveis fluxos legados.
2. Reproduzir a desabilitação do botão e identificar a condição exata, com evidências (arquivo, função e teste).
3. Verificar como o ASTRA distingue **App ID** de **Page ID**, e **App Secret** de **Page Access Token**.
4. Verificar se o callback de exemplo existe, se o servidor escuta em 8080 e se o provedor aceita a URI exata no ambiente local.
5. Identificar como a conexão Instagram é armazenada para garantir isolamento completo.

## Implementação necessária
### Configuração e interface
- Validar e persistir App ID, App Secret e callback de forma segura, sem mostrar segredos após o salvamento.
- Exibir erros por campo, em vez de um aviso genérico; corrigir o estado do botão de conexão para refletir requisitos reais de **iniciar OAuth**, não a existência prévia de Page Token.
- Separar status: **não configurado**, **pronto para autorizar**, **conectado**, **autorização expirada/revogada**, **erro**.
- Oferecer **Conectar**, **Selecionar página**, **Verificar conexão**, **Reconectar** e **Desconectar**.
- Não direcionar o botão de conexão ao painel de desenvolvedores. Um link separado para configuração avançada é aceitável.

### OAuth oficial da Meta
- Iniciar fluxo OAuth com permissões mínimas necessárias à seleção e publicação em páginas, avaliando `pages_show_list`, `pages_read_engagement` e `pages_manage_posts` segundo a versão da Graph API e o caso de uso.
- Gerar e validar `state` anti-CSRF vinculado à sessão, com expiração e uso único.
- Usar URI de retorno exatamente igual à configurada no app da Meta. **Não presumir que localhost ou HTTP sejam aceitos em todas as configurações; documentar alternativa segura de desenvolvimento se necessário.**
- Receber e validar callback, trocar código por token exclusivamente no backend e tratar cancelamento, erro, escopos recusados e token inválido.
- Consultar páginas autorizadas pela API oficial, obter Page IDs e Page Access Tokens disponíveis e permitir escolher a página correta.
- Guardar tokens de forma protegida no backend, com mínimo privilégio e sem registrá-los em logs, HTML ou respostas públicas.
- Tratar validade, revogação e necessidade de nova autorização; não prometer renovação automática ilimitada.

### Teste da página
- Substituir a exigência de ID/token manual pelo uso da página selecionada na conexão OAuth.
- O botão **Testar página do Facebook** deve apenas validar acesso e permissões por chamada de leitura, **sem publicar conteúdo real**.
- Mensagens devem distinguir falta de autorização, ausência de página, escopo insuficiente, falha de rede e token revogado.

### Preservação do Instagram
- Não sobrescrever credenciais, estado de conexão, configuração, agendamentos, publicações ou rotas do Instagram.
- Evitar refatorações amplas e duplicação de fluxos. Isolar dados de Facebook e Instagram e manter compatibilidade com configurações existentes.

## Testes e critérios de aceite
- Testes automatizados com mocks para validação e persistência da configuração; botão habilitado/desabilitado; início OAuth; `state` válido, inválido e reutilizado; callback; troca de código; lista e seleção de páginas; erros de escopo; expiração/revogação; desconexão; teste de página sem publicação.
- Testes de regressão do Instagram devem permanecer verdes.
- Não executar posts reais nem usar credenciais de produção nos testes.
- Confirmar manualmente em ambiente de desenvolvimento, com autorização explícita do operador, que **Conectar com Facebook** abre o diálogo oficial de autorização, retorna ao ASTRA e exibe a página autorizada.
- Se faltar configuração no painel da Meta (por exemplo, URI OAuth válida, funções de teste, permissões ou modo do aplicativo), documentar o passo exato; não declarar integração pronta sem a validação final.

## Entregáveis da IDE
1. Diagnóstico da causa raiz, com referências a arquivos e funções.
2. Alterações mínimas e justificadas, com lista de arquivos modificados.
3. Testes executados e resultados.
4. Passos externos necessários na Meta, caso existam.
5. Instruções de verificação local, sem revelar segredos.

**Regra de execução:** primeiro auditar e preservar o que já funciona; depois implementar e testar. Não fazer push, não publicar no Facebook ou Instagram e não alterar credenciais existentes sem autorização explícita.
