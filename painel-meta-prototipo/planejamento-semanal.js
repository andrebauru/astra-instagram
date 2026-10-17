'use strict';

const regrasSemanal = (typeof require === 'function') ? require('./regras') : globalThis.Regras;

/*
 * Planejamento semanal (somente Instagram).
 *
 * Regras puras: validação da configuração, sorteio determinístico, enumeração
 * de datas civis, reserva de mídia e aprovação com assinatura. A execução vive
 * no SchedulerService do backend.
 */

/** Assinatura estável para invalidar aprovações após qualquer edição. */
function assinar(valor) {
    const texto = JSON.stringify(valor, Object.keys(valor || {}).sort());
    let hash = 2166136261;
    for (let indice = 0; indice < texto.length; indice++) hash = Math.imul(hash ^ texto.charCodeAt(indice), 16777619);
    return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Valida uma configuração semanal sem criar conteúdo inexistente. */
function validarConfiguracao(config = {}) {
    const erros = [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(config.inicio || '') || !/^\d{4}-\d{2}-\d{2}$/.test(config.fim || '')) erros.push('Informe o período da semana.');
    if (config.inicio > config.fim) erros.push('O início deve ser anterior ao fim.');
    if (!Array.isArray(config.dias) || !config.dias.length) erros.push('Escolha ao menos um dia de publicação.');
    if (!Array.isArray(config.horarios) || !config.horarios.length || config.horarios.some(hora => !/^\d{2}:\d{2}$/.test(hora))) erros.push('Informe horários válidos.');
    if (!Number.isInteger(Number(config.porDia)) || Number(config.porDia) < 1 || Number(config.porDia) > 12) erros.push('A quantidade por dia deve ficar entre 1 e 12.');
    try { new Intl.DateTimeFormat('pt-BR', { timeZone: config.timezone }).format(); } catch { erros.push('Informe um timezone IANA válido.'); }
    return erros;
}

/** Embaralha de forma repetível para que recarregar não altere um plano criado. */
function embaralharDeterministico(itens, semente) {
    const resultado = [...itens]; let estado = Number.parseInt(assinar({ semente }), 16) || 1;
    for (let indice = resultado.length - 1; indice > 0; indice--) {
        estado = (Math.imul(estado, 1664525) + 1013904223) >>> 0;
        const destino = estado % (indice + 1);
        [resultado[indice], resultado[destino]] = [resultado[destino], resultado[indice]];
    }
    return resultado;
}

/** Enumera datas civis do período sem convertê-las para o fuso do computador. */
function datasDoPeriodo(inicio, fim, dias) {
    const resultado = []; const cursor = new Date(`${inicio}T12:00:00Z`); const limite = new Date(`${fim}T12:00:00Z`);
    while (cursor <= limite) { if (dias.includes(cursor.getUTCDay())) resultado.push(cursor.toISOString().slice(0, 10)); cursor.setUTCDate(cursor.getUTCDate() + 1); }
    return resultado;
}

/** Alterna formatos disponíveis sem fabricar itens ausentes. */
function ordenarEquilibrado(midias, tipos) {
    const filas = Object.fromEntries(tipos.map(tipo => [tipo, midias.filter(item => item.tipo === tipo)]));
    const resultado = []; let progresso = true;
    while (progresso) { progresso = false; for (const tipo of tipos) if (filas[tipo]?.length) { resultado.push(filas[tipo].shift()); progresso = true; } }
    return resultado;
}

/** Obtém uma URL pública somente quando o usuário informou uma. */
function urlDaMidia(midia = {}) {
    const valor = midia.urlPublica || midia.url || '';
    return typeof valor === 'string' && /^https?:\/\//i.test(valor) ? valor : null;
}

/** Identifica conteúdo visual antes do ID para detectar cópias da mesma imagem. */
function identidadeVisual(midia = {}) {
    if (midia.sha256) return `sha256:${String(midia.sha256).toLowerCase()}`;
    const url = urlDaMidia(midia);
    if (url) return `url:${url}`;
    if (midia.dados) return `dados:${midia.dados}`;
    if (midia.arquivo) return `arquivo:${midia.arquivo}:${midia.tamanho || 0}`;
    if (midia.nome) return `nome:${midia.nome}:${midia.tamanho || 0}`;
    return midia.id || midia.mediaId || null;
}

/** Regra única de elegibilidade para agendamento orgânico. */
function avaliarElegibilidadeOrganica(midia = {}) {
    if (['video', 'reel'].includes(midia.tipo)) return { elegivel: true, motivo: null, imagensDistintas: 0 };
    const itens = Array.isArray(midia.itens) ? midia.itens : Array.isArray(midia.imagens) ? midia.imagens : [];
    if (midia.tipo !== 'carrossel') return { elegivel: false, motivo: 'Imagem única não é elegível: o agendamento orgânico exige no mínimo 3 imagens distintas.', imagensDistintas: itens.length ? new Set(itens.map(identidadeVisual).filter(Boolean)).size : 1 };
    const imagens = itens.filter(item => item.tipo !== 'video');
    const distintas = new Set(imagens.map(identidadeVisual).filter(Boolean)).size;
    if (imagens.length < 3) return { elegivel: false, motivo: 'Post com imagens não elegível: informe no mínimo 3 imagens distintas.', imagensDistintas: distintas };
    if (distintas < 3 || distintas !== imagens.length) return { elegivel: false, motivo: 'Post não elegível: existem imagens repetidas. Use pelo menos 3 imagens diferentes, sem duplicidade.', imagensDistintas: distintas };
    return { elegivel: true, motivo: null, imagensDistintas: distintas };
}

/** Aplica limites por destino sem mudar a regra orgânica Instagram existente. */
function avaliarParaDestinos(midia, destinos = []) {
    if (destinos.includes('Facebook Page')) {
        const itens = midia.itens || midia.imagens || [];
        if (midia.tipo === 'carrossel' && (itens.length < 2 || itens.length > 10 || itens.some(i => i.tipo === 'video'))) return { elegivel: false, motivo: 'Facebook aceita de 2 a 10 fotos, sem vídeos no conjunto.' };
        if (destinos.every(d => d === 'Facebook Page') && ['imagem', 'video', 'reel', 'carrossel'].includes(midia.tipo)) return { elegivel: true, motivo: null };
    }
    return avaliarElegibilidadeOrganica(midia);
}

/** Inclui a identidade da Página sem invalidar aprovações Instagram legadas. */
function dadosAprovacao(item) {
    return { mediaId: item.mediaId, data: item.data, hora: item.hora, timezone: item.timezone, destinos: item.destinos, legenda: item.legenda, ...(item.destinos?.includes('Facebook Page') ? { facebookPageId: item.facebookPageId || null } : {}) };
}

/** Informa quantas mídias elegíveis faltam e por quê. */
function pendenciasDeExecucao(plano = {}) {
    return (plano.itens || []).map(item => ({
        id: item.id,
        semUrl: item.tipo === 'carrossel' ? !(item.itens || []).length || item.itens.some(entrada => !entrada.url) : !item.url
    })).filter(item => item.semUrl);
}

/** Cria um plano em rascunho, persistível e sem repetição por padrão. */
function planejar(config, midias = []) {
    const erros = validarConfiguracao(config); if (erros.length) return { valido: false, erros, faltam: 0, itens: [] };
    const tipos = config.tipos?.length ? config.tipos : ['imagem', 'video', 'carrossel'];
    const avaliadas = midias.map(item => ({ item, avaliacao: avaliarParaDestinos(item, config.destinos) }));
    const inelegiveis = avaliadas.filter(entrada => !entrada.avaliacao.elegivel).map(entrada => ({ id: entrada.item.id, motivo: entrada.avaliacao.motivo }));
    const elegiveis = avaliadas.filter(entrada => entrada.avaliacao.elegivel).map(entrada => entrada.item).filter(item => tipos.includes(item.tipo) && !['reservada', 'utilizada'].includes(item.status));
    const datas = datasDoPeriodo(config.inicio, config.fim, config.dias.map(Number));
    const slots = datas.flatMap(data => config.horarios.slice(0, Number(config.porDia)).map(hora => ({ data, hora })));
    let selecionaveis = config.modo === 'equilibrado' ? ordenarEquilibrado(embaralharDeterministico(elegiveis, config.semente), tipos) : embaralharDeterministico(elegiveis, config.semente);
    if (config.modo === 'manual') selecionaveis = elegiveis;
    const faltam = Math.max(0, slots.length - selecionaveis.length);
    const itens = slots.slice(0, selecionaveis.length).map((slot, indice) => {
        const midia = selecionaveis[indice];
        const carrossel = Array.isArray(midia.itens) && midia.itens.length ? midia.itens.map((item, ordem) => ({ mediaId: item.id || item.mediaId, ordem, tipo: item.tipo, url: urlDaMidia(item) })) : null;
        const destinos = (config.destinos?.length ? [...config.destinos] : ['Instagram Feed']).filter(destino => !(midia.tipo === 'carrossel' && destino === 'Instagram Story'));
        return { id: `${config.id}:${slot.data}:${slot.hora}:${indice}`, mediaId: midia.id, tipo: midia.tipo, miniatura: midia.miniatura || midia.dados || null, url: urlDaMidia(midia), itens: carrossel, data: slot.data, hora: slot.hora, timezone: config.timezone, destinos, facebookPageId: config.facebookPageId || null, legenda: midia.legenda || '', status: 'rascunho', approvalSignature: null, atraso: config.atraso || 'reagendar', toleranciaMinutos: Number(config.toleranciaMinutos) || 30, resultados: {} };
    });
    const justificativas = [...new Set(inelegiveis.map(item => item.motivo))];
    return { valido: faltam === 0, erros: faltam ? [`Faltam ${faltam} mídia(s) elegível(is) para preencher a semana sem repetição.`, ...justificativas] : [], inelegiveis, faltam, id: config.id, criadoEm: new Date().toISOString(), status: 'rascunho', config: structuredClone(config), itens };
}

/** Aprova exatamente a versão revisada de cada item. */
function aprovar(plano) {
    const copia = structuredClone(plano); copia.status = 'aprovado'; copia.aprovadoEm = new Date().toISOString();
    copia.itens = copia.itens.map(item => ({ ...item, status: 'aprovado', approvalSignature: assinar(dadosAprovacao(item)) }));
    return copia;
}

/** Edita um item e exige nova aprovação apenas para ele. */
function editarItem(plano, itemId, alteracoes) {
    const copia = structuredClone(plano);
    copia.itens = copia.itens.map(item => item.id === itemId ? { ...item, ...alteracoes, status: 'rascunho', approvalSignature: null } : item);
    if (copia.itens.some(item => item.status === 'rascunho')) copia.status = 'parcialmente aprovado';
    return copia;
}

/** Pausa o plano ou um item sem interromper uma operação já iniciada. */
function pausar(plano, itemId = null) {
    const copia = structuredClone(plano);
    if (!itemId) { copia.status = 'pausado'; copia.itens = copia.itens.map(item => item.status === 'em andamento' ? item : { ...item, status: 'pausado' }); }
    else copia.itens = copia.itens.map(item => item.id === itemId && item.status !== 'em andamento' ? { ...item, status: 'pausado' } : item);
    return copia;
}

/** Cancela um item ainda não iniciado e devolve o ID da mídia a liberar. */
function cancelarItem(plano, itemId) {
    const copia = structuredClone(plano); let mediaId = null;
    copia.itens = copia.itens.map(item => { if (item.id !== itemId || item.status === 'em andamento') return item; mediaId = item.mediaId; return { ...item, status: 'cancelado', approvalSignature: null }; });
    return { plano: copia, mediaId };
}

/** Monta um carrossel local ordenado; limites só quando o provedor os informa. */
function criarCarrossel(midias, capacidades = {}) {
    const minimo = Number(capacidades.minItems) || 2; const maximo = Number(capacidades.maxItems) || Infinity;
    if (!Array.isArray(midias) || midias.length < minimo) throw new Error(`Selecione ao menos ${minimo} mídias para o carrossel.`);
    if (midias.length > maximo) throw new Error(`A integração configurada permite até ${maximo} itens neste carrossel.`);
    if (capacidades.tipos && midias.some(item => !capacidades.tipos.includes(item.tipo))) throw new Error('Um dos formatos não é compatível com o carrossel configurado.');
    return { id: globalThis.crypto.randomUUID(), tipo: 'carrossel', itens: midias.map((item, ordem) => ({ mediaId: item.id, ordem, tipo: item.tipo, url: urlDaMidia(item) })), ordem: midias.map(item => item.id), status: 'rascunho' };
}

const HORARIOS_PADRAO = ['12:00', '20:00'];

/** Resolve o instante do fim do período (fim do dia, no fuso). */
function fimDoPeriodo(fim, timezone) {
    const instantes = regrasSemanal.instantes(fim, '23:59', timezone);
    if (instantes.length) return Math.max(...instantes);
    const fallback = Date.parse(`${fim}T23:59:59Z`);
    return Number.isFinite(fallback) ? fallback : Infinity;
}

/**
 * Planeja N publicações ao longo de um período, respeitando dias permitidos,
 * intervalo mínimo/máximo, data final e timezone. Determinístico.
 *
 * @param {object} config inicio, fim, timezone, quantidade|porDia, intervaloMinimoHoras,
 *                        intervaloMaximoHoras, diasPermitidos, estrategiaHorario,
 *                        horarios, permitirReutilizacao, variarTexto, nivelVariacao
 * @param {Array} midias estoque (id, tipo, urlPublica, legenda, miniatura)
 * @param {object} [opcoes] { melhoresHorarios: [{hora, score}], agoraMs }
 */
function planejarPeriodo(config = {}, midias = [], opcoes = {}) {
    const erros = [];
    const timezone = config.timezone || 'Asia/Tokyo';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(config.inicio || '') || !/^\d{4}-\d{2}-\d{2}$/.test(config.fim || '')) erros.push('Informe data inicial e final.');
    if ((config.inicio || '') > (config.fim || '')) erros.push('A data inicial deve ser anterior à final.');
    try { new Intl.DateTimeFormat('pt-BR', { timeZone: timezone }).format(); } catch { erros.push('Timeout zone inválido.'); }
    const diasPermitidos = Array.isArray(config.diasPermitidos) && config.diasPermitidos.length ? config.diasPermitidos.map(Number) : [0, 1, 2, 3, 4, 5, 6];
    const intervaloMin = Number(config.intervaloMinimoHoras ?? 8);
    if (!(intervaloMin >= 0)) erros.push('Intervalo mínimo inválido.');
    const intervaloMax = Number(config.intervaloMaximoHoras);
    if (Number.isFinite(intervaloMax) && intervaloMax > 0 && intervaloMax < intervaloMin) erros.push('O intervalo máximo não pode ser menor que o mínimo.');

    const manual = config.estrategiaHorario === 'manual';
    const horariosManual = Array.isArray(config.horarios) ? config.horarios.filter(h => /^\d{2}:\d{2}$/.test(h)) : [];
    const melhores = Array.isArray(opcoes.melhoresHorarios) ? opcoes.melhoresHorarios.map(item => item.hora).filter(h => /^\d{2}:\d{2}$/.test(h)) : [];
    const horariosPreferidos = manual
        ? (horariosManual.length ? horariosManual : HORARIOS_PADRAO)
        : (melhores.length ? melhores : (horariosManual.length ? horariosManual : HORARIOS_PADRAO));

    const datas = datasDoPeriodo(config.inicio, config.fim, diasPermitidos);
    const porDia = Number(config.porDia) || 0;
    const quantidade = Number.isFinite(Number(config.quantidade)) && Number(config.quantidade) > 0 ? Number(config.quantidade) : (porDia > 0 ? porDia * datas.length : 0);
    if (quantidade < 1) erros.push('Informe a quantidade de publicações ou publicações por dia.');
    if (erros.length) return { valido: false, erros, faltam: 0, itens: [] };

    const agoraMs = Number.isFinite(opcoes.agoraMs) ? opcoes.agoraMs : Date.now();
    const fimMs = fimDoPeriodo(config.fim, timezone);

    const tiposAceitos = config.tipos?.length ? config.tipos : ['imagem', 'video', 'carrossel'];
    const avaliadas = (Array.isArray(midias) ? midias : []).map(item => ({ item, avaliacao: avaliarParaDestinos(item, config.destinos) }));
    const inelegiveis = avaliadas.filter(entrada => !entrada.avaliacao.elegivel).map(entrada => ({ id: entrada.item.id, motivo: entrada.avaliacao.motivo }));
    const estoque = avaliadas.filter(entrada => entrada.avaliacao.elegivel).map(entrada => entrada.item).filter(m => tiposAceitos.includes(m.tipo) && m.status !== 'utilizada');
    let indiceMidia = 0;
    const usadas = new Set();
    const precisaMidia = avaliadas.length > 0;
    if (precisaMidia && !config.permitirReutilizacao && estoque.length < quantidade) {
        // Ainda gera o que for possível; informa quantas faltam.
    }

    const itens = [];
    let ultimoMs = null;
    let faltamMidia = 0;
    for (const data of datas) {
        if (itens.length >= quantidade) break;
        for (const hora of horariosPreferidos) {
            if (itens.length >= quantidade) break;
            const instantes = regrasSemanal.instantes(data, hora, timezone);
            if (instantes.length !== 1) continue;
            const instante = instantes[0];
            if (instante <= agoraMs) continue;
            if (instante > fimMs) continue;
            if (ultimoMs !== null) {
                const deltaHoras = (instante - ultimoMs) / 3600000;
                if (deltaHoras < intervaloMin) continue;
                if (Number.isFinite(intervaloMax) && intervaloMax > 0 && deltaHoras > intervaloMax) continue;
            }
            let midia = null;
            if (precisaMidia) {
                if (!config.permitirReutilizacao) {
                    midia = estoque.find(m => !usadas.has(m.id));
                } else {
                    midia = estoque[indiceMidia % estoque.length];
                }
                if (!midia) { faltamMidia += 1; continue; }
                usadas.add(midia.id); indiceMidia += 1;
            }
            itens.push({
                id: `${config.id || 'periodo'}:${data}:${hora}:${itens.length}`,
                mediaId: midia ? midia.id : null,
                tipo: midia ? midia.tipo : 'imagem',
                miniatura: midia ? (midia.miniatura || midia.dados || null) : null,
                url: midia ? urlDaMidia(midia) : null,
                itens: midia && Array.isArray(midia.itens) && midia.itens.length ? midia.itens.map((e, ordem) => ({ mediaId: e.id || e.mediaId, ordem, tipo: e.tipo, url: urlDaMidia(e) })) : null,
                data, hora, scheduledAt: new Date(instante).toISOString(), timezone,
                destinos: (config.destinos?.length ? [...config.destinos] : ['Instagram Feed']).filter(destino => !(midia?.tipo === 'carrossel' && destino === 'Instagram Story')),
                facebookPageId: config.facebookPageId || null,
                legenda: midia ? (midia.legenda || '') : '',
                legendaEditorial: midia ? (midia.legendaEditorial || '') : '',
                publicacaoId: midia?.publicacaoId || null,
                status: 'rascunho', approvalSignature: null,
                variarTexto: config.variarTexto === true, nivelVariacao: config.nivelVariacao || 'Baixa',
                versao: 1,
                atraso: config.atraso || 'reagendar', toleranciaMinutos: Number(config.toleranciaMinutos) || 30,
                resultados: {}
            });
            ultimoMs = instante;
        }
    }

    const faltam = Math.max(0, quantidade - itens.length);
    return {
        valido: faltam === 0 && faltamMidia === 0,
        erros: faltam ? [`Faltam ${faltam} horário(s) possível(is) no período para atingir a quantidade.`, ...new Set(inelegiveis.map(item => item.motivo))] : (faltamMidia ? [`Faltam ${faltamMidia} mídia(s); ative a reutilização ou adicione mais arquivos.`, ...new Set(inelegiveis.map(item => item.motivo))] : []),
        inelegiveis,
        faltam, faltamMidia,
        id: config.id || `periodo-${Date.now()}`,
        nome: config.nome || 'Plano por período',
        status: 'rascunho',
        config: structuredClone(config),
        itens
    };
}

/** Marca as mídias do plano como reservadas. */
function reservarMidias(plano, midias = []) {
    const usados = new Set((plano.itens || []).flatMap(item => [item.mediaId, ...(item.itens || []).map(entrada => entrada.mediaId)]));
    return midias.map(midia => usados.has(midia.id) ? { ...midia, status: 'reservada', planoId: plano.id } : midia);
}

/** Libera mídias reservadas por um plano sem afetar as já utilizadas. */
function liberarMidias(plano, midias = []) {
    const usados = new Set((plano.itens || []).flatMap(item => [item.mediaId, ...(item.itens || []).map(entrada => entrada.mediaId)]));
    return midias.map(midia => midia.status === 'reservada' && (midia.planoId === plano.id || usados.has(midia.id)) ? { ...midia, status: 'disponível', planoId: null } : midia);
}

const PlanejamentoSemanal = { assinar, dadosAprovacao, avaliarParaDestinos, validarConfiguracao, pendenciasDeExecucao, identidadeVisual, avaliarElegibilidadeOrganica, embaralharDeterministico, datasDoPeriodo, urlDaMidia, planejar, planejarPeriodo, aprovar, editarItem, pausar, cancelarItem, criarCarrossel, reservarMidias, liberarMidias };
if (typeof module !== 'undefined') module.exports = PlanejamentoSemanal;
else globalThis.PlanejamentoSemanal = PlanejamentoSemanal;
