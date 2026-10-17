'use strict';
const crypto = require('node:crypto');
const { erroSeguro } = require('../bridge-seguranca');
const ESCOPOS = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'];

/** OAuth confidencial para Facebook, independente das credenciais Instagram existentes. */
function criarMetaConexaoService({ cofre, configuracao, aoSelecionar, aoDesconectar, fetchImpl, agora = Date.now, registrar = () => {} }) {
    const fluxos = new Map();
    let operacaoAtiva = false;
    /** Expõe somente nomes dos requisitos ausentes, nunca valores secretos. */
    function errosConfiguracao(c, origem) {
        const erros = {};
        if (!/^\d+$/.test(c.appId || '')) erros.META_APP_ID = 'Informe o App ID numérico do aplicativo, não o ID da Página.';
        if (!c.secret) erros.META_APP_SECRET = 'Informe o App Secret do aplicativo, não um token de acesso.';
        if (!/^\d+$/.test(c.configId || '')) erros.META_LOGIN_CONFIG_ID = 'Informe o Configuration ID do Facebook Login for Business para token de usuário.';
        if (!/^v\d+\.\d+$/.test(c.versao || '')) erros.FACEBOOK_GRAPH_VERSION = 'Informe a versão habilitada no aplicativo no formato vN.N.';
        try {
            const url = new URL(c.redirect);
            if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/meta/oauth/retorno' || url.search || url.hash || url.username || url.password) throw new Error();
            if (origem && url.origin !== origem) erros.META_REDIRECT_URI = 'Abra o painel no mesmo host e porta do callback cadastrado.';
        } catch { erros.META_REDIRECT_URI = 'Informe o callback local completo: http://localhost:PORTA/meta/oauth/retorno (ou 127.0.0.1).'; }
        return erros;
    }
    /** Exige configuração explícita e callback local exato desta instalação. */
    function config(origem) {
        const c = configuracao();
        if (Object.keys(errosConfiguracao(c)).length) throw erroSeguro('META_CONFIG_INCOMPLETA', 'Confira os campos OAuth indicados no painel antes de conectar.', 400);
        let retorno; try { retorno = new URL(c.redirect); } catch { throw erroSeguro('META_CONFIG_INCOMPLETA', 'URI de retorno inválida.', 400); }
        if (retorno.origin !== origem || retorno.pathname !== '/meta/oauth/retorno' || retorno.search || retorno.hash || retorno.username || retorno.password) throw erroSeguro('META_CALLBACK_INVALIDO', 'Abra o Astra no mesmo endereço e porta cadastrados na URI de retorno.', 400);
        return c;
    }
    /** Serializa mudanças de conexão para não sobrescrever seleção ou revogação. */
    async function exclusivo(executar) {
        if (operacaoAtiva) throw erroSeguro('META_CONEXAO_OCUPADA', 'Aguarde a operação de conexão atual.', 409);
        operacaoAtiva = true;
        try { return await executar(); } finally { operacaoAtiva = false; }
    }
    /** Usa somente a Graph API fixa e registra códigos, nunca URLs ou tokens. */
    async function graph(c, caminho, token, params = {}, method = 'GET') {
        const url = new URL(`https://graph.facebook.com/${c.versao}/${caminho}`);
        const corpo = new URLSearchParams(params);
        if (method === 'GET') url.search = corpo.toString();
        let resposta, dados;
        try {
            resposta = await (fetchImpl || globalThis.fetch)(url, { method, redirect: 'error', signal: AbortSignal.timeout(20000), headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(method === 'GET' ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }) }, ...(method === 'GET' ? {} : { body: corpo.toString() }) });
            dados = await resposta.json();
        } catch { throw erroSeguro('META_CONEXAO_FALHOU', 'Não foi possível obter resposta da Meta. Tente verificar a conexão novamente.'); }
        if (!resposta.ok || dados.error) {
            const codigo = Number(dados.error?.code) || 0;
            const subcodigo = Number(dados.error?.error_subcode) || 0;
            const trace = /^[A-Za-z0-9_-]{1,160}$/.test(dados.error?.fbtrace_id || '') ? dados.error.fbtrace_id : null;
            const estado = codigo === 190 ? 'token_expirado' : [10, 200].includes(codigo) ? 'autorizacao_insuficiente' : 'erro_api';
            registrar('META', 'connection_failed', { codigo, subcodigo, requestId: trace, result: estado });
            throw Object.assign(erroSeguro('META_AUTORIZACAO_FALHOU', `Meta: ${estado.replaceAll('_', ' ')} (código ${codigo}, subcódigo ${subcodigo}${trace ? ', referência ' + trace : ''}).`, 400), { diagnostico: { estado, codigo, subcodigo, referencia: trace } });
        }
        return dados;
    }
    /** Retorna apenas evidências e identidades públicas, sem o conteúdo do cofre. */
    function status(origem) {
        const e = cofre.ler();
        const c = configuracao();
        const expirou = [e.expiraEm, e.acessoExpiraEm].some(valor => valor > 0 && valor <= agora());
        const erros = errosConfiguracao(c, origem);
        const configurado = Object.keys(erros).length === 0;
        const estado = expirou ? 'token_expirado' : e.estado || 'desconectado';
        return {
            estado,
            etapa: !configurado ? 'nao_configurado' : estado === 'desconectado' ? 'pronto_para_autorizar' : estado,
            configurado, errosConfiguracao: erros,
            pendenciasConfiguracao: Object.values(erros),
            pagina: e.selecionada ? { id: e.selecionada.id, nome: e.selecionada.name, instagramId: e.selecionada.instagramId || null } : null,
            paginas: (e.paginas || []).map(p => ({ id: p.id, nome: p.name, tarefas: p.tasks || [], instagramId: p.instagramId || null })),
            diagnostico: e.diagnostico || null, expiraEm: e.expiraEm || null, acessoExpiraEm: e.acessoExpiraEm || null,
            verificadoEm: e.verificadoEm || null, appId: e.appId || c.appId || null,
            mensagem: expirou ? 'Autorização expirada. Reconecte com Facebook.' : e.mensagem || 'Conecte com Facebook para descobrir suas páginas. O Instagram atual não será substituído.'
        };
    }
    /** Gera state descartável, limitado e vinculado à sessão HttpOnly do navegador. */
    function iniciar(sessao, origem) {
        const c = config(origem);
        for (const [state, fluxo] of fluxos) if (fluxo.expira <= agora()) fluxos.delete(state);
        if (fluxos.size >= 50) throw erroSeguro('META_CONEXAO_OCUPADA', 'Muitas autorizações abertas. Aguarde alguns minutos.', 429);
        const state = crypto.randomBytes(32).toString('base64url');
        fluxos.set(state, { sessao, c, expira: agora() + 600000 });
        const url = new URL(`https://www.facebook.com/${c.versao}/dialog/oauth`);
        url.search = new URLSearchParams({ client_id: c.appId, redirect_uri: c.redirect, config_id: c.configId, response_type: 'code', state, scope: ESCOPOS.join(',') }).toString();
        return { url: url.href };
    }
    /** Examina token, permissões e todas as páginas sem seguir URLs recebidas da API. */
    async function investigar(c, token) {
        const debug = (await graph(c, 'debug_token', `${c.appId}|${c.secret}`, { input_token: token })).data || {};
        if (!debug.is_valid) throw Object.assign(erroSeguro('META_AUTORIZACAO_FALHOU', 'Token inválido ou expirado. Reconecte com Facebook.', 401), { diagnostico: { estado: 'token_expirado' } });
        if (String(debug.app_id) !== c.appId || debug.type !== 'USER') throw erroSeguro('META_TOKEN_INCOMPATIVEL', 'Use uma configuração de Facebook Login para token de usuário do mesmo app. Token de Página, Instagram ou System User não serve para este fluxo.', 400);
        const permissoes = (await graph(c, 'me/permissions', token)).data || [];
        const concedidas = permissoes.filter(p => p.status === 'granted').map(p => p.permission);
        const faltantes = ESCOPOS.filter(p => !concedidas.includes(p));
        const paginas = []; let cursor;
        if (concedidas.includes('pages_show_list')) {
            for (let n = 0; n < 20; n++) {
                const lote = await graph(c, 'me/accounts', token, { fields: 'id,name,access_token,tasks', limit: '100', ...(cursor ? { after: cursor } : {}) });
                for (const p of lote.data || []) if (/^\d+$/.test(p.id) && typeof p.access_token === 'string') paginas.push({ id: p.id, name: String(p.name || p.id).slice(0, 200), access_token: p.access_token, tasks: Array.isArray(p.tasks) ? p.tasks.filter(t => typeof t === 'string') : [] });
                if (!lote.paging?.next) break;
                const proximo = lote.paging?.cursors?.after;
                if (n === 19 || !proximo || proximo === cursor) throw erroSeguro('META_LISTAGEM_INCOMPLETA', 'A listagem não foi concluída. Nenhuma seleção parcial foi aplicada.', 400);
                cursor = proximo;
            }
        }
        if (concedidas.includes('instagram_basic')) {
            for (const p of paginas) {
                try { const detalhe = await graph(c, p.id, p.access_token, { fields: 'instagram_business_account' }); p.instagramId = detalhe.instagram_business_account?.id || null; }
                catch { p.instagramId = null; }
            }
        }
        const diagnostico = { tipoToken: debug.type, appId: String(debug.app_id), appNome: typeof debug.application === 'string' ? debug.application.slice(0, 160) : null, produto: 'Facebook Login for Business · token de usuário', versao: c.versao, solicitadas: ESCOPOS, concedidas, faltantes, granularidade: (debug.granular_scopes || []).map(p => ({ permissao: p.scope, ativos: (p.target_ids || []).map(String) })), totalPaginas: paginas.length };
        return { token, paginas, appId: c.appId, versao: c.versao, expiraEm: Number(debug.expires_at || 0) * 1000, acessoExpiraEm: Number(debug.data_access_expires_at || 0) * 1000, diagnostico, verificadoEm: new Date(agora()).toISOString(), estado: faltantes.some(p => p !== 'instagram_basic') ? 'autorizacao_insuficiente' : paginas.length ? 'selecionar_pagina' : 'pagina_nao_encontrada', mensagem: paginas.length ? 'Escolha a Página autorizada. Selecionar não publica.' : 'A API não retornou páginas acessíveis. Confira permissões concedidas, ativos selecionados e atribuições no negócio. Modo do app e App Review ainda não verificados.' };
    }
    /** Consome o code uma única vez e mantém a integração antiga se a autorização falhar. */
    async function retorno(sessao, params, origem) {
        const fluxo = fluxos.get(params.state);
        if (!fluxo || fluxo.sessao !== sessao || fluxo.expira <= agora()) throw erroSeguro('META_STATE_INVALIDO', 'Autorização expirada ou de outra sessão. Inicie a conexão novamente.', 400);
        fluxos.delete(params.state);
        const atual = config(origem);
        if (JSON.stringify(atual) !== JSON.stringify(fluxo.c)) throw erroSeguro('META_STATE_INVALIDO', 'A configuração mudou durante a autorização. Reconecte.', 400);
        if (params.error || !params.code) throw erroSeguro('META_CONSENTIMENTO_NEGADO', 'A autorização foi cancelada ou não retornou um código.', 400);
        return exclusivo(async () => {
            const troca = await graph(atual, 'oauth/access_token', null, { client_id: atual.appId, client_secret: atual.secret, redirect_uri: atual.redirect, code: params.code });
            if (!troca.access_token) throw erroSeguro('META_AUTORIZACAO_FALHOU', 'A Meta não retornou um token.', 400);
            const duradouro = await graph(atual, 'oauth/access_token', null, { grant_type: 'fb_exchange_token', client_id: atual.appId, client_secret: atual.secret, fb_exchange_token: troca.access_token });
            if (!duradouro.access_token) throw erroSeguro('META_AUTORIZACAO_FALHOU', 'A troca por token duradouro não foi confirmada.', 400);
            const e = await investigar(atual, duradouro.access_token);
            // Não aplica token de Página até a escolha explícita do usuário.
            cofre.salvar(e);
            return status();
        });
    }
    /** Revalida conexão e permissões; expiração exige reconexão, não renovação prometida. */
    async function verificar() {
        return exclusivo(async () => {
            const salvo = cofre.ler();
            if (!salvo.token) return status();
            try {
                const c = configuracao();
                const e = await investigar(c, salvo.token);
                const pagina = e.paginas.find(p => p.id === salvo.selecionada?.id);
                if (pagina && e.estado === 'selecionar_pagina') { e.selecionada = pagina; e.estado = 'conectado'; e.mensagem = 'Página e permissões verificadas.'; }
                cofre.salvar(e);
            } catch (erro) {
                cofre.salvar({ ...salvo, estado: erro.diagnostico?.estado || 'erro_api', mensagem: erro.message, diagnostico: { ...salvo.diagnostico, ultimaFalha: erro.diagnostico || { estado: 'erro_api' } } });
            }
            return status();
        });
    }
    /** Testa a Página escolhida com seu token OAuth atual; realiza somente leituras na Meta. */
    async function testarPagina() {
        const salvo = cofre.ler();
        if (!salvo.token) throw erroSeguro('FACEBOOK_NAO_CONFIGURADO', 'Conecte com Facebook e selecione uma Página. Não copie tokens manualmente.', 403);
        const conexao = await verificar();
        if (conexao.estado !== 'conectado') throw erroSeguro('META_AUTORIZACAO_FALHOU', conexao.estado === 'selecionar_pagina' ? 'Selecione uma Página autorizada antes de testar.' : conexao.estado === 'autorizacao_insuficiente' ? `Permissões ausentes: ${(conexao.diagnostico?.faltantes || []).join(', ')}. Reconecte com Facebook.` : conexao.mensagem, 403);
        const e = cofre.ler();
        const perfil = await graph(configuracao(), e.selecionada.id, e.selecionada.access_token, { fields: 'id,name' });
        if (String(perfil.id) !== e.selecionada.id) throw erroSeguro('META_PAGINA_INVALIDA', 'A identidade retornada não corresponde à Página selecionada.', 403);
        return { id: String(perfil.id), name: String(perfil.name || '').slice(0, 200) };
    }
    /** Seleciona somente um ativo realmente recebido e confirma a identidade com token de Página. */
    async function selecionar(id) {
        return exclusivo(async () => {
            const e = cofre.ler();
            if (!['selecionar_pagina', 'conectado'].includes(status().estado) || e.appId !== configuracao().appId || e.diagnostico?.faltantes?.length) throw erroSeguro('META_AUTORIZACAO_FALHOU', 'Reconecte e conceda as permissões de Página necessárias.', 403);
            const pagina = (e.paginas || []).find(p => p.id === id);
            if (!pagina || !pagina.tasks.some(t => ['CREATE_CONTENT', 'MANAGE', 'PROFILE_PLUS_CREATE_CONTENT', 'PROFILE_PLUS_FULL_CONTROL'].includes(t))) throw erroSeguro('META_PAGINA_INVALIDA', 'Página não autorizada para criação de conteúdo nesta conexão.', 403);
            const perfil = await graph(configuracao(), pagina.id, pagina.access_token, { fields: 'id,name' });
            if (String(perfil.id) !== pagina.id) throw erroSeguro('META_PAGINA_INVALIDA', 'O token não confirmou a Página escolhida.', 403);
            await aoSelecionar(pagina, e.versao);
            cofre.salvar({ ...e, selecionada: pagina, estado: 'conectado', mensagem: 'Página selecionada. Revise e confirme cada publicação.' });
            return status();
        });
    }
    /** Desconecta localmente; revogação remota é uma ação explícita separada. */
    async function desconectar(revogar = false) {
        return exclusivo(async () => {
            const e = cofre.ler();
            if (revogar) {
                if (!e.token) throw erroSeguro('META_AUTORIZACAO_FALHOU', 'Sem token local para confirmar a revogação. Remova a autorização nas configurações do Facebook.', 400);
                const resultado = await graph(configuracao(), 'me/permissions', e.token, {}, 'DELETE');
                if (resultado.success !== true) throw erroSeguro('META_AUTORIZACAO_FALHOU', 'A Meta não confirmou a revogação. A conexão local foi preservada.', 400);
            }
            await aoDesconectar();
            cofre.salvar({ estado: 'desconectado', mensagem: revogar ? 'Permissões Facebook revogadas e conexão local removida.' : 'Desconectado localmente. A autorização na Meta permanece até revogação.' });
            fluxos.clear();
            return status();
        });
    }
    /** Bloqueia tokens OAuth vencidos ou sem permissão antes de publicar. */
    function exigirPublicacao(pageId) {
        const e = cofre.ler();
        if (e.estado === 'desconectado') throw erroSeguro('FACEBOOK_NAO_CONFIGURADO', 'Conecte novamente a Página.', 403);
        if (!e.token) return; // Compatibilidade avançada para instalações anteriores.
        if (status().estado !== 'conectado' || e.selecionada?.id !== pageId) throw erroSeguro('META_AUTORIZACAO_FALHOU', 'Verifique ou reconecte a Página selecionada antes de publicar.', 403);
    }
    return { iniciar, retorno, status, verificar, testarPagina, selecionar, desconectar, exigirPublicacao };
}
module.exports = { criarMetaConexaoService, ESCOPOS };
