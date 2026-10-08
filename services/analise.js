'use strict';

/*
 * Análise determinística de melhores horários (somente métricas orgânicas).
 *
 * Nenhum número aleatório: o score é uma função fixa das métricas disponíveis.
 * Métrica ausente não vira zero nem é inventada — contribui apenas com a parte
 * que existe. Com poucas amostras, o resultado informa insuficiência.
 */

const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const INDICE_DIA = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const MINIMO_AMOSTRAS = 3;

/** Extrai data/hora/dia-da-semana no fuso do registro, sem fabricar dados. */
function horarioLocal(publicadoEm, fuso = 'UTC') {
    if (!publicadoEm) return { data: null, diaSemana: null, hora: null, faixa: null };
    try {
        const partes = new Intl.DateTimeFormat('en-US', { timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long', hour: '2-digit', hour12: false }).formatToParts(new Date(publicadoEm));
        const valor = tipo => partes.find(p => p.type === tipo)?.value || null;
        const hora = valor('hour');
        return {
            data: `${valor('year')}-${valor('month')}-${valor('day')}`,
            diaSemana: DIAS[INDICE_DIA[(valor('weekday') || '').toLowerCase()] ?? -1] || null,
            hora: hora === null ? null : Number(hora),
            faixa: hora === null ? null : `${hora}:00–${hora}:59`
        };
    } catch { return { data: null, diaSemana: null, hora: null, faixa: null }; }
}

/** Limita um número ao intervalo [0, 1] sem inventar valores. */
function normalizar(valor, teto) {
    const numero = Number(valor);
    if (!Number.isFinite(numero) || numero <= 0) return 0;
    return Math.min(1, numero / teto);
}

/**
 * Score 0–100 por publicação, a partir apenas das métricas existentes.
 * Fórmula determinística e estável.
 */
function scorePublicacao(metrica) {
    const alcance = Number(metrica.reach) || 0;
    const interacoes = (Number(metrica.likes) || 0) + (Number(metrica.comments) || 0) + (Number(metrica.shares) || 0) + (Number(metrica.saves) || 0);
    // Sem alcance devolvido pela API, o engajamento é avaliado pelo volume absoluto
    // disponível (ex.: curtidas e comentários), sem inventar alcance.
    const engajamento = alcance > 0
        ? normalizar(interacoes / alcance, 0.1)
        : normalizar(interacoes, 100);
    const componentes = {
        alcance: normalizar(alcance, 10000),
        engajamento,
        salvamentos: normalizar(alcance > 0 ? (Number(metrica.saves) || 0) / alcance : 0, 0.05),
        compartilhamentos: normalizar(alcance > 0 ? (Number(metrica.shares) || 0) / alcance : 0, 0.02)
    };
    const score = 0.45 * componentes.alcance + 0.30 * componentes.engajamento + 0.15 * componentes.salvamentos + 0.10 * componentes.compartilhamentos;
    return Math.round(score * 100);
}

/** Quais métricas a API realmente devolveu (nada é inventado). */
function metricasDisponiveis(metricas = []) {
    const presente = campo => metricas.some(item => {
        const valor = item?.[campo];
        return valor !== null && valor !== undefined && valor !== '' && Number.isFinite(Number(valor)) && Number(valor) >= 0;
    });
    return {
        curtidas: presente('likes'),
        comentarios: presente('comments'),
        alcance: presente('reach'),
        impressoes: presente('impressions'),
        salvamentos: presente('saves'),
        compartilhamentos: presente('shares'),
        visualizacoes: presente('videoViews')
    };
}

/** Um registro sem métricas consultadas (publicação nova) não entra na análise. */
function temMetricas(item = {}) {
    return ['reach', 'impressions', 'likes', 'comments', 'saves', 'shares', 'videoViews'].some(campo => Number.isFinite(Number(item[campo])));
}

/** Confiança declarada a partir do volume de amostras, não de sorteio. */
function confianca(amostras, minimo) {
    if (amostras >= Math.max(10, minimo * 3)) return 'Alta';
    if (amostras >= Math.max(5, minimo * 2)) return 'Média';
    return 'Baixa';
}

/** Média determinística de uma lista de números. */
function media(valores) {
    if (!valores.length) return 0;
    return valores.reduce((soma, valor) => soma + valor, 0) / valores.length;
}

/**
 * Analisa o histórico orgânico e devolve melhores horários e resumo.
 *
 * @param {Array} metricas registros normalizados (source deve ser orgânico)
 * @param {object} [opcoes] { timezone, minimo }
 */
function analisarMelhoresHorarios(metricas = [], opcoes = {}) {
    const minimo = Number(opcoes.minimo) || MINIMO_AMOSTRAS;
    const validas = (Array.isArray(metricas) ? metricas : []).filter(item => item && item.source !== 'paid' && (item.publishedAt || item.publicadoEm) && (item.capturedAt || temMetricas(item)));
    const enriquecidas = validas.map(item => {
        const publicadoEm = item.publishedAt || item.publicadoEm;
        return { metrica: item, horario: horarioLocal(publicadoEm, opcoes.timezone || item.timezone || 'UTC'), score: scorePublicacao(item) };
    });
    const comHorario = enriquecidas.filter(item => item.horario.hora !== null);

    const porHora = new Map();
    for (const item of comHorario) {
        const chave = item.horario.hora;
        if (!porHora.has(chave)) porHora.set(chave, []);
        porHora.get(chave).push(item.score);
    }
    const melhoresHorarios = [...porHora.entries()]
        .map(([hora, scores]) => ({ hora: `${String(hora).padStart(2, '0')}:00`, horaNumero: hora, score: Math.round(media(scores)), amostras: scores.length }))
        .sort((a, b) => b.score - a.score || a.horaNumero - b.horaNumero)
        .slice(0, 5);

    const porDia = new Map();
    for (const item of comHorario) {
        if (!item.horario.diaSemana) continue;
        if (!porDia.has(item.horario.diaSemana)) porDia.set(item.horario.diaSemana, []);
        porDia.get(item.horario.diaSemana).push(item.score);
    }
    const melhorDia = [...porDia.entries()].map(([dia, scores]) => ({ dia, score: Math.round(media(scores)), amostras: scores.length })).sort((a, b) => b.score - a.score || a.dia.localeCompare(b.dia))[0] || null;

    const ultimaAtualizacao = validas.map(item => item.capturedAt).filter(Boolean).sort().at(-1) || null;
    const datas = validas.map(item => item.publicadoEm || item.publishedAt).filter(Boolean).sort();
    const scoreMedio = Math.round(media(enriquecidas.map(item => item.score)));
    const suficiente = comHorario.length >= minimo;
    const totais = {
        curtidas: validas.reduce((soma, item) => soma + (Number(item.likes) || 0), 0),
        comentarios: validas.reduce((soma, item) => soma + (Number(item.comments) || 0), 0),
        alcance: validas.reduce((soma, item) => soma + (Number(item.reach) || 0), 0),
        salvamentos: validas.reduce((soma, item) => soma + (Number(item.saves) || 0), 0),
        compartilhamentos: validas.reduce((soma, item) => soma + (Number(item.shares) || 0), 0)
    };

    return {
        suficiente,
        confianca: confianca(comHorario.length, minimo),
        mensagem: suficiente ? `Baseado no histórico disponível (${comHorario.length} publicação(ões) orgânica(s)).` : 'Dados insuficientes para recomendação forte. Usando melhor distribuição disponível.',
        melhoresHorarios,
        melhorDia,
        melhorFaixa: melhoresHorarios[0] || null,
        postsAnalisados: validas.length,
        periodo: datas.length ? { inicio: datas[0], fim: datas[datas.length - 1] } : null,
        metricasDisponiveis: metricasDisponiveis(validas),
        totais,
        scoreMedio,
        ultimaAtualizacao,
        minimoAmostras: minimo
    };
}

/** Reotimiza somente itens futuros, preservando publicados e cancelados. */
function reotimizarPendentes(itens = [], melhoresHorarios = [], agora = Date.now(), timezone = 'UTC') {
    const horarios = (Array.isArray(melhoresHorarios) ? melhoresHorarios : []).map(item => item.hora).filter(Boolean);
    if (!horarios.length) return [];
    const previsao = [];
    let indiceHorario = 0;
    for (const item of itens) {
        if (['confirmada', 'publicado', 'cancelado', 'em andamento'].includes(item.status)) continue;
        const instante = Date.parse(item.scheduledAt || `${item.data}T${item.hora}:00Z`);
        if (Number.isFinite(instante) && instante <= agora) continue;
        const data = item.data;
        const hora = horarios[indiceHorario % horarios.length];
        indiceHorario += 1;
        previsao.push({ id: item.id, data, horaAnterior: item.hora, horaNova: hora, timezone: item.timezone || timezone });
    }
    return previsao;
}

module.exports = { DIAS, MINIMO_AMOSTRAS, horarioLocal, scorePublicacao, analisarMelhoresHorarios, reotimizarPendentes };
