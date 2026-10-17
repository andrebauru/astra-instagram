'use strict';

/*
 * MediaService — recebe, valida e armazena mídia, devolvendo uma URL HTTPS pública.
 *
 * O InstagramService nunca armazena arquivos: apenas consome a URL pública
 * produzida aqui. A validação síncrona de host e a verificação assíncrona de
 * Content-Type vivem em `rede-publica.js`/`midia-publica.js`, reutilizadas sem
 * duplicar regras.
 */

const {
    LIMITE_IMAGEM,
    LIMITE_VIDEO,
    decodificarImagem,
    decodificarMidia,
    criarServicoMidiaPublica,
    normalizarUrlPublica,
    normalizarUrlConfigurada
} = require('../midia-publica');
const { verificarUrlPublica, hostPublico } = require('../rede-publica');

function criarMediaService({ midia, fetchImpl, resolverIPs } = {}) {
    const configuracao = midia || {};
    // Resolve o transporte a cada chamada para permitir injeção (testes) sem captura.
    const transporte = () => fetchImpl || globalThis.fetch;
    const servico = criarServicoMidiaPublica({
        uploadUrl: configuracao.uploadUrl,
        basePublicaUrl: configuracao.basePublicaUrl,
        uploadKey: configuracao.uploadKey,
        prazoVerificacao: configuracao.verificacaoTimeoutMs,
        prazoUpload: configuracao.uploadTimeoutMs,
        fetchImpl: (...args) => transporte()(...args),
        resolverIPs
    });

    /** Capacidades reais do armazenamento configurado. */
    function capacidades() {
        return servico.capacidades();
    }

    /** Envia uma imagem em base64 para o armazenamento e retorna metadados. */
    async function enviar({ dados, mime, nome }) {
        return servico.publicar({ dados, mime, nome });
    }

    /** Confirma que uma URL HTTPS pública responde com uma mídia aceita. */
    async function verificar(url) {
        return verificarUrlPublica(url, {
            transporte: (...args) => transporte()(...args),
            resolverIPs,
            tiposAceitos: ['image/jpeg', 'image/png', 'image/webp', 'video/mp4']
        });
    }

    return {
        capacidades,
        enviar,
        verificar,
        // Utilidades reutilizadas por rotas e testes.
        limiteBytes: LIMITE_IMAGEM,
        limiteVideoBytes: LIMITE_VIDEO,
        decodificarImagem,
        decodificarMidia,
        normalizarUrlPublica,
        normalizarUrlConfigurada,
        hostPublico
    };
}

module.exports = { criarMediaService };
