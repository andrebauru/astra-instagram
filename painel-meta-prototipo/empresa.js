'use strict';

/*
 * Template de requisitos e agenda padrão da empresa.
 *
 * Reutilizável por novos conteúdos; nunca altera título, mídia ou legenda.
 */

/** Mantém somente os requisitos que podem ser reutilizados como template fixo. */
function criarTemplateRequisitos(publicacao) {
    return {
        hashtags: publicacao.hashtags || '',
        palavras: publicacao.palavras || '',
        ideias: publicacao.ideias || '',
        incluir: structuredClone(publicacao.incluir || {}),
        local: publicacao.local || '',
        maps: publicacao.maps || '',
        site1: publicacao.site1 || '',
        site2: publicacao.site2 || ''
    };
}

/** Aplica um template sem alterar título, legenda, mídia ou agenda. */
function aplicarTemplateRequisitos(publicacao, template) {
    if (!template) return publicacao;
    for (const campo of ['hashtags', 'palavras', 'ideias', 'local', 'maps', 'site1', 'site2']) publicacao[campo] = template[campo] || '';
    publicacao.incluir = { ...(publicacao.incluir || {}), ...(template.incluir || {}) };
    return publicacao;
}

/** Captura a agenda padrão para novos conteúdos. */
function criarAgendaEmpresa(publicacao) {
    return { data: publicacao.data || '', hora: publicacao.hora || '', fuso: publicacao.fuso || 'Asia/Tokyo', preferencia: publicacao.preferencia || '' };
}

/** Aplica a agenda salva somente quando o novo conteúdo ainda está vazio. */
function aplicarAgendaEmpresa(publicacao, agenda) {
    if (!agenda || publicacao.data || publicacao.hora) return publicacao;
    for (const campo of ['data', 'hora', 'fuso', 'preferencia']) if (agenda[campo] !== undefined) publicacao[campo] = agenda[campo];
    return publicacao;
}

const Empresa = { criarTemplateRequisitos, aplicarTemplateRequisitos, criarAgendaEmpresa, aplicarAgendaEmpresa };
if (typeof module !== 'undefined') module.exports = Empresa;
else globalThis.Empresa = Empresa;
