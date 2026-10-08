'use strict';

/*
 * InstagramService — única camada que fala com a API do Instagram.
 *
 * Publicação imediata e agendamento chamam exatamente `publish()`. Não existe
 * caminho alternativo de publicação. Suporta imagem, Reel e carrossel e está
 * preparado para Story quando a integração informar o parâmetro correto.
 */

const { erroSeguro } = require('../bridge-seguranca');
const { urlPublica } = require('../painel-meta-prototipo/integracao-regras');

const FORMATOS_SUPORTADOS = ['imagem', 'reel', 'carrossel'];

function criarInstagramService({
    token,
    accountId,
    baseUrl,
    versao = '',
    registrar = () => {},
    contexto = () => ({}),
    fetchImpl,
    esperar = ms => new Promise(resolve => setTimeout(resolve, ms))
} = {}) {
    if (!token) throw new Error('InstagramService exige INSTAGRAM_ACCESS_TOKEN.');
    // Resolve o transporte a cada chamada para permitir injeção (testes) sem captura.
    const transporte = () => fetchImpl || globalThis.fetch;

    const conta = accountId || 'me';
    const base = versao ? `${baseUrl.replace(/\/$/, '')}/${versao}` : baseUrl.replace(/\/$/, '');

    /** Requisição autenticada à API do Instagram com erros seguros. */
    async function request(caminho, method = 'GET', params = {}, operacao = 'instagram_request') {
        const inicio = Date.now();
        const ctx = contexto() || {};
        const url = new URL(`${base}/${String(caminho).replace(/^\//, '')}`);

        const opcoes = { method, signal: AbortSignal.timeout(15000) };
        if (method === 'GET') {
            for (const [chave, valor] of Object.entries(params)) if (valor !== undefined && valor !== null) url.searchParams.set(chave, String(valor));
            url.searchParams.set('access_token', token);
        } else {
            const corpo = new URLSearchParams();
            for (const [chave, valor] of Object.entries(params)) if (valor !== undefined && valor !== null) corpo.set(chave, String(valor));
            corpo.set('access_token', token);
            opcoes.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
            opcoes.body = corpo.toString();
        }

        let resposta;
        try { resposta = await transporte()(url, opcoes); }
        catch {
            registrar('META', 'request_failed', { operacao, requestId: ctx.requestId || null, operationId: ctx.operationId || null, durationMs: Date.now() - inicio, result: 'falhou', errorCode: 'META_CONEXAO' });
            throw erroSeguro('META_CONEXAO', 'Falha de conexão com a Meta. Se houve envio, confira o Instagram antes de tentar novamente.');
        }

        const texto = await resposta.text();
        let dados;
        try { dados = JSON.parse(texto); }
        catch {
            registrar('META', 'invalid_response', { operacao, requestId: ctx.requestId || null, operationId: ctx.operationId || null, httpStatus: resposta.status, result: 'falhou', errorCode: 'META_RESPOSTA_INVALIDA' });
            throw erroSeguro('META_RESPOSTA_INVALIDA', 'A Meta retornou uma resposta inválida.');
        }

        if (!resposta.ok) {
            const erro = dados?.error && typeof dados.error === 'object' ? dados.error : {};
            const codigoMeta = Number(erro.code) || 0;
            const autenticacao = resposta.status === 401 || codigoMeta === 190 || codigoMeta === 102;
            const permissao = [10, 200, 2000].includes(codigoMeta) || resposta.status === 403;
            const limite = [4, 17, 32, 613].includes(codigoMeta) || resposta.status === 429;
            const codigo = autenticacao ? 'INSTAGRAM_NAO_AUTENTICADO' : permissao ? 'META_PERMISSAO' : limite ? 'META_LIMITE' : 'META_RECUSOU';
            const detalhe = {
                etapa: operacao, status: resposta.status, code: codigoMeta,
                subcode: erro.error_subcode ?? null, type: erro.type || null,
                message: erro.message || null, user_title: erro.error_user_title || null,
                user_message: erro.error_user_msg || null, fbtrace_id: erro.fbtrace_id || null
            };
            registrar('META', 'request_rejected', { operacao, httpStatus: resposta.status, metaCode: codigoMeta, metaSubcode: detalhe.subcode, durationMs: Date.now() - inicio, result: 'falhou', errorCode: codigo });
            throw Object.assign(erroSeguro(codigo, erro.error_user_msg || erro.message || 'A Meta recusou a solicitação.', autenticacao ? 401 : permissao ? 403 : limite ? 429 : 502), { metaCode: codigoMeta, metaSubcode: detalhe.subcode, metaUserTitle: detalhe.user_title, metaUserMessage: detalhe.user_message, metaDetalhe: detalhe });
        }

        registrar('META', 'request_success', { operacao, httpStatus: resposta.status, durationMs: Date.now() - inicio, result: 'sucesso' });
        return dados;
    }

    /** Perfil profissional usado para confirmar a conexão. */
    async function perfil() {
        return request('me', 'GET', { fields: 'id,username,account_type,media_count' }, 'instagram_profile');
    }

    const CAMPOS_MIDIA = 'id,caption,timestamp,media_type,media_url,thumbnail_url,permalink,media_product_type,children{id,media_type,media_url,thumbnail_url,timestamp,media_product_type}';

    /** Lista publicações anteriores do Instagram com paginação por cursor. */
    async function listarMidias({ limite = 25, cursor = null } = {}) {
        const host = (() => { try { return new URL(base).hostname; } catch { return ''; } })();
        const caminho = host === 'graph.instagram.com' ? 'me/media' : `${conta}/media`;
        const resposta = await request(caminho, 'GET', {
            fields: CAMPOS_MIDIA,
            limit: Math.min(100, Math.max(1, Number(limite) || 25)),
            ...(cursor ? { after: cursor } : {})
        }, 'instagram_list_media');
        const itens = Array.isArray(resposta?.data) ? resposta.data.filter(item => item?.id).map(item => ({
            id: String(item.id),
            caption: item.caption,
            timestamp: item.timestamp,
            media_type: item.media_type,
            media_product_type: item.media_product_type,
            media_url: item.media_url,
            thumbnail_url: item.thumbnail_url,
            permalink: item.permalink,
            children: item.children
        })) : [];
        const proximoCursor = resposta?.paging?.next ? (resposta.paging.cursors?.after || resposta.paging.cursors?.before || null) : null;
        return { itens, proximoCursor };
    }

    /** Lê insights orgânicos de uma mídia; métricas ausentes permanecem ausentes. */
    async function insights(mediaId) {
        if (!/^[A-Za-z0-9_.-]{1,200}$/.test(String(mediaId || ''))) throw erroSeguro('METRICA_ID_INVALIDO', 'Informe um ID de mídia válido.', 400);
        const comInsights = 'id,timestamp,like_count,comments_count,media_type,insights.metric(reach,impressions,saved,shares,total_interactions,video_views)';
        let dados;
        try {
            dados = await request(mediaId, 'GET', { fields: comInsights }, 'instagram_media_insights');
        } catch (erro) {
            // A conta pode não expor uma métrica; recua para as contagens básicas.
            if (!['META_RECUSOU', 'META_CONFIGURACAO_INVALIDA'].includes(erro.codigo)) throw erro;
            dados = await request(mediaId, 'GET', { fields: 'id,timestamp,like_count,comments_count,media_type' }, 'instagram_media_basico');
        }
        const mapa = Object.fromEntries((dados?.insights?.data || []).map(item => [item.name, item.values?.at(-1)?.value ?? item.value ?? null]));
        return {
            id: dados?.id || mediaId,
            timestamp: dados?.timestamp,
            like_count: dados?.like_count,
            comments_count: dados?.comments_count,
            media_type: dados?.media_type,
            reach: mapa.reach ?? null,
            impressions: mapa.impressions ?? null,
            saved: mapa.saved ?? null,
            shares: mapa.shares ?? null,
            total_interactions: mapa.total_interactions ?? null,
            video_views: mapa.video_views ?? null
        };
    }

    /** Traduz uma falha real da Meta em um código específico da publicação. */
    function classificarErro(erro, padrao) {
        if (['INSTAGRAM_NAO_AUTENTICADO'].includes(erro.codigo)) return Object.assign(erroSeguro('INSTAGRAM_TOKEN_INVALIDO', erro.message, 401), { metaDetalhe: erro.metaDetalhe });
        if (['INSTAGRAM_MEDIA_INVALIDA', 'INSTAGRAM_URL_INACESSIVEL', 'INSTAGRAM_CONTAINER_FALHOU', 'INSTAGRAM_PUBLICACAO_FALHOU', 'INSTAGRAM_TOKEN_INVALIDO', 'META_LIMITE', 'META_CONEXAO'].includes(erro.codigo)) return erro;
        const mensagem = `${erro.metaUserMessage || ''} ${erro.metaUserTitle || ''} ${erro.message || ''}`.toLowerCase();
        const inacessivel = /url|image_url|video_url|inacess|acess|download|fetch|media/.test(mensagem) || [9004, 36003, 352, 2207001, 2207002].includes(erro.metaSubcode);
        return Object.assign(erroSeguro(inacessivel ? 'INSTAGRAM_URL_INACESSIVEL' : padrao, erro.message, erro.status || 502), { metaDetalhe: erro.metaDetalhe });
    }

    async function criarContainer(padrao, executar) {
        try { return await executar(); }
        catch (erro) { throw classificarErro(erro, padrao); }
    }

    async function publicarContainer(containerId) {
        try {
            const publicado = await request(`${conta}/media_publish`, 'POST', { creation_id: containerId }, 'publish_container');
            if (!publicado?.id) throw erroSeguro('INSTAGRAM_PUBLICACAO_FALHOU', 'A Meta não confirmou o identificador final da publicação.');
            return publicado;
        } catch (erro) {
            if (erro.codigo === 'INSTAGRAM_PUBLICACAO_FALHOU') throw erro;
            throw classificarErro(erro, 'INSTAGRAM_PUBLICACAO_FALHOU');
        }
    }

    async function statusContainer(containerId) {
        return request(containerId, 'GET', { fields: 'status_code,status' }, 'container_status');
    }

    /** Aguarda o processamento (Reel/vídeo) antes de publicar. */
    async function aguardarContainer(containerId, maxTentativas = 30) {
        const prazo = Date.now() + 180000;
        for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
            if (Date.now() >= prazo) break;
            const status = await statusContainer(containerId);
            if (status.status_code === 'FINISHED') return status;
            if (status.status_code === 'ERROR' || status.status_code === 'EXPIRED') throw erroSeguro('REEL_PROCESSAMENTO', 'Falha de processamento do vídeo. Verifique o formato e a disponibilidade do arquivo.');
            await esperar(5000);
        }
        throw erroSeguro('REEL_TEMPO_ESGOTADO', 'O vídeo não terminou de processar no prazo. Nenhuma publicação foi solicitada para este container.', 504);
    }

    async function criarImagem(url, legenda) {
        return request(`${conta}/media`, 'POST', { image_url: url, caption: legenda }, 'create_image_container');
    }

    async function criarReel(url, legenda) {
        return request(`${conta}/media`, 'POST', { media_type: 'REELS', video_url: url, caption: legenda }, 'create_reel_container');
    }

    async function criarItemCarrossel({ imageUrl, videoUrl }) {
        const params = { is_carousel_item: true };
        if (videoUrl) { params.media_type = 'VIDEO'; params.video_url = videoUrl; }
        else params.image_url = imageUrl;
        return request(`${conta}/media`, 'POST', params, 'create_carousel_item');
    }

    /**
     * Publica um conteúdo no Instagram.
     *
     * @param {object} entrada
     * @param {'imagem'|'reel'|'carrossel'} entrada.formato
     * @param {string} [entrada.mediaUrl] URL pública genérica
     * @param {string} [entrada.imageUrl] URL pública de imagem
     * @param {string} [entrada.videoUrl] URL pública de vídeo
     * @param {Array<{tipo:string,url:string}>} [entrada.itens] itens do carrossel
     * @param {string} [entrada.caption]
     * @param {string} [entrada.publicacaoId] correlaciona diagnóstico
     */
    async function publish({ formato, mediaUrl, imageUrl, videoUrl, itens, caption, publicacaoId = null } = {}) {
        const legenda = typeof caption === 'string' ? caption : '';
        const tipo = formato === 'reel' ? 'reel' : formato === 'carrossel' ? 'carrossel' : formato === 'story' ? 'story' : 'imagem';
        registrar('PUBLISH', 'publish_started', { operacao: tipo, publication: publicacaoId, formato: tipo, result: 'salvando localmente' });

        if (tipo === 'carrossel') {
            const lista = Array.isArray(itens) ? itens : [];
            if (lista.length < 2 || lista.length > 20 || lista.some(item => !item?.url || !urlPublica(item.url))) {
                throw erroSeguro('INSTAGRAM_MEDIA_INVALIDA', 'Informe de 2 a 20 itens com URL HTTPS pública acessível.', 400);
            }
            const filhos = [];
            for (const item of lista) {
                const formatoItem = item.tipo === 'video' ? 'video' : 'imagem';
                const container = await criarContainer('INSTAGRAM_CONTAINER_FALHOU', () => formatoItem === 'video'
                    ? criarItemCarrossel({ videoUrl: item.url })
                    : criarItemCarrossel({ imageUrl: item.url }));
                if (!container?.id) throw erroSeguro('INSTAGRAM_CONTAINER_FALHOU', 'A Meta não retornou o identificador de um item do carrossel.');
                if (formatoItem === 'video') await aguardarContainer(container.id);
                filhos.push(container.id);
            }
            const pai = await criarContainer('INSTAGRAM_CONTAINER_FALHOU', () => request(`${conta}/media`, 'POST', { media_type: 'CAROUSEL', children: filhos.join(','), caption: legenda }, 'create_carousel_container'));
            if (!pai?.id) throw erroSeguro('INSTAGRAM_CONTAINER_FALHOU', 'A Meta não retornou o identificador do carrossel.');
            await aguardarContainer(pai.id);
            const publicado = await publicarContainer(pai.id);
            registrar('PUBLISH', 'publish_confirmed', { operacao: tipo, publication: publicacaoId, metaMediaId: publicado.id, result: 'publicação confirmada' });
            return { mediaId: String(publicado.id), containerId: pai.id, formato: tipo, publicadoEm: new Date().toISOString() };
        }

        const url = tipo === 'reel' ? (videoUrl || mediaUrl) : (imageUrl || mediaUrl);
        if (typeof url !== 'string' || !urlPublica(url)) {
            throw erroSeguro('INSTAGRAM_MEDIA_INVALIDA', 'A mídia precisa de uma URL HTTPS pública acessível por servidor externo.', 400);
        }
        const container = await criarContainer('INSTAGRAM_CONTAINER_FALHOU', () => tipo === 'reel' ? criarReel(url, legenda) : criarImagem(url, legenda));
        if (!container?.id) throw erroSeguro('INSTAGRAM_CONTAINER_FALHOU', 'A Meta não retornou o identificador da mídia.');
        if (tipo === 'reel') await aguardarContainer(container.id);
        const publicado = await publicarContainer(container.id);
        registrar('PUBLISH', 'publish_confirmed', { operacao: tipo, publication: publicacaoId, metaMediaId: publicado.id, result: 'publicação confirmada' });
        return { mediaId: String(publicado.id), containerId: container.id, formato: tipo, publicadoEm: new Date().toISOString() };
    }

    return { perfil, publish, listarMidias, insights, request, statusContainer, aguardarContainer, FORMATOS_SUPORTADOS };
}

module.exports = { criarInstagramService, FORMATOS_SUPORTADOS };
