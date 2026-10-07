'use strict';

/*
 * SchedulerService — data, hora, timezone, persistência, execução, status e
 * cancelamento dos agendamentos.
 *
 * Quando chega o horário, o SchedulerService chama `instagram.publish()`.
 * Ele não duplica lógica da Meta/Instagram: toda publicação real passa pelo
 * InstagramService, exatamente como o botão "Publicar agora".
 */

const fs = require('node:fs');
const path = require('node:path');
const PlanejamentoSemanal = require('../painel-meta-prototipo/planejamento-semanal');
const Regras = require('../painel-meta-prototipo/regras');

const ESTADOS_PLANO = ['rascunho', 'aprovado', 'parcialmente aprovado', 'pausado', 'concluido', 'cancelado'];
const ESTADOS_ITEM = ['rascunho', 'aprovado', 'pausado', 'aguardando', 'em andamento', 'confirmada', 'incerto', 'falhou', 'reagendado', 'cancelado', 'bloqueado'];
const CODIGOS_INCERTOS = ['META_CONEXAO', 'TEMPO_ESGOTADO', 'PUBLICACAO_INDETERMINADA', 'META_RESPOSTA_INVALIDA'];
const DESTINOS = ['Instagram'];

function agoraISO(agora) { return new Date(agora).toISOString(); }

/** Converte data/hora civil no fuso do item para instante UTC, sem inventar horários ambíguos. */
function instanteDoItem(item) {
    const instantes = Regras.instantes(item.data, item.hora, item.timezone || 'UTC');
    return instantes.length === 1 ? instantes[0] : null;
}

function destinosDoItem(item) {
    const lista = Array.isArray(item.destinos) ? item.destinos : [];
    return [...new Set(lista.filter(destino => DESTINOS.includes(destino)))];
}

/** Recalcula a assinatura de aprovação exatamente como o painel a definiu. */
function assinaturaDoItem(item) {
    return PlanejamentoSemanal.assinar({
        mediaId: item.mediaId, data: item.data, hora: item.hora,
        timezone: item.timezone, destinos: destinosDoItem(item), legenda: item.legenda
    });
}

function aprovacaoValida(item) {
    return Boolean(item.approvalSignature) && item.approvalSignature === assinaturaDoItem(item);
}

function clonar(valor) { return JSON.parse(JSON.stringify(valor)); }

/** Armazenamento em arquivo com gravação atômica e tolerância a falhas. */
function criarArmazenamentoArquivo(caminho) {
    return {
        carregar() {
            try {
                const dados = JSON.parse(fs.readFileSync(caminho, 'utf8'));
                return dados && typeof dados === 'object' ? dados : { planos: [] };
            } catch { return { planos: [] }; }
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

function criarArmazenamentoMemoria(inicial = { planos: [] }) {
    let estado = clonar(inicial);
    return { carregar: () => clonar(estado), salvar: valor => { estado = clonar(valor); return true; }, _estado: () => estado };
}

/**
 * Motor de execução. Recebe um `publicador` injetado para permitir testes e
 * para que a produção sempre passe pelo InstagramService.
 */
function criarMotor({ armazenamento, publicador, reconciliador = null, agora = Date.now, maxPorCiclo = 3, registrar = () => {} } = {}) {
    if (!armazenamento || typeof armazenamento.carregar !== 'function') throw new Error('O motor de agenda precisa de um armazenamento.');
    if (typeof publicador !== 'function') throw new Error('O motor de agenda precisa de um publicador injetado.');
    const emAndamento = new Set();
    let cicloAtivo = false;
    let estado = armazenamento.carregar();
    if (!Array.isArray(estado.planos)) estado.planos = [];

    function persistir() { estado.atualizadoEm = agoraISO(agora()); return armazenamento.salvar(estado); }

    function sincronizarPlanos(planos = []) {
        const mapa = new Map(estado.planos.map(plano => [plano.id, plano]));
        for (const recebido of planos) {
            if (!recebido || typeof recebido !== 'object' || !recebido.id) continue;
            const anterior = mapa.get(recebido.id);
            const anteriores = new Map();
            for (const item of anterior?.itens || []) anteriores.set(item.id, item);
            const itens = (Array.isArray(recebido.itens) ? recebido.itens : []).map(item => {
                const antes = anteriores.get(item.id);
                if (antes && antes.resultados && Object.keys(antes.resultados).length) {
                    return { ...item, status: antes.status, resultados: antes.resultados, motivo: antes.motivo };
                }
                return { ...item, resultados: {} };
            });
            mapa.set(recebido.id, { ...recebido, itens, atualizadoEm: agoraISO(agora()) });
        }
        estado.planos = [...mapa.values()];
        persistir();
        return listarPlanos();
    }

    function removerPlano(id) {
        estado.planos = estado.planos.filter(plano => plano.id !== id);
        persistir();
    }

    function listarPlanos() { return clonar(estado.planos); }

    function localizar(planoId, itemId) {
        const plano = estado.planos.find(item => item.id === planoId);
        const item = plano?.itens.find(entrada => entrada.id === itemId);
        return { plano, item };
    }

    function registrarResultado(item, destino, resultado) {
        item.resultados = item.resultados || {};
        item.resultados[destino] = { ...(item.resultados[destino] || {}), ...resultado, atualizadoEm: agoraISO(agora()) };
    }

    function consolidarItem(item) {
        const destinos = destinosDoItem(item);
        const resultados = destinos.map(destino => item.resultados?.[destino]?.estado || 'aguardando');
        if (resultados.every(estado => estado === 'confirmada')) item.status = 'confirmada';
        else if (resultados.some(estado => estado === 'incerto')) item.status = 'incerto';
        else if (resultados.some(estado => estado === 'falhou')) item.status = 'falhou';
        else item.status = 'aguardando';
        return item.status;
    }

    async function reconciliarItem(item) {
        if (!reconciliador) return false;
        let algum = false;
        for (const destino of destinosDoItem(item)) {
            const resultado = item.resultados?.[destino];
            if (!resultado || resultado.estado !== 'incerto') continue;
            try {
                const encontrado = await reconciliador({ item: clonar(item), destino });
                if (encontrado?.id) {
                    registrarResultado(item, destino, { estado: 'confirmada', idPublicado: encontrado.id, reconciliado: true });
                    algum = true;
                    registrar('SCHEDULING', 'reconciled', { operationId: item.id, destino, result: 'publicação confirmada' });
                }
            } catch (erro) {
                registrar('SCHEDULING', 'reconcile_failed', { operationId: item.id, destino, code: erro.codigo || 'ERRO', message: erro.message, result: 'resultado ainda não confirmado' });
            }
        }
        if (algum) consolidarItem(item);
        return algum;
    }

    async function executarItem(item) {
        const destinos = destinosDoItem(item);
        const instantePlanejado = instanteDoItem(item);
        const planejadoEm = instantePlanejado === null ? null : new Date(instantePlanejado).toISOString();
        if (!destinos.length) { item.status = 'bloqueado'; item.motivo = 'Nenhum destino configurado.'; return 'bloqueado'; }
        if (!aprovacaoValida(item)) { item.status = 'bloqueado'; item.motivo = 'Aprovação inválida: o item foi alterado e precisa de nova aprovação.'; registrar('SCHEDULING', 'blocked', { operationId: item.id, reason: 'approval_invalid', result: 'bloqueado' }); return 'bloqueado'; }
        const semUrl = item.tipo === 'carrossel' ? !(item.itens || []).length || item.itens.some(entrada => !entrada.url) : !item.url;
        if (semUrl) { item.status = 'bloqueado'; item.motivo = 'Mídia sem URL pública; publique manualmente ou informe uma URL acessível pelo provedor.'; registrar('SCHEDULING', 'blocked', { operationId: item.id, reason: 'missing_public_url', result: 'bloqueado' }); return 'bloqueado'; }
        for (const destino of destinos) {
            const atual = item.resultados?.[destino]?.estado;
            if (atual === 'confirmada') continue;
            const tentativaId = `${item.id}:${destino}:${agoraISO(agora())}`;
            registrarResultado(item, destino, { estado: 'em andamento', tentativaId, iniciadoEm: agoraISO(agora()) });
            try {
                const resultado = await publicador({ item: clonar(item), destino, tentativaId });
                if (!resultado?.id) throw Object.assign(new Error('O provedor não confirmou o identificador da publicação.'), { codigo: 'PUBLICACAO_INDETERMINADA' });
                registrarResultado(item, destino, { estado: 'confirmada', idPublicado: resultado.id, finalizadoEm: agoraISO(agora()), tentativaId });
                registrar('SCHEDULING', 'published', { operationId: item.id, destino, mediaId: item.mediaId, metaMediaId: resultado.id, plannedAt: planejadoEm, effectiveAt: agoraISO(agora()), result: 'publicação confirmada' });
            } catch (erro) {
                const incerto = CODIGOS_INCERTOS.includes(erro.codigo);
                const tentativas = (item.resultados?.[destino]?.numeroTentativas || 0) + 1;
                registrarResultado(item, destino, {
                    estado: incerto ? 'incerto' : 'falhou', code: erro.codigo || 'FALHA', message: erro.message,
                    finalizadoEm: agoraISO(agora()), tentativaId, ultimaTentativa: agoraISO(agora()),
                    numeroTentativas: tentativas, codigoErro: erro.codigo || 'FALHA', mensagemErro: erro.message, meta: erro.metaDetalhe || null
                });
                registrar('SCHEDULING', incerto ? 'uncertain' : 'failed', { operationId: item.id, destino, code: erro.codigo || 'FALHA', message: erro.message, plannedAt: planejadoEm, effectiveAt: agoraISO(agora()), attempts: tentativas, result: incerto ? 'resultado ainda não confirmado' : 'falhou' });
            }
        }
        return consolidarItem(item);
    }

    function atrasoMinutos(item, instante, referencia = agora()) {
        if (instante === null) return null;
        return Math.floor((referencia - instante) / 60000);
    }

    async function executarCiclo() {
        if (cicloAtivo) return { executados: 0, confirmados: 0, incertos: 0, falhas: 0, reagendados: 0, bloqueados: 0, reconciliados: 0, ignorado: 'ciclo em andamento' };
        cicloAtivo = true;
        const referencia = agora();
        const resumo = { executados: 0, confirmados: 0, incertos: 0, falhas: 0, reagendados: 0, bloqueados: 0, reconciliados: 0 };
        try {
            for (const plano of estado.planos) {
                if (['pausado', 'cancelado', 'rascunho'].includes(plano.status)) continue;
                for (const item of plano.itens || []) {
                    if (!['aprovado', 'incerto', 'em andamento', 'aguardando'].includes(item.status)) continue;
                    if (emAndamento.has(item.id)) continue;
                    if (item.status === 'incerto' || item.status === 'em andamento') {
                        emAndamento.add(item.id);
                        try { if (await reconciliarItem(item)) resumo.reconciliados++; } finally { emAndamento.delete(item.id); }
                        continue;
                    }
                    const instante = instanteDoItem(item);
                    if (instante === null) { item.status = 'bloqueado'; item.motivo = 'Data ou fuso inválido; reagende este item.'; resumo.bloqueados++; continue; }
                    if (instante > referencia) { item.status = 'aguardando'; continue; }
                    if (resumo.executados >= maxPorCiclo) break;
                    const delta = atrasoMinutos(item, instante, referencia);
                    const tolerancia = Number.isFinite(Number(item.toleranciaMinutos)) ? Number(item.toleranciaMinutos) : 30;
                    if (delta > tolerancia && item.atraso !== 'publicar') {
                        item.status = 'reagendado';
                        item.motivo = `Atraso de ${delta} min excede a tolerância de ${tolerancia} min; reagende ou ajuste a política.`;
                        resumo.reagendados++;
                        registrar('SCHEDULING', 'delayed', { operationId: item.id, delayMinutes: delta, result: 'agendado' });
                        continue;
                    }
                    emAndamento.add(item.id);
                    resumo.executados++;
                    try { const estadoItem = await executarItem(item); if (estadoItem === 'confirmada') resumo.confirmados++; else if (estadoItem === 'incerto') resumo.incertos++; else if (estadoItem === 'falhou') resumo.falhas++; else if (estadoItem === 'bloqueado') resumo.bloqueados++; }
                    finally { emAndamento.delete(item.id); }
                    if (resumo.executados >= maxPorCiclo) break;
                }
                if (resumo.executados >= maxPorCiclo) break;
            }
        } finally { persistir(); cicloAtivo = false; }
        return resumo;
    }

    function pausarPlano(planoId) {
        const plano = estado.planos.find(item => item.id === planoId);
        if (!plano) return null;
        plano.status = 'pausado';
        plano.itens = plano.itens.map(item => item.status === 'em andamento' ? item : { ...item, status: 'pausado' });
        persistir();
        return clonar(plano);
    }

    function retomarPlano(planoId) {
        const plano = estado.planos.find(item => item.id === planoId);
        if (!plano) return null;
        plano.status = 'aprovado';
        plano.itens = plano.itens.map(item => item.status === 'pausado' ? { ...item, status: aprovacaoValida(item) ? 'aprovado' : 'rascunho', approvalSignature: aprovacaoValida(item) ? item.approvalSignature : null } : item);
        persistir();
        return clonar(plano);
    }

    function cancelarItem(planoId, itemId) {
        const { plano, item } = localizar(planoId, itemId);
        if (!plano || !item || item.status === 'em andamento' || item.status === 'confirmada') return null;
        item.status = 'cancelado';
        item.approvalSignature = null;
        persistir();
        return clonar(plano);
    }

    /** Reabilita manualmente um item que falhou, sem reenvio automático. */
    function reagendarItem(planoId, itemId) {
        const { plano, item } = localizar(planoId, itemId);
        if (!plano || !item || item.status === 'em andamento' || item.status === 'confirmada') return null;
        item.status = aprovacaoValida(item) ? 'aprovado' : 'rascunho';
        item.motivo = null;
        persistir();
        return clonar(plano);
    }

    return { sincronizarPlanos, removerPlano, listarPlanos, executarCiclo, reconciliarItem, pausarPlano, retomarPlano, cancelarItem, reagendarItem, _estado: () => estado, _funcoes: { instanteDoItem, assinaturaDoItem, aprovacaoValida, atrasoMinutos } };
}

/** Adapta um item de agendamento para uma chamada única de InstagramService.publish(). */
function publicarItemNoInstagram(instagram) {
    return async ({ item, destino }) => {
        if (destino !== 'Instagram') throw Object.assign(new Error('Destino não implementado.'), { codigo: 'DESTINO_NAO_IMPLEMENTADO' });
        const caption = item.legenda || '';
        if (item.tipo === 'carrossel') {
            const resultado = await instagram.publish({ formato: 'carrossel', itens: Array.isArray(item.itens) ? item.itens : [], caption, publicacaoId: item.mediaId });
            return { id: resultado.mediaId };
        }
        const formato = item.tipo === 'video' ? 'reel' : 'imagem';
        const resultado = await instagram.publish({
            formato,
            mediaUrl: item.url,
            imageUrl: formato === 'imagem' ? item.url : undefined,
            videoUrl: formato === 'reel' ? item.url : undefined,
            caption,
            publicacaoId: item.mediaId
        });
        return { id: resultado.mediaId };
    };
}

module.exports = {
    criarMotor, publicarItemNoInstagram,
    criarArmazenamentoArquivo, criarArmazenamentoMemoria,
    ESTADOS_PLANO, ESTADOS_ITEM, DESTINOS, CODIGOS_INCERTOS,
    instanteDoItem, assinaturaDoItem, aprovacaoValida
};
