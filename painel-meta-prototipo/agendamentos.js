'use strict';

/*
 * Página exclusiva de Agendamentos: visualizar, pausar, retomar, cancelar,
 * reagendar e editar planos. Não publica: a execução é do SchedulerService,
 * que chama o mesmo InstagramService.publish().
 */

(function () {
    const PS = globalThis.PlanejamentoSemanal;
    const R = globalThis.Regras;
    const $ = id => document.getElementById(id);
    const ctx = () => globalThis.AstraContexto || {};

    function avisar(texto) { ctx().avisar?.(texto); }
    function elemento(tag, texto, classe) { const el = document.createElement(tag); if (texto !== undefined) el.textContent = texto; if (classe) el.className = classe; return el; }

    function trocarView(nome) {
        for (const view of document.querySelectorAll('.view')) view.hidden = view.id !== `view-${nome}`;
        for (const botao of document.querySelectorAll('[data-view]')) botao.setAttribute('aria-pressed', String(botao.dataset.view === nome));
        if (nome === 'agendamentos') carregar();
    }

    function quando(item) {
        try {
            const instantes = R.instantes(item.data, item.hora, item.timezone) || [];
            if (instantes.length === 1) return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: item.timezone }).format(new Date(instantes[0])) + ` (${item.timezone})`;
        } catch { /* textual */ }
        return `${item.data} ${item.hora} (${item.timezone})`;
    }

    function classe(estado) { return estado === 'confirmada' ? 'ok' : ['falhou', 'incerto', 'bloqueado', 'reagendado'].includes(estado) ? 'pendente' : 'nota'; }

    async function carregar() {
        const container = $('lista-agendamentos');
        if (!container) return;
        container.replaceChildren(elemento('p', 'Carregando agendamentos…', 'nota'));
        let planos;
        try { planos = (await ctx().cliente?.('/agenda/planos', undefined, { prazo: 10000 }))?.planos || []; }
        catch (erro) { container.replaceChildren(elemento('p', `Servidor local indisponível: ${erro.message}`, 'pendente')); return; }
        container.replaceChildren();
        if (!planos.length) { container.append(elemento('p', 'Nenhum agendamento. Use a aba Agendamento no Editor.', 'nota')); return; }
        for (const p of planos) {
            const bloco = elemento('article', undefined, 'cartao');
            bloco.append(elemento('strong', `${p.nome || p.id} · ${p.status} · ${(p.itens || []).length} item(ns)`));
            const acoes = elemento('div', undefined, 'acoes');
            const pausar = elemento('button', 'Pausar plano'); pausar.type = 'button'; pausar.disabled = p.status === 'pausado'; pausar.onclick = () => acao('/agenda/pausar', p.id);
            const retomar = elemento('button', 'Retomar plano'); retomar.type = 'button'; retomar.disabled = p.status !== 'pausado'; retomar.onclick = () => acao('/agenda/retomar', p.id);
            acoes.append(pausar, retomar);
            bloco.append(acoes);
            for (const item of (p.itens || [])) {
                const linha = elemento('div', undefined, 'agenda-item');
                const resultados = item.resultados ? Object.values(item.resultados) : [];
                const detalhe = resultados.length ? ` · ${resultados.map(r => r.estado + (r.idPublicado ? ` (${r.idPublicado})` : '')).join(', ')}` : '';
                linha.append(elemento('p', `${item.tipo} · ${quando(item)} · ${item.status}${detalhe}${item.motivo ? ' · ' + item.motivo : ''}`, classe(item.status)));
                if (item.legenda) linha.append(elemento('p', String(item.legenda).slice(0, 200), 'nota'));
                const controles = elemento('div', undefined, 'acoes');
                if (['falhou', 'incerto', 'reagendado', 'bloqueado'].includes(item.status)) { const t = elemento('button', 'Tentar novamente'); t.type = 'button'; t.onclick = () => acaoItem('/agenda/reagendar', p.id, item.id); controles.append(t); }
                if (!['em andamento', 'confirmada', 'cancelado'].includes(item.status)) {
                    const editar = elemento('button', 'Editar'); editar.type = 'button'; editar.onclick = () => editarItem(p, item);
                    const cancelar = elemento('button', 'Cancelar'); cancelar.type = 'button'; cancelar.onclick = () => acaoItem('/agenda/cancelar', p.id, item.id);
                    controles.append(editar, cancelar);
                }
                linha.append(controles);
                bloco.append(linha);
            }
            container.append(bloco);
        }
    }

    async function acao(rota, planoId) { try { await ctx().cliente?.(rota, { planoId }, { prazo: 15000 }); avisar('Plano atualizado.'); carregar(); } catch (erro) { avisar(erro.message); } }
    async function acaoItem(rota, planoId, itemId) { try { await ctx().cliente?.(rota, { planoId, itemId }, { prazo: 15000 }); avisar('Item atualizado.'); carregar(); } catch (erro) { avisar(erro.message); } }

    /** Edita data/hora/legenda e exige nova aprovação do item. */
    async function editarItem(planoRemoto, item) {
        const novaData = prompt('Nova data (AAAA-MM-DD):', item.data); if (!novaData) return;
        const novaHora = prompt('Novo horário (HH:MM):', item.hora); if (!novaHora) return;
        const nova = prompt('Nova legenda:', item.legenda || ''); if (nova === null) return;
        if (R.instantes(novaData, novaHora, item.timezone).length !== 1) { avisar('Data/hora inválidas no timezone do item.'); return; }
        const plano = PS.editarItem({ id: planoRemoto.id, itens: planoRemoto.itens, status: planoRemoto.status, timezone: item.timezone, config: {} }, item.id, { data: novaData, hora: novaHora, legenda: nova });
        const aprovado = PS.aprovar(plano);
        try { await ctx().cliente?.('/agenda/planos', { planos: [aprovado] }, { prazo: 15000 }); avisar('Item reeditado (nova aprovação).'); carregar(); }
        catch (erro) { avisar(erro.message); }
    }

    function iniciar() {
        for (const botao of document.querySelectorAll('[data-view]')) botao.onclick = () => trocarView(botao.dataset.view);
        if ($('atualizar-agendamentos')) $('atualizar-agendamentos').onclick = carregar;
        if ($('executar-agenda')) $('executar-agenda').onclick = async () => {
            try { const r = await ctx().cliente?.('/agenda/executar', {}, { prazo: 120000 }); avisar(`Execução: ${r?.confirmados || 0} confirmada(s), ${r?.incertos || 0} incerta(s), ${r?.falhas || 0} falha(s).`); carregar(); }
            catch (erro) { avisar(erro.message); }
        };
        carregar();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
    else iniciar();
    globalThis.Agendamentos = { iniciar, carregar };
})();
