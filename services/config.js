'use strict';

/*
 * Configuração central do Astra.
 *
 * Fonte única das variáveis de ambiente, do modelo de IA e do timezone padrão.
 * Nenhum segredo é impresso, devolvido ao navegador ou gravado em log.
 */

const path = require('node:path');

const RAIZ = path.resolve(__dirname, '..');
const { criarStoreIntegracoes } = require('./integracoes-store');
const storeIntegracoes = criarStoreIntegracoes(process.env.ASTRA_INTEGRACOES_ARQUIVO || path.join(RAIZ, 'dados', 'integracoes.json'));
storeIntegracoes.carregar();

/** Modelo padrão do Astra via OpenRouter; permanece configurável. */
const MODELO_PADRAO = 'z-ai/glm-5.3-flash';

/** Timezone IANA padrão de todo o fluxo (agenda, itens e persistência). */
const TIMEZONE_PADRAO = 'Asia/Tokyo';

function lerInteiro(valor, padrao) {
    const numero = Number(valor);
    return Number.isFinite(numero) && numero > 0 ? numero : padrao;
}

const config = {
    porta: lerInteiro(process.env.PORT, 8080),
    build: process.env.ASTRA_BUILD_ID || 'astra-instagram-1.1.0',

    instagram: Object.freeze({
        token: process.env.INSTAGRAM_ACCESS_TOKEN || '',
        accountId: process.env.INSTAGRAM_ACCOUNT_ID || '',
        baseUrl: (process.env.META_GRAPH_BASE_URL || 'https://graph.instagram.com').replace(/\/$/, ''),
        versao: process.env.META_GRAPH_VERSION || ''
    }),

    ia: Object.freeze({
        chave: process.env.OPENROUTER_API_KEY || '',
        // OPENROUTER_MODEL é a configuração central; ASTRA_MODEL é aceito como
        // compatibilidade e o padrão documentado cobre instalações novas.
        modelo: process.env.OPENROUTER_MODEL || process.env.ASTRA_MODEL || MODELO_PADRAO,
        endpoint: 'https://openrouter.ai/api/v1/chat/completions',
        catalogoUrl: 'https://openrouter.ai/api/v1/models',
        timeoutMs: lerInteiro(process.env.OPENROUTER_TIMEOUT_MS, 90000)
    }),

    midia: Object.freeze({
        uploadUrl: process.env.MEDIA_UPLOAD_URL || '',
        uploadKey: process.env.MEDIA_UPLOAD_KEY || '',
        basePublicaUrl: process.env.MEDIA_PUBLIC_BASE_URL || '',
        verificacaoTimeoutMs: lerInteiro(process.env.MEDIA_PUBLIC_VERIFY_TIMEOUT_MS, 30000),
        uploadTimeoutMs: lerInteiro(process.env.MEDIA_UPLOAD_TIMEOUT_MS, 600000)
    }),

    timezone: TIMEZONE_PADRAO,

    arquivos: Object.freeze({
        empresa: process.env.ASTRA_EMPRESA_ARQUIVO || path.join(RAIZ, 'dados', 'empresa.json'),
        templates: process.env.ASTRA_TEMPLATES_ARQUIVO || path.join(RAIZ, 'dados', 'templates.json'),
        publicacoes: process.env.ASTRA_PUBLICACOES_ARQUIVO || path.join(RAIZ, 'dados', 'publicacoes.json'),
        publicacoesMeta: process.env.ASTRA_PUBLICACOES_META_ARQUIVO || path.join(RAIZ, 'dados', 'publicacoes-meta.json'),
        agendador: process.env.ASTRA_AGENDADOR_ARQUIVO || path.join(RAIZ, 'dados', 'agendamentos.json'),
        metricas: process.env.ASTRA_METRICAS_ARQUIVO || path.join(RAIZ, 'dados', 'metricas-organicas.json')
    })
};

/** Aplica as credenciais salvas sem reiniciar o processo. */
function recarregarIntegracoes() {
    config.instagram = { ...config.instagram, token: process.env.INSTAGRAM_ACCESS_TOKEN || '', accountId: process.env.INSTAGRAM_ACCOUNT_ID || '', versao: process.env.META_GRAPH_VERSION || '' };
    config.ia = { ...config.ia, chave: process.env.OPENROUTER_API_KEY || '' };
    config.facebook = { pageId: process.env.FACEBOOK_PAGE_ID || '', token: process.env.FACEBOOK_PAGE_ACCESS_TOKEN || '', versao: process.env.FACEBOOK_GRAPH_VERSION || process.env.META_GRAPH_VERSION || '' };
}
recarregarIntegracoes();

/** Indica quais integrações estão prontas, sem revelar valores. */
function capacidades() {
    return {
        instagram: Boolean(config.instagram.token),
        ia: Boolean(config.ia.chave),
        midia: Boolean(config.midia.uploadUrl && config.midia.uploadKey)
    };
}

module.exports = { config, capacidades, MODELO_PADRAO, TIMEZONE_PADRAO, storeIntegracoes, recarregarIntegracoes };
