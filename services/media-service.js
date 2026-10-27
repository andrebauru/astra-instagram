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

    /** Percorre o inventário remoto autenticado sem expor a chave ao navegador. */
    async function listarInventario() {
        if (!configuracao.inventarioUrl || !configuracao.uploadKey) {
            const erro = new Error('Configure MEDIA_INVENTORY_URL e MEDIA_UPLOAD_KEY para sincronizar mídias.');
            erro.code = 'MIDIA_INVENTARIO_NAO_CONFIGURADO'; erro.status = 503; throw erro;
        }
        const origem = new URL(configuracao.inventarioUrl);
        if (origem.protocol !== 'https:') throw Object.assign(new Error('O inventário de mídias deve usar HTTPS.'), { code: 'MIDIA_INVENTARIO_URL_INVALIDA', status: 400 });
        const basePublica = configuracao.basePublicaUrl ? new URL(configuracao.basePublicaUrl) : null;
        const itens = [];
        let cursor = '';
        for (let pagina = 0; pagina < 100; pagina += 1) {
            const url = new URL(origem);
            url.searchParams.set('limit', '100');
            if (cursor) url.searchParams.set('cursor', cursor);
            const resposta = await transporte()(url, { headers: { 'X-Astra-Key': configuracao.uploadKey }, signal: AbortSignal.timeout(configuracao.verificacaoTimeoutMs || 30000) });
            if (!resposta.ok) throw Object.assign(new Error(`O inventário remoto respondeu HTTP ${resposta.status}.`), { code: 'MIDIA_INVENTARIO_FALHOU', status: 502 });
            const dados = await resposta.json().catch(() => null);
            if (!dados || !Array.isArray(dados.items)) throw Object.assign(new Error('O inventário remoto devolveu um formato inválido.'), { code: 'MIDIA_INVENTARIO_INVALIDO', status: 502 });
            for (const item of dados.items) {
                if (!item || typeof item.url !== 'string') continue;
                const urlItem = new URL(item.url);
                if (urlItem.protocol !== 'https:' || (basePublica && (urlItem.origin !== basePublica.origin || !urlItem.pathname.startsWith(basePublica.pathname)))) {
                    throw Object.assign(new Error('O inventário devolveu uma URL fora da base pública autorizada.'), { code: 'MIDIA_INVENTARIO_URL_INVALIDA', status: 502 });
                }
                itens.push(item);
            }
            cursor = typeof dados.next_cursor === 'string' ? dados.next_cursor : '';
            if (!cursor) return itens;
        }
        throw Object.assign(new Error('O inventário remoto excedeu o limite seguro de páginas.'), { code: 'MIDIA_INVENTARIO_PAGINACAO', status: 502 });
    }

    return {
        capacidades,
        enviar,
        verificar,
        listarInventario,
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
