# Auditoria OAuth — 15/10/2026

## Evidência local

Consulta somente de leitura ao servidor em localhost:8080: App ID, App Secret e
Login Configuration ID presentes; META_REDIRECT_URI e FACEBOOK_GRAPH_VERSION
ausentes. Nenhum valor secreto foi exibido. A resposta do processo não continha
pendenciasConfiguracao, embora o arquivo em disco já a implementasse: há divergência
entre processo em execução e código. O servidor principal não foi reiniciado.

Em `services/meta-conexao-service.js`, `status()`/`config()` exigem configuração
do aplicativo antes de autorizar. Não exigem Page Token para iniciar. A correção
centralizou a validação dos requisitos OAuth, inclusive formato e origem do callback,
e expõe erros por campo e etapa pública. Configuration ID continua necessário para
o produto Facebook Login for Business usado nesta instalação; versão não é inventada.

A rota `GET /meta/oauth/retorno` existe em `server.js`; o servidor usa a porta
configurada, padrão 8080. Aceitação real da URI pela Meta não foi verificada.

O botão `meta-conectar` usa `window.open` seguido da URL de `/meta/oauth/iniciar`,
validada como www.facebook.com/vN.N/dialog/oauth. Os links developers.facebook.com
do formulário são atalhos separados. Não foi encontrado redirecionamento desse
botão ao Developers no código atual; o comportamento relatado precisa ser
retestado após atualizar o processo e recarregar a página.

## Correções

- `services/meta-conexao-service.js`: erros por campo, etapa de configuração,
  permissões restritas ao Facebook, teste de Página com token OAuth e bloqueio
  de seleção após falha/revogação. App ID e Page ID são identidades distintas;
  App Secret autentica o aplicativo, Page Token autentica consultas da Página.
- `server.js`: status valida origem atual; `/facebook/me` usa o teste OAuth.
- `painel-meta-prototipo/meta-conexao.js` e `index.html`: mensagens associadas aos
  campos e estado pronto para autorizar, preservando popup e seleção explícita.
- `painel-meta-prototipo/painel.js`: grava somente campos alterados e não invalida
  o perfil Instagram quando só configurações Facebook mudam.
- `painel-meta-prototipo/integracao-regras.js`: mensagens não pedem mais cópia
  manual de Page Token; preservam diagnóstico seguro do teste da Página.
- Testes em `testes/meta-conexao.test.js`, `frontend-smoke.test.js` e `api.test.js`.

`services/integracoes-store.js` mantém a persistência cifrada existente, sem
modificação nesta correção. Credenciais Instagram não são sobrescritas pelo OAuth;
nenhum agendamento ou publicação existente foi editado. `.env` não foi alterado.

## Verificação e limites

Testes simulados cobrem configuração, CSRF/state, callback, token, seleção,
revogação, teste somente leitura e popup. O login de produção não foi executado.
Suíte completa: 176 testes aprovados, zero falhas. Conferência no navegador com
servidor isolado na porta 4320 confirmou mensagens por campo e que Testar Página
pede autorização/seleção OAuth, não ID/token manual. O servidor de teste foi encerrado.
Para validar localmente: reinicie o processo com autorização do operador,
recarregue o painel, preencha callback/versão reais e salve. Confira os erros por
campo; só então Conectar, autorizar na Meta, selecionar e testar a Página.
Não é necessário publicar para verificar o acesso.

Veja CONEXAO-META.md para os passos externos e a limitação HTTP/local.
Não houve push, alteração do app na Meta ou publicação externa.
