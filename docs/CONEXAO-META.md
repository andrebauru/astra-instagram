# Conexão Meta no Astra

## Configuração e uso

O assistente Facebook é independente da integração Instagram existente. Não troca
seus tokens, IDs ou storage de mídia. Selecionar uma Página não publica conteúdo.

O consentimento solicita `pages_show_list`, `pages_read_engagement` e
`pages_manage_posts`. `instagram_basic` não é solicitado por esse fluxo; a
descoberta de Instagram vinculado só ocorre se essa permissão já vier concedida.
Na configuração do Facebook Login for Business, confira também os escopos
definidos no painel Meta: o Astra não altera essa configuração externa.

Em Configurações, informe `META_APP_ID`, `META_APP_SECRET`,
`META_LOGIN_CONFIG_ID`, `META_REDIRECT_URI` e `FACEBOOK_GRAPH_VERSION`.
Use a versão habilitada para seu aplicativo, sem adivinhar um valor.
App Secret e demais tokens nunca são retornados ao frontend. Os campos vazios
de segredo preservam o valor salvo. As sobreposições não modificam o `.env`.

O callback implementado é local: `http://localhost:8080/meta/oauth/retorno`
quando o painel é acessado em `http://localhost:8080`. Host e porta precisam
coincidir exatamente. Cadastre a URI aceita pelo produto/configuração do seu app
na Meta; a aceitação real desse callback ainda precisa ser verificada. Esta
implementação não fornece callback público nem suporte a exposição pública do Node.

1. Configure Facebook Login for Business para token de usuário no mesmo app.
2. Clique em Conectar, conceda consentimento e selecione os ativos na Meta.
3. Após retornar, escolha explicitamente uma Página descoberta.
4. Confira as permissões e o Instagram profissional vinculado, quando disponível.
5. Revise e aprove antes de qualquer publicação ou agendamento.

### Login em popup

O botão abre a janela durante o clique, mantém o editor aberto e usa o mesmo
OAuth seguro do backend. Ao retornar ao painel local, a janela fecha e a lista
de Páginas é atualizada; selecionar a Página continua sendo explícito.
Permita popups para o endereço local. Fechamento, bloqueio e espera superior a
dez minutos geram mensagens, sem afirmar sucesso. Se o navegador isolar a janela,
use Verificar conexão após terminar o login.

Abra o painel no mesmo host e porta do callback, não no servidor estático separado.
O popup não elimina a configuração inicial exigida pelo aplicativo Meta.
Os requisitos ausentes aparecem acima do seletor de Página, sem expor segredos.
Cada campo também recebe uma mensagem específica. O status distingue configuração
incompleta de pronto para autorizar. O botão não depende de Page ID ou Page Token.
Salvar somente campos Facebook não invalida o perfil Instagram verificado.

**Testar Página do Facebook** usa a Página selecionada no OAuth, revalida
permissões e consulta sua identidade. Não publica e não aceita a simples presença
de credenciais manuais como comprovação de consentimento OAuth. O envio legado
existente permanece separado, sem alteração das credenciais armazenadas.

Facebook e Instagram são destinos independentes. A agenda grava o ID da Página
na aprovação: trocar a Página bloqueia o envio antigo. O padrão de timezone é
Asia/Tokyo. Resultados incertos não autorizam reenvio automático.

## Segurança da agenda e recuperação de falhas

- Cada tentativa é gravada antes de chamar o publicador. Se a gravação falhar,
  o ciclo é interrompido com `AGENDA_PERSISTENCIA`, sem iniciar aquele envio.
- O resultado de cada destino é persistido antes de iniciar o próximo.
- Resultados `incerto` ou `em andamento` não autorizam reenvio, mesmo depois de
  pausa/retomada ou solicitação de reagendamento. Destinos confirmados são preservados.
- Após reinício, uma tentativa interrompida pode ser consultada por um reconciliador
  quando disponível. Sem confirmação, permanece bloqueada para reenvio. Isso não
  significa que a publicação falhou: ela pode ter sido aceita pelo provedor.
- A pausa não reabilita itens cancelados, falhos ou confirmados. Falhas definitivas
  continuam exigindo reagendamento manual; resultados incertos exigem investigação.
- Arquivo ausente permite criar uma agenda nova. JSON corrompido ou estrutura
  inválida bloqueia o carregamento: o sistema não substitui o histórico por uma
  agenda vazia. Preserve o arquivo e restaure somente um backup verificado.

Se aparecer `AGENDA_PERSISTENCIA`, verifique espaço em disco, permissões e bloqueios
no arquivo. Não apague os registros nem gere novos IDs para contornar um envio
incerto. Confira primeiro o destino na Meta e os IDs de publicação persistidos.
O ciclo automático registra falhas no diagnóstico e no terminal, sem credenciais.
Estas proteções não equivalem a uma transação distribuída com a Meta nem a uma
trava entre múltiplos processos: mantenha apenas um servidor usando a mesma agenda.

## Segurança e persistência

OAuth usa code no backend, App Secret e state descartável de dez minutos vinculado
à sessão HttpOnly/SameSite. Mutações exigem nonce CSRF. O callback redireciona para
uma URL limpa. A sessão local não é autenticação multiusuário: mantenha o serviço
restrito ao computador e ao usuário confiável.

`dados/meta-conexao.json` armazena a conexão cifrada; `dados/integracoes.json`
armazena as configurações cifradas. Os caminhos podem ser substituídos por
`ASTRA_META_CONEXAO_ARQUIVO` e `ASTRA_INTEGRACOES_ARQUIVO`.
A chave Windows fica em `%LOCALAPPDATA%\Astra\segredos\chave.dpapi` e depende do
perfil Windows original. Não apague a chave. Backup isolado dos JSONs não basta
para recuperar segredos em outro perfil. No Unix, a chave local usa permissão 0600.

Um JSON legado de configurações é migrado para AES-256-GCM na primeira leitura;
não é criado backup em texto aberto. Versões antigas do aplicativo não leem esse
formato. Arquivos corrompidos falham de forma fechada. O `.env` não é cifrado nem
reescrito por essa migração; continue protegendo-o.

Desconectar remove a conexão local; revogar exige confirmação separada e sucesso
explícito da API. Tokens vencidos exigem reconexão. Não há promessa de renovação
silenciosa. PKCE não foi implementado: sua disponibilidade para esta configuração
Meta não foi comprovada. Não há exclusão automática de mídia remota compartilhada.

## Rotas

- `GET /meta/conexao`: estado público e bootstrap de sessão/CSRF.
- `POST /meta/oauth/iniciar`: URL de consentimento e state.
- `GET /meta/oauth/retorno`: troca de código, diagnóstico e redirecionamento.
- `POST /meta/oauth/verificar`: reconsulta permissões e ativos.
- `POST /meta/oauth/selecionar`: aplica uma Página autorizada.
- `POST /meta/oauth/desconectar`: remoção local; `revogar: true` revoga na Meta.
- `GET/POST /config/integracoes`: campos públicos/presença de segredos e gravação.

## Diagnóstico e limites de verificação

O backend verifica tipo USER, app do token, permissões concedidas, escopos
granulares e páginas retornadas por `/me/accounts`. Lista vazia não comprova
ausência de controle administrativo nem bloqueio por App Review. Erro 100 é
exibido com código/subcódigo/referência seguros, sem mensagens que exponham tokens.

A consulta direta de um ID conhecido com token de usuário é uma alternativa
documentada pela Meta, mas ainda não possui fluxo dedicado neste assistente.
Não foi comprovada a causa real da lista vazia da Página TQ Japão, nem o tipo do
objeto consultado anteriormente. Nome GPT2 e controle total foram informados pelo
usuário, não confirmados por chamada real nesta implementação.

Permanecem pendentes a configuração real de App Secret, Login Configuration ID,
callback e versão, o consentimento no navegador e a verificação dos requisitos de
App Review/modo/permissões. Os testes automatizados usam provedores simulados:
não comprovam login ou publicação real. Execute `npm test` para a suíte local.

Se a Meta recusar HTTP/localhost, não substitua por uma URL inventada nem pelo
servidor de mídia: este código ainda só recebe callback local. Uma alternativa
exige um ambiente de desenvolvimento HTTPS com certificado válido, callback
registrado e sessão/cookies/origem adaptados e testados. Esse ambiente não foi
implantado. No painel Meta, confira o produto de login do app, configuração para
token USER, URI exata permitida e funções/usuários de teste no modo desenvolvimento.
“Pronto para teste” não equivale à aprovação para produção.
A suíte inclui regressões de falha de persistência antes/depois do envio, reinício
com tentativa pendente, bloqueio de reenvio incerto, pausa e arquivo corrompido.

Referência oficial consultada: [coleção Instagram da Meta no Postman](https://www.postman.com/meta/workspace/instagram/documentation/23987686-9386f468-7714-490f-9bfc-9442db5c8f00).
