'use strict';
const { erroSeguro } = require('../bridge-seguranca');
const { criarCofreLocal } = require('./cofre-local');
const CAMPOS = ['META_APP_ID', 'META_APP_SECRET', 'META_LOGIN_CONFIG_ID', 'META_REDIRECT_URI', 'FACEBOOK_GRAPH_VERSION', 'INSTAGRAM_ACCOUNT_ID', 'INSTAGRAM_ACCESS_TOKEN', 'FACEBOOK_PAGE_ID', 'FACEBOOK_PAGE_ACCESS_TOKEN', 'OPENROUTER_API_KEY', 'META_GRAPH_VERSION'];
const SECRETOS = ['META_APP_SECRET', 'INSTAGRAM_ACCESS_TOKEN', 'FACEBOOK_PAGE_ACCESS_TOKEN', 'OPENROUTER_API_KEY'];

/** Persiste configurações privadas sem devolver os segredos ao painel. */
function criarStoreIntegracoes(caminho, opcoes = {}) {
    const cofre = criarCofreLocal(caminho, opcoes);
    /** Lê somente o arquivo privado de sobreposições locais. */
    function ler() {
        try {
            const dados = cofre.ler();
            if (!dados || typeof dados !== 'object' || Array.isArray(dados)) throw new Error();
            return Object.fromEntries(CAMPOS.filter(campo => typeof dados[campo] === 'string').map(campo => [campo, dados[campo]]));
        }
        catch (erro) { if (erro.code === 'ENOENT') return {}; throw new Error('Não foi possível ler as configurações locais.'); }
    }
    /** Sobrepõe somente campos salvos; demais valores continuam vindos do .env. */
    function carregar() {
        const dados = ler();
        for (const campo of CAMPOS) if (typeof dados[campo] === 'string') process.env[campo] = dados[campo];
    }
    /** Substitui cada segredo por um indicador de presença. */
    function publico() {
        return Object.fromEntries(CAMPOS.map(campo => [campo, SECRETOS.includes(campo) ? Boolean(process.env[campo]) : process.env[campo] || '']));
    }
    /** Valida a lista permitida e grava atomicamente sem alterar o .env. */
    function salvar(entrada) {
        if (!entrada || typeof entrada !== 'object' || Array.isArray(entrada)) throw erroSeguro('CONFIG_INVALIDA', 'Configuração inválida.', 400);
        const dados = ler();
        for (const campo of Object.keys(entrada)) {
            if (!CAMPOS.includes(campo) || typeof entrada[campo] !== 'string') throw erroSeguro('CONFIG_INVALIDA', 'Campo de configuração inválido.', 400);
            const valor = entrada[campo].trim();
            if (SECRETOS.includes(campo) && !valor) continue;
            if (valor.length > 4096 || /[\r\n\0]/.test(valor)) throw erroSeguro('CONFIG_INVALIDA', 'Valor de configuração inválido.', 400);
            if (campo.endsWith('_ID') && valor && !/^\d+$/.test(valor)) throw erroSeguro('CONFIG_INVALIDA', 'Os IDs devem conter somente números.', 400);
            if (campo.endsWith('GRAPH_VERSION') && valor && !/^v\d+\.\d+$/.test(valor)) throw erroSeguro('CONFIG_INVALIDA', 'Informe a versão da API no formato vN.N.', 400);
            if (campo === 'META_REDIRECT_URI' && valor) {
                let url; try { url = new URL(valor); } catch { throw erroSeguro('CONFIG_INVALIDA', 'URI de retorno inválida.', 400); }
                if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.protocol !== 'http:' || url.pathname !== '/meta/oauth/retorno' || url.search || url.hash || url.username || url.password) throw erroSeguro('CONFIG_INVALIDA', 'Esta instalação local exige http://localhost:PORTA/meta/oauth/retorno ou 127.0.0.1. Não use servidor de mídia como callback.', 400);
            }
            dados[campo] = valor;
        }
        cofre.salvar(dados);
        carregar();
        return publico();
    }
    /** Persiste a desconexão Facebook inclusive quando existe configuração legada no .env. */
    function limparFacebook() {
        const dados = ler();
        dados.FACEBOOK_PAGE_ID = ''; dados.FACEBOOK_PAGE_ACCESS_TOKEN = '';
        cofre.salvar(dados); carregar();
    }
    return { carregar, publico, salvar, limparFacebook };
}
module.exports = { criarStoreIntegracoes, SECRETOS };
