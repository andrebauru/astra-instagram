'use strict';

const regrasFluxo = typeof require === 'function' ? require('./regras') : globalThis.Regras;

/** Associa cada mídia ao conteúdo que fornece legenda, template e campos protegidos. */
function prepararMidiasParaAgenda(midias = [], conteudos = []) {
    const individuais = midias.map(midia => {
        const conteudo = conteudos.find(item => (item.imagens || []).some(arquivo => arquivo.id === midia.id));
        const arquivo = conteudo?.imagens.find(item => item.id === midia.id) || midia;
        const tipo = arquivo.mime === 'video/mp4' || /\.mp4(?:[?#]|$)/i.test(arquivo.nome || arquivo.urlPublica || '') ? 'video' : arquivo.tipo;
        if (!conteudo) return { ...midia, tipo };
        return {
            ...midia,
            ...arquivo,
            tipo,
            publicacaoId: conteudo.id,
            legendaEditorial: conteudo.legenda || '',
            legenda: regrasFluxo.compor(conteudo)
        };
    });
    const carrosseis = conteudos.filter(conteudo => conteudo.tipoMidia === 'carrossel' && Array.isArray(conteudo.imagens)).map(conteudo => ({
        id: `carrossel:${conteudo.id}`,
        tipo: 'carrossel',
        nome: conteudo.titulo || 'Carrossel',
        status: 'disponível',
        itens: conteudo.imagens.map(midia => ({ ...midia })),
        publicacaoId: conteudo.id,
        legendaEditorial: conteudo.legenda || '',
        legenda: regrasFluxo.compor(conteudo)
    }));
    return [...individuais, ...carrosseis];
}

/** Gera variações em cópia do plano; qualquer falha preserva integralmente o original. */
async function aplicarVariacoes(plano, { gerarTexto, localizarConteudo } = {}) {
    if (!plano?.itens?.some(item => item.variarTexto)) return structuredClone(plano);
    if (typeof gerarTexto !== 'function') throw Object.assign(new Error('A IA não está disponível para gerar as variações.'), { codigo: 'VARIACAO_IA_INDISPONIVEL' });
    const copia = structuredClone(plano);
    for (const item of copia.itens) {
        if (!item.variarTexto || item.variacaoConcluida) continue;
        const conteudo = typeof localizarConteudo === 'function' ? localizarConteudo(item.publicacaoId, item.mediaId) : null;
        const editorialOriginal = String(item.legendaEditorial || conteudo?.legenda || '').trim();
        if (!editorialOriginal) throw Object.assign(new Error('A publicação não possui texto editorial para variar.'), { codigo: 'VARIACAO_TEXTO_VAZIO' });
        const resposta = await gerarTexto({ texto: editorialOriginal, nivel: item.nivelVariacao || 'Baixa', item });
        const editorialVariado = typeof resposta === 'string' ? resposta.trim() : '';
        if (!editorialVariado) throw Object.assign(new Error('A IA retornou uma variação vazia. O texto original foi preservado.'), { codigo: 'VARIACAO_RESPOSTA_VAZIA' });
        const publicacaoVariada = conteudo ? { ...conteudo, legenda: editorialVariado } : null;
        const final = publicacaoVariada ? regrasFluxo.compor(publicacaoVariada) : editorialVariado;
        const protegidas = conteudo ? regrasFluxo.partesProtegidas(conteudo) : [];
        const validacao = regrasFluxo.validarVariacao(item.legenda || editorialOriginal, final, protegidas);
        if (!validacao.valido) throw Object.assign(new Error(`${validacao.motivo} O texto original foi preservado.`), { codigo: 'VARIACAO_CONTEUDO_PROTEGIDO' });
        item.legendaEditorial = editorialVariado;
        item.legenda = final;
        item.versao = (Number(item.versao) || 1) + 1;
        item.variacaoConcluida = true;
    }
    return copia;
}

/** Aprova e sincroniza um plano somente quando o backend confirma o mesmo ID. */
async function sincronizarPlano(plano, { prepararVariacoes, aprovar, enviar } = {}) {
    let preparado = structuredClone(plano);
    try {
        if (typeof prepararVariacoes === 'function') preparado = await prepararVariacoes(preparado);
        const aprovado = aprovar(preparado);
        const resposta = await enviar(aprovado);
        const confirmado = resposta?.success === true && Array.isArray(resposta.planos) && resposta.planos.some(item => item.id === aprovado.id);
        if (!confirmado) throw Object.assign(new Error('O servidor não confirmou a persistência do plano.'), { codigo: 'PLANO_NAO_CONFIRMADO' });
        return { ...aprovado, sincronizacao: { estado: 'confirmado_servidor', confirmadoEm: new Date().toISOString(), erro: null } };
    } catch (erro) {
        erro.planoRecuperavel = { ...preparado, status: 'rascunho', sincronizacao: { estado: 'falhou', confirmadoEm: null, erro: erro.message } };
        throw erro;
    }
}

const FluxoEditorial = { prepararMidiasParaAgenda, aplicarVariacoes, sincronizarPlano };
if (typeof module !== 'undefined') module.exports = FluxoEditorial;
else globalThis.FluxoEditorial = FluxoEditorial;
