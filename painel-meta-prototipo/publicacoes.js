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
    p.templateTexto ??= ''; p.templateAplicarAutomatico ??= false;
    p.hashtags ??= ''; p.palavras ??= ''; p.ideias ??= '';
    p.revisoes ??= [];
    p.local ??= ''; p.maps ??= ''; p.site1 ??= ''; p.site2 ??= ''; p.site ??= ''; p.linksAdicionais ??= ''; p.informacoesAdicionais ??= ''; p.chamadasFixas ??= '';
    p.incluir ??= { local: false, maps: false, site1: false, site2: false, site: false };
    p.incluir = { local: p.incluir.local === true, maps: p.incluir.maps === true, site1: p.incluir.site1 === true, site2: p.incluir.site2 === true, site: p.incluir.site === true };
    p.fuso ??= 'Asia/Tokyo';
    p.estado ??= 'rascunho';
    p.statusPublicacao ??= 'nao_publicada';
    p.instagramMediaId ??= null; p.permalink ??= null; p.publicadoEm ??= null; p.erroPublicacao ??= null;
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

/**
 * Registra a URL pública de uma mídia e sincroniza o estado da publicação.
 *
 * Localiza a mídia pelo ID estável (não depende da referência antiga, que pode
 * ter sido recriada por uma renderização/migração) e, conforme o tipo, preenche
 * `imagemUrl` (imagem única) ou `videoUrl` (Reel). No carrossel, a URL vive em
 * cada mídia.
 *
 * @returns {object|null} a mídia atualizada ou null quando não encontrada.
 */
function registrarUrlPublica(publicacao, midiaId, urlPublica, meta = {}) {
    if (!publicacao || typeof urlPublica !== 'string' || !urlPublica) return null;
    const midia = (publicacao.imagens || []).find(item => item.id === midiaId);
    if (!midia) return null;
    midia.urlPublica = urlPublica;
    midia.statusUpload = 'concluído';
    if (meta.bytes !== undefined && meta.bytes !== null) midia.tamanho = meta.bytes;
    if (meta.filename) midia.arquivo = meta.filename;

    const indice = publicacao.imagens.indexOf(midia);
    if (publicacao.tipoMidia === 'imagem') {
        if (indice === 0 || !publicacao.imagemUrl) publicacao.imagemUrl = urlPublica;
    } else if (publicacao.tipoMidia === 'reel' && midia.tipo === 'video') {
        publicacao.videoUrl = urlPublica;
    }
    return midia;
}

/** Escreve no campo visual o valor atual de `imagemUrl`, mantendo o formulário coerente com o estado. */
function sincronizarUrlPublicaNoCampo(campo, publicacao) {
    const valor = publicacao?.imagemUrl || '';
    if (campo) campo.value = valor;
    return valor;
}

/** Traduz o estado interno em rótulo para a interface. */
function estadoPublicacao(p) {
    if (p.publicacaoReal?.estado === 'publicado') return 'Publicada';
    if (p.publicacaoReal?.estado === 'incerto') return 'Erro — envio não confirmado';
    return ({ rascunho: 'Em preparação', 'em revisão': 'Em revisão', confirmado: 'Confirmada', agendada: 'Agendada' })[p.estado] || 'Em preparação';
}

/**
 * Persiste o resultado real da publicação (sucesso ou falha da Meta).
 * Só é chamada depois de uma resposta confirmada do InstagramService.
 */
function registrarPublicacao(publicacao, resultado = {}) {
    if (!publicacao) return null;
    if (resultado.erro) {
        publicacao.statusPublicacao = 'falhou';
        publicacao.erroPublicacao = resultado.erro;
        publicacao.publicacaoReal = { estado: 'incerto', mensagem: resultado.erro, idPublicado: publicacao.instagramMediaId || null };
        return publicacao;
    }
    if (!resultado.mediaId) return null;
    publicacao.statusPublicacao = 'publicado';
    publicacao.instagramMediaId = resultado.mediaId;
    publicacao.permalink = resultado.permalink || publicacao.permalink || null;
    publicacao.publicadoEm = resultado.publicadoEm || new Date().toISOString();
    publicacao.erroPublicacao = null;
    publicacao.publicacaoReal = { estado: 'publicado', idPublicado: resultado.mediaId, finalizadoEm: new Date().toISOString() };
    return publicacao;
}

/** Estado visual do bloco "STATUS DA PUBLICAÇÃO". */
function statusPublicacaoVisual(p) {
    if (p?.statusPublicacao === 'publicado') return { classe: 'ok', texto: `✓ Publicada${p.instagramMediaId ? ` · ID ${p.instagramMediaId}` : ''}${p.publicadoEm ? ` · ${new Date(p.publicadoEm).toLocaleString('pt-BR')}` : ''}` };
    if (p?.statusPublicacao === 'publicando') return { classe: 'nota', texto: '◌ Publicando…' };
    if (p?.statusPublicacao === 'falhou') return { classe: 'pendente', texto: `✗ Falhou · ${p.erroPublicacao || 'erro não informado'}` };
    if (p?.estado === 'agendada' || (p?.data && p?.hora)) return { classe: 'nota', texto: `◷ Agendada para ${p.data} ${p.hora} (${p.fuso})` };
    return { classe: 'nota', texto: '○ Não publicada' };
}

/** Etapas do editor e sua ordem; o avanço automático segue exatamente esta lista. */
const ETAPAS = ['midia', 'informacoes', 'ia', 'revisao', 'agendamento', 'desempenho'];

function proximaEtapa(etapa) {
    const indice = ETAPAS.indexOf(etapa);
    return indice >= 0 && indice < ETAPAS.length - 1 ? ETAPAS[indice + 1] : null;
}

/**
 * Valida somente o necessário de cada etapa.
 * Retorna a lista de campos a corrigir; vazia significa etapa liberada.
 */
function validarEtapa(etapa, publicacao, { midiaPublicaPronta = false, errosDeConteudo = [] } = {}) {
    const erros = [];
    const bloquear = (campo, mensagem) => erros.push({ campo, mensagem });
    if (!publicacao) { bloquear('Publicação', 'Nenhuma publicação selecionada.'); return erros; }
    if (etapa === 'midia') {
        if (!(Array.isArray(publicacao.imagens) && publicacao.imagens.length) && !midiaPublicaPronta) bloquear('Mídia', 'Selecione um arquivo ou informe a URL pública.');
        else if (Array.isArray(publicacao.imagens) && publicacao.imagens.length && !midiaPublicaPronta) bloquear('URL pública', 'Envie a mídia ou informe a URL HTTPS pública.');
    }
    if (etapa === 'ia' && !String(publicacao.legenda || '').trim()) bloquear('Legenda', 'Gere com a Astra ou escreva manualmente.');
    if (etapa === 'revisao') {
        for (const texto of errosDeConteudo) bloquear('Revisão', texto);
        if (!midiaPublicaPronta) bloquear('URL pública', 'A mídia precisa de URL HTTPS pública.');
    }
    return erros;
}

const Publicacoes = { migrarPublicacao, estadoPublicacao, registrarUrlPublica, sincronizarUrlPublicaNoCampo, registrarPublicacao, statusPublicacaoVisual, proximaEtapa, validarEtapa, ETAPAS };
if (typeof module !== 'undefined') module.exports = Publicacoes;
else globalThis.Publicacoes = Publicacoes;
