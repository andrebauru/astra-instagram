'use strict';

/*
 * Modelo do conteúdo e migração idempotente.
 *
 * Campos fora do escopo atual (publicidade, métricas e audiência) foram
 * removidos do modelo. A migração acrescenta apenas os campos atuais, sem
 * apagar dados existentes.
 */

/** Acrescenta campos novos sem descartar conteúdos já salvos. */
function migrarPublicacao(p) {
    p.versao = 2;
    p.criadaEm ??= null;
    p.tipoMidia ??= 'imagem';
    p.imagemUrl ??= ''; p.videoUrl ??= '';
    p.tema ??= ''; p.fatos ??= ''; p.fatosIa ??= ''; p.textoMidia ??= ''; p.contexto ??= ''; p.objetivo ??= '';
    p.legenda ??= '';
    p.hashtags ??= ''; p.palavras ??= ''; p.ideias ??= '';
    p.revisoes ??= [];
    p.local ??= ''; p.maps ??= ''; p.site1 ??= ''; p.site2 ??= '';
    p.incluir ??= { local: false, maps: false, site1: false, site2: false };
    p.incluir = { local: p.incluir.local === true, maps: p.incluir.maps === true, site1: p.incluir.site1 === true, site2: p.incluir.site2 === true };
    p.fuso ??= 'Asia/Tokyo';
    p.estado ??= 'rascunho';
    p.imagens = (Array.isArray(p.imagens) ? p.imagens : []).map(item => ({
        id: item.id || globalThis.crypto?.randomUUID?.() || `midia-${Date.now()}`,
        nome: item.nome || 'Mídia sem nome',
        dados: item.dados || null,
        miniatura: item.miniatura || item.dados || null,
        tipo: item.tipo || (String(item.mime || '').startsWith('video/') ? 'video' : 'imagem'),
        mime: item.mime || '',
        tamanho: item.tamanho || 0,
        duracao: item.duracao ?? null,
        status: item.status || 'disponível',
        statusProcessamento: item.statusProcessamento || 'concluído',
        urlPublica: item.urlPublica || '',
        tags: Array.isArray(item.tags) ? item.tags : []
    }));
    return p;
}

/** Traduz o estado interno em rótulo para a interface. */
function estadoPublicacao(p) {
    if (p.publicacaoReal?.estado === 'publicado') return 'Publicada';
    if (p.publicacaoReal?.estado === 'incerto') return 'Erro — envio não confirmado';
    return ({ rascunho: 'Em preparação', 'em revisão': 'Em revisão', confirmado: 'Confirmada', agendada: 'Agendada' })[p.estado] || 'Em preparação';
}

const Publicacoes = { migrarPublicacao, estadoPublicacao };
if (typeof module !== 'undefined') module.exports = Publicacoes;
else globalThis.Publicacoes = Publicacoes;
