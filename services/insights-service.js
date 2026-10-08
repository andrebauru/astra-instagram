'use strict';

/*
 * InsightsService — publicações anteriores (somente Instagram) e métricas
 * orgânicas com cache persistente. Não conhece anúncios.
 *
 * Fluxo: InstagramService.listarMidias()/insights() → normalização → cache em
 * arquivo → análise determinística (services/analise.js).
 */

const fs = require('node:fs');
const path = require('node:path');
const { analisarMelhoresHorarios } = require('./analise');

const PADRAO_PAGINA = 25;
const MAXIMO_PAGINA = 50;

function erroInsights(codigo, mensagem, status = 502) {
    return Object.assign(new Error(mensagem), { codigo, status });
}

/** Cache em arquivo com gravação atômica; falha de disco não derruba o serviço. */
function criarCacheArquivo(caminho) {
    return {
        carregar() {
            try {
                const dados = JSON.parse(fs.readFileSync(caminho, 'utf8'));
                return dados && typeof dados === 'object' && Array.isArray(dados.metricas) ? dados : { metricas: [] };
            } catch { return { metricas: [] }; }
        },
        salvar(estado) {
            try {
                fs.mkdirSync(path.dirname(caminho), { recursive: true });
                const temporario = `${caminho}.tmp`;
                fs.writeFileSync(temporario, JSON.stringify(estado), { encoding: 'utf8', mode: 0o600 });
                fs.renameSync(temporario, caminho);
                return true;
            } catch { return false; }
        }
    };
}

/** Formato do item de mídia conforme os campos realmente retornados. */
function formatoMidia(item) {
    const tipo = String(item?.media_type || '').toUpperCase();
    const produto = String(item?.media_product_type || item?.product_type || '').toUpperCase();
    if (tipo === 'CAROUSEL_ALBUM') return 'carrossel';
    if (tipo === 'VIDEO') return produto === 'REELS' ? 'reel' : 'video';
    if (tipo === 'IMAGE') return 'imagem';
    if (produto === 'REELS') return 'reel';
    if (Array.isArray(item?.children?.data) && item.children.data.length) return 'carrossel';
    return 'outro';
}

/** Converte timestamp em ISO sem fabricar datas. */
function paraISO(valor) {
    if (!valor) return null;
    const data = new Date(valor);
    return Number.isNaN(data.getTime()) ? null : data.toISOString();
}

/** Ordena fontes de miniatura da Meta sem acrescentar parâmetros ou credenciais. */
function fontesMiniatura(item) {
    const filhos = Array.isArray(item?.children?.data) ? item.children.data : [];
    const candidatos = [item?.thumbnail_url];
    for (const filho of filhos) candidatos.push(filho?.thumbnail_url, filho?.media_url);
    candidatos.push(item?.media_url);
    return [...new Set(candidatos.filter(valor => typeof valor === 'string' && /^https:\/\//i.test(valor)))];
}

/** Normaliza uma mídia retornada pela API do Instagram. */
function normalizarMidia(item) {
    if (!item?.id) return null;
    const miniaturas = fontesMiniatura(item);
    return {
        id: String(item.id),
        formato: formatoMidia(item),
        publicadoEm: paraISO(item.timestamp),
        legenda: typeof item.caption === 'string' ? item.caption : '',
        miniatura: miniaturas[0] || null,
        miniaturas,
        permalink: typeof item.permalink === 'string' ? item.permalink : '',
        mediaType: item.media_type || null,
        productType: item.media_product_type || item.product_type || null
    };
}

/** Normaliza métricas orgânicas preservando ausência como null. */
function normalizarMetricas(dados = {}, midia = {}) {
    const numero = valor => (valor === null || valor === undefined || valor === '' || !Number.isFinite(Number(valor))) ? null : Number(valor);
    return {
        mediaId: String(midia.id || dados.id || ''),
        formato: midia.formato || null,
        publicadoEm: midia.publicadoEm || paraISO(dados.timestamp),
        permalink: midia.permalink || '',
        source: 'organic',
        likes: numero(dados.like_count),
        comments: numero(dados.comments_count),
        reach: numero(dados.reach),
        impressions: numero(dados.impressions),
        saves: numero(dados.saved),
        shares: numero(dados.shares),
        videoViews: numero(dados.video_views),
        interactions: numero(dados.total_interactions),
        capturedAt: dados.capturedAt || new Date().toISOString()
    };
}

function criarInsightsService({ instagram, caminhoCache, agora = Date.now } = {}) {
    if (!instagram) throw new Error('InsightsService exige o InstagramService.');
    const cache = criarCacheArquivo(caminhoCache || path.join(process.cwd(), 'dados', 'metricas-organicas.json'));
    let estado = cache.carregar();
    if (!Array.isArray(estado.metricas)) estado.metricas = [];

    function persistir() { return cache.salvar(estado); }

    /** Lista publicações anteriores com paginação por cursor. */
    async function listarMidias({ limite, cursor } = {}) {
        const tamanho = Math.min(MAXIMO_PAGINA, Math.max(1, Number(limite) || PADRAO_PAGINA));
        const resposta = await instagram.listarMidias({ limite: tamanho, cursor: cursor || null });
        const itens = (Array.isArray(resposta?.itens) ? resposta.itens : []).map(normalizarMidia).filter(Boolean);
        return { itens, proximoCursor: resposta?.proximoCursor || null, limite: tamanho };
    }

    function acharMetrica(mediaId) { return estado.metricas.find(item => item.mediaId === mediaId) || null; }

    /** Consulta os insights orgânicos de uma mídia e atualiza o cache. */
    async function atualizarMetrica(midia) {
        const dados = await instagram.insights(midia.id);
        const metrica = normalizarMetricas(dados, midia);
        const existente = acharMetrica(metrica.mediaId);
        if (existente) Object.assign(existente, metrica);
        else estado.metricas.push(metrica);
        persistir();
        return metrica;
    }

    /**
     * Atualiza métricas com cache: sem `forcar`, reconsulta apenas o que ainda
     * não tem métrica ou está mais antigo que `validadeMs`.
     */
    async function atualizarMetricas(midias = [], { forcar = false, validadeMs = 6 * 3600000 } = {}) {
        const resultado = { atualizadas: 0, ignoradas: 0, falhas: [] };
        for (const midia of midias) {
            const existente = acharMetrica(midia.id);
            const recente = existente && (agora() - Date.parse(existente.capturedAt || 0)) < validadeMs;
            if (recente && !forcar) { resultado.ignoradas += 1; continue; }
            try { await atualizarMetrica(midia); resultado.atualizadas += 1; }
            catch (erro) { resultado.falhas.push({ mediaId: midia.id, codigo: erro.codigo || 'INSIGHTS_FALHA', mensagem: erro.message }); }
        }
        return resultado;
    }

    /** Análise determinística sobre o cache orgânico. */
    function analisar({ timezone } = {}) {
        return analisarMelhoresHorarios(estado.metricas, { timezone });
    }

    function metricas() { return estado.metricas.slice(); }

    /**
     * Registra uma publicação nova no cache (sem métricas ainda) para que o
     * módulo de desempenho possa consultá-la depois, quando os dados existirem.
     */
    function registrarPublicacaoMidia(midia) {
        if (!midia?.id || !/^[A-Za-z0-9_.-]{1,200}$/.test(String(midia.id))) return null;
        const existente = acharMetrica(midia.id);
        if (existente) {
            Object.assign(existente, { formato: midia.formato || existente.formato, publicadoEm: midia.publicadoEm || existente.publicadoEm, permalink: midia.permalink || existente.permalink });
            persistir();
            return existente;
        }
        const registro = normalizarMetricas({}, { id: midia.id, formato: midia.formato, publicadoEm: midia.publicadoEm, permalink: midia.permalink });
        registro.capturedAt = null; // sem métricas consultadas ainda
        estado.metricas.push(registro);
        persistir();
        return registro;
    }

    return { listarMidias, atualizarMetricas, atualizarMetrica, analisar, metricas, registrarPublicacaoMidia, _estado: () => estado };
}

module.exports = { criarInsightsService, normalizarMidia, normalizarMetricas, formatoMidia, fontesMiniatura, criarCacheArquivo, PADRAO_PAGINA, MAXIMO_PAGINA };
