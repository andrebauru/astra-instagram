'use strict';

/*
 * Regras editoriais do Astra (somente Instagram).
 *
 * Compõe a legenda final, converte data/hora civil no fuso IANA e valida os
 * requisitos. Nenhuma regra aqui publica, agenda ou fala com a rede.
 */

/** Separa requisitos cadastrados em linhas, mantendo a grafia. */
function linhas(texto = '') { return [...new Set(String(texto).split(/\r?\n/).map(item => item.trim()).filter(Boolean))]; }

/** Obtém hashtags completas sem confundir prefixos ou diferenças de caixa. */
function hashtags(texto = '') { return String(texto).match(/#[\p{L}\p{N}_]+/gu) || []; }

/** Compacta a edição manual sem criar blocos vazios nem reformatar o conteúdo. */
function normalizarLegenda(texto = '') {
    return String(texto).split(/\r?\n/).map(linha => linha.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Compõe a legenda final: conteúdo principal + template padrão + informações +
 * sites + hashtags obrigatórias, sem duplicar linhas, sites ou hashtags.
 */
function compor(publicacao) {
    const obrigatorias = [...new Set(String(publicacao.hashtags || '').trim().split(/\s+/).filter(Boolean))];
    const semTagsObrigatorias = texto => normalizarLegenda(texto || '').replace(/#[\p{L}\p{N}_]+/gu, tag => obrigatorias.includes(tag) ? '' : tag).replace(/[ \t]+\n/g, '\n').trim();

    const corpo = semTagsObrigatorias(publicacao.legenda);
    const template = semTagsObrigatorias(publicacao.templateTexto);
    const local = publicacao.incluir?.local && publicacao.local?.trim() ? publicacao.local.trim() : '';
    const baseLinks = [corpo, template].join('\n');
    const sites = [];
    const candidatos = [
        publicacao.incluir?.site && publicacao.site?.trim() ? publicacao.site.trim() : '',
        publicacao.incluir?.maps && publicacao.maps?.trim() ? publicacao.maps.trim() : '',
        ...String(publicacao.linksAdicionais || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean)
    ];
    for (const valor of candidatos) {
        if (!valor || sites.includes(valor)) continue;
        const escapado = valor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (!new RegExp(`(^|\\n)${escapado}(?=\\n|$)`).test(baseLinks)) sites.push(valor);
    }

    const blocos = [
        corpo,
        template,
        String(publicacao.chamadasFixas || '').trim(),
        String(publicacao.informacoesAdicionais || '').trim(),
        local,
        sites.join('\n'),
        obrigatorias.join(' ')
    ].filter(bloco => bloco && bloco.trim());
    const vistas = new Set();
    const linhas = [];
    for (const bloco of blocos) {
        for (const linha of bloco.split('\n')) {
            const chave = linha.trim();
            if (!chave) { linhas.push(''); continue; }
            if (vistas.has(chave)) continue;
            vistas.add(chave); linhas.push(linha.trimEnd());
        }
        linhas.push('');
    }
    return normalizarLegenda(linhas.join('\n'));
}

/** Linhas protegidas que variações de IA nunca podem alterar ou remover. */
function partesProtegidas(publicacao) {
    const protegidas = new Set();
    for (const linha of linhas(publicacao.templateTexto)) protegidas.add(linha);
    for (const linha of linhas(publicacao.chamadasFixas)) protegidas.add(linha);
    for (const linha of linhas(publicacao.informacoesAdicionais)) protegidas.add(linha);
    for (const linha of linhas(publicacao.linksAdicionais)) protegidas.add(linha);
    for (const tag of hashtags(publicacao.hashtags)) protegidas.add(tag);
    for (const chave of ['maps', 'site', 'site1', 'site2', 'local']) {
        const valor = (publicacao[chave] || '').trim();
        if (valor) protegidas.add(valor);
    }
    const links = String(publicacao.templateTexto || '').match(/https?:\/\/[^\s]+/g) || [];
    for (const link of links) protegidas.add(link);
    return [...protegidas].filter(Boolean);
}

/** Aceita uma variação somente se mantiver todas as partes protegidas. */
function validarVariacao(original, variacao, protegidas = []) {
    if (typeof variacao !== 'string' || !variacao.trim()) return { valido: false, motivo: 'Variação vazia.' };
    const faltando = protegidas.filter(parte => !variacao.includes(parte));
    if (faltando.length) return { valido: false, motivo: `A variação removeu conteúdo protegido: ${faltando.slice(0, 3).join(', ')}` };
    return { valido: true, motivo: null };
}

/** Resolve horário civil no fuso, recusando horários inexistentes ou ambíguos. */
function instantes(data, hora, fuso) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || !/^\d{2}:\d{2}$/.test(hora)) return [];
    try {
        const formato = new Intl.DateTimeFormat('sv-SE', { timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
        const alvo = `${data} ${hora}`;
        const base = Date.parse(`${data}T${hora}:00Z`);
        const encontrados = [];
        for (let minutos = -840; minutos <= 840; minutos += 15) {
            const valor = base + minutos * 60000;
            if (formato.format(new Date(valor)) === alvo) encontrados.push(valor);
        }
        return encontrados;
    } catch { return []; }
}

/** Valida os requisitos do conteúdo do Instagram para revisão/publicação. */
function validar(p, agora = Date.now(), opcoes = {}) {
    const itens = [];
    const adicionar = (ok, texto) => itens.push({ ok, texto });
    if (opcoes.exigirMidia !== false) adicionar(Array.isArray(p.imagens) && p.imagens.length > 0, 'Ao menos uma mídia selecionada');
    adicionar(typeof p.legenda === 'string' && p.legenda.trim().length > 0, 'Legenda preenchida');
    adicionar(['imagem', 'reel', 'carrossel'].includes(p.tipoMidia), 'Tipo de publicação definido');
    const tags = linhas(p.hashtags).join(' ').split(/\s+/).filter(Boolean);
    adicionar(tags.every(tag => /^#[\p{L}\p{N}_]+$/u.test(tag)), 'Formato das hashtags obrigatórias');
    for (const chave of ['maps', 'site', 'site1', 'site2']) {
        if (!String(p[chave] || '').trim()) continue;
        let ok = false;
        try { const url = new URL(p[chave]); ok = ['http:', 'https:'].includes(url.protocol); } catch { /* inválido */ }
        adicionar(ok, `Link válido: ${chave}`);
    }
    const final = compor(p);
    for (const tag of new Set(tags)) adicionar(hashtags(final).includes(tag), `${tag} no texto final`);
    for (const ideia of linhas(p.ideias)) adicionar((p.revisoes || []).includes(ideia), `Revisão humana — ${ideia}`);
    if (opcoes.exigirAgenda === true) {
        const datas = instantes(p.data, p.hora, p.fuso);
        adicionar(datas.length === 1 && datas[0] > agora, 'Data futura e horário único no fuso escolhido');
    }
    return itens;
}

/** Cria um conteúdo vazio sem pressupor dados comerciais ou localização. */
function criarConteudo() {
    return {
        id: globalThis.crypto.randomUUID(),
        titulo: '',
        criadaEm: new Date().toISOString(),
        tipoMidia: 'imagem',
        imagens: [],
        imagemUrl: '', videoUrl: '',
        tema: '', fatos: '', fatosIa: '', textoMidia: '', contexto: '', objetivo: '',
        legenda: '',
        templateTexto: '', templateAplicarAutomatico: false,
        hashtags: '', palavras: '', ideias: '',
        revisoes: [],
        local: '', maps: '', site1: '', site2: '', site: '', linksAdicionais: '', informacoesAdicionais: '', chamadasFixas: '',
        incluir: { local: false, maps: false, site1: false, site2: false, site: false },
        data: '', hora: '', fuso: 'Asia/Tokyo', preferencia: '18:00',
        estado: 'rascunho',
        statusPublicacao: 'nao_publicada',
        instagramMediaId: null, permalink: null, publicadoEm: null, erroPublicacao: null,
        publicacaoReal: null
    };
}

/** Contrato local de IA (sem rede): reutiliza apenas o contexto fornecido. */
function simularLegenda(p, reescrever = false) {
    const texto = (reescrever ? p.legenda : [p.tema, p.fatos, p.fatosIa, p.textoMidia, p.contexto].filter(Boolean).join('\n')).trim();
    if (!texto) throw new Error(reescrever ? 'Preencha a legenda antes de reescrever.' : 'Informe o tema e os fatos antes de gerar.');
    return texto;
}

const Regras = { linhas, hashtags, normalizarLegenda, compor, partesProtegidas, validarVariacao, instantes, validar, criarConteudo, simularLegenda };
if (typeof module !== 'undefined') module.exports = Regras;
else globalThis.Regras = Regras;
