'use strict';

/*
 * Página exclusiva de Agendamentos.
 *
 * Gerencia apenas data, hora, timezone, persistência, execução, status e
 * cancelamento. Não duplica publicação: a execução é feita pelo
 * SchedulerService, que chama o mesmo InstagramService do botão "Publicar agora".
 */

(function () {
    const PS = globalThis.PlanejamentoSemanal;
    const $ = id => document.getElementById(id);
    const ctx = () => globalThis.AstraContexto || {};
    const R = globalThis.Regras;
    let plano = null;
    let selecionados = new Set();

    function status(texto, classe = 'nota') { const el = $('semana-status'); if (el) { el.textContent = texto; el.className = classe; } }
    function avisar(texto) { ctx().avisar?.(texto); }

    // ========================================================
    // NAVEGAÇÃO ENTRE VIEWS
    // ========================================================
    function trocarView(nome) {
        for (const view of document.querySelectorAll('.view')) view.hidden = view.id !== `view-${nome}`;
        for (const botao of document.querySelectorAll('[data-view]')) botao.setAttribute('aria-pressed', String(botao.dataset.view === nome));
        window.registrarDiagnostico?.('NAVIGATION', 'view_change', { view: nome });
        if (nome === 'agendamentos') carregar();
    }

    // ========================================================
    // DADOS DO SERVIDOR
    // ========================================================
    async function listar() {
        try { const resposta = await ctx().cliente?.('/agenda/planos', undefined, { prazo: 10000 }); return Array.isArray(resposta?.planos) ? resposta.planos : []; }
        catch { return null; }
    }

    async function sincronizar(planos) {
        try { return await ctx().cliente?.('/agenda/planos', { planos }, { prazo: 15000 }); }
        catch (erro) { status(`Sem conexão com o servidor de execução: ${erro.message}`); return null; }
    }

    function formatarQuando(item) {
        try {
            const instantes = R.instantes(item.data, item.hora, item.timezone) || [];
            if (instantes.length === 1) return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: item.timezone }).format(new Date(instantes[0])) + ` (${item.timezone})`;
        } catch { /* representação textual */ }
        return `${item.data} ${item.hora} (${item.timezone})`;
    }

    function classeStatus(estado) {
        if (estado === 'confirmada') return 'ok';
        if (['falhou', 'incerto', 'bloqueado', 'reagendado'].includes(estado)) return 'pendente';
        return 'nota';
    }

    // ========================================================
    // RENDERIZAÇÃO
    // ========================================================
    async function carregar() {
        const container = $('lista-agendamentos');
        if (!container) return;
        container.replaceChildren(elemento('p', 'Carregando agendamentos…', 'nota'));
        const planos = await listar();
        if (planos === null) { container.replaceChildren(elemento('p', 'Servidor local offline. Inicie o Astra Instagram para ver os agendamentos.', 'nota')); return; }
        container.replaceChildren();
        if (!planos.length) { container.append(elemento('p', 'Nenhum agendamento. Use "Planejar semana" ou adicione na página Editor.', 'nota')); return; }
        for (const p of planos) {
            const bloco = elemento('article', undefined, 'cartao');
            const cabecalho = elemento('div', undefined, 'cabecalho-mini');
            cabecalho.append(elemento('strong', `Plano ${p.id}`), elemento('span', ` · ${p.status}`));
            bloco.append(cabecalho);
            const acoes = elemento('div', undefined, 'acoes');
            const pausar = elemento('button', 'Pausar plano'); pausar.type = 'button'; pausar.disabled = p.status === 'pausado';
            pausar.onclick = () => acaoPlano('/agenda/pausar', p.id);
            const retomar = elemento('button', 'Retomar plano'); retomar.type = 'button'; retomar.disabled = p.status !== 'pausado';
            retomar.onclick = () => acaoPlano('/agenda/retomar', p.id);
            acoes.append(pausar, retomar);
            bloco.append(acoes);

            for (const item of (p.itens || [])) {
                const linha = elemento('div', undefined, 'agenda-item');
                const resultados = item.resultados ? Object.values(item.resultados) : [];
                const detalhe = resultados.length ? ` · ${resultados.map(r => r.estado + (r.idPublicado ? ` (${r.idPublicado})` : '')).join(', ')}` : '';
                const pendencia = item.motivo ? ` · ${item.motivo}` : '';
                linha.append(elemento('p', `${item.tipo} · ${formatarQuando(item)} · ${item.status}${detalhe}${pendencia}`, classeStatus(item.status)));
                if (item.legenda) linha.append(elemento('p', item.legenda.slice(0, 200), 'nota'));
                const controles = elemento('div', undefined, 'acoes');
                if (['falhou', 'incerto', 'reagendado', 'bloqueado'].includes(item.status)) {
                    const tentar = elemento('button', 'Tentar novamente'); tentar.type = 'button';
                    tentar.onclick = () => acaoItem('/agenda/reagendar', p.id, item.id);
                    controles.append(tentar);
                }
                if (!['em andamento', 'confirmada', 'cancelado'].includes(item.status)) {
                    const editar = elemento('button', 'Editar horário/legenda'); editar.type = 'button';
                    editar.onclick = () => editarItem(p, item);
                    const remover = elemento('button', 'Cancelar item'); remover.type = 'button';
                    remover.onclick = () => acaoItem('/agenda/cancelar', p.id, item.id);
                    controles.append(editar, remover);
                }
                linha.append(controles);
                bloco.append(linha);
            }
            container.append(bloco);
        }
    }

    async function acaoPlano(rota, planoId) {
        try { await ctx().cliente?.(rota, { planoId }, { prazo: 15000 }); avisar('Agendamento atualizado.'); carregar(); }
        catch (erro) { avisar(erro.message); }
    }

    async function acaoItem(rota, planoId, itemId) {
        try { await ctx().cliente?.(rota, { planoId, itemId }, { prazo: 15000 }); avisar('Item atualizado.'); carregar(); }
        catch (erro) { avisar(erro.message); }
    }

    /** Edita legenda/data/hora e exige nova aprovação do item. */
    async function editarItem(planoRemoto, item) {
        const novaData = prompt('Nova data (AAAA-MM-DD):', item.data);
        if (!novaData) return;
        const novaHora = prompt('Novo horário (HH:MM):', item.hora);
        if (!novaHora) return;
        const nova = prompt('Nova legenda:', item.legenda || '');
        if (nova === null) return;
        if (R.instantes(novaData, novaHora, item.timezone).length !== 1) { avisar('Data/hora inválidas no timezone do item.'); return; }
        const base = plano || { id: planoRemoto.id, itens: planoRemoto.itens, status: planoRemoto.status, timezone: item.timezone, config: {} };
        plano = PS.editarItem({ ...base, id: planoRemoto.id }, item.id, { data: novaData, hora: novaHora, legenda: nova });
        plano = PS.aprovar(plano);
        await sincronizar([plano]);
        avisar('Item reeditado e reafirmado (nova aprovação).');
        carregar();
    }

    // ========================================================
    // PLANEJAR SEMANA
    // ========================================================
    function lerConfig() {
        const dias = [...document.querySelectorAll('.semana-dia')].filter(i => i.checked).map(i => Number(i.value));
        const horarios = String($('semana-horarios').value || '').split(',').map(i => i.trim()).filter(Boolean);
        const anterior = plano?.config || {};
        return {
            id: anterior.id || `plano-${crypto.randomUUID()}`,
            semente: anterior.semente || crypto.randomUUID(),
            inicio: $('semana-inicio').value, fim: $('semana-fim').value,
            dias, horarios,
            porDia: Number($('semana-quantidade').value) || 1,
            intervalo: Number($('semana-intervalo').value) || 60,
            modo: $('semana-modo').value,
            tipos: ['imagem', 'video', 'carrossel'],
            timezone: $('semana-fuso').value || 'Asia/Tokyo',
            atraso: $('semana-atraso').value,
            toleranciaMinutos: Number($('semana-tolerancia').value) || 30
        };
    }

    async function gerar() {
        const midias = ctx().obterMidias?.() || [];
        const config = lerConfig();
        const novo = PS.planejar(config, midias);
        if (!novo.itens.length) { status(novo.erros.join(' ') || 'Nenhuma mídia elegível no período.'); return; }
        plano = novo;
        selecionados = new Set(plano.itens.map(i => i.id));
        const reservadas = PS.reservarMidias(plano, ctx().obterMidias?.() || []);
        ctx().gravar?.('biblioteca-midias', reservadas).catch(() => {});
        renderPlano();
        status(plano.faltam ? `Rascunho com ${plano.itens.length} item(ns). ${plano.erros.join(' ')}` : `Rascunho com ${plano.itens.length} item(ns), sem repetição.`, plano.faltam ? 'pendente' : 'ok');
    }

    async function aprovar() {
        if (!plano || !plano.itens.length) { status('Gere um rascunho antes de aprovar.'); return; }
        plano = PS.aprovar(plano);
        const resposta = await sincronizar([plano]);
        renderPlano();
        status(resposta ? `Programação aprovada para ${plano.itens.length} item(ns).` : 'Aprovada localmente; o servidor não confirmou.', resposta ? 'ok' : 'pendente');
    }

    async function pausar() {
        if (!plano) return;
        plano = PS.pausar(plano);
        try { await ctx().cliente?.('/agenda/pausar', { planoId: plano.id }, { prazo: 15000 }); } catch { /* offline */ }
        renderPlano();
        status('Programação pausada.');
    }

    async function regenerar() {
        if (!plano || !selecionados.size) { status('Selecione ao menos um item para regenerar.'); return; }
        const midias = ctx().obterMidias?.() || [];
        const usados = new Set(plano.itens.filter(i => !selecionados.has(i.id)).flatMap(i => [i.mediaId, ...(i.itens || []).map(e => e.mediaId)]));
        const disponiveis = midias.filter(m => !usados.has(m.id) && m.status !== 'utilizada');
        let alterados = 0;
        for (const item of plano.itens) {
            if (!selecionados.has(item.id)) continue;
            const candidata = disponiveis.find(m => m.id !== item.mediaId);
            if (!candidata) continue;
            disponiveis.splice(disponiveis.indexOf(candidata), 1);
            item.mediaId = candidata.id; item.tipo = candidata.tipo; item.miniatura = candidata.miniatura || candidata.dados || null;
            item.url = PS.urlDaMidia?.(candidata) || null;
            item.itens = Array.isArray(candidata.itens) && candidata.itens.length ? candidata.itens.map((e, ordem) => ({ mediaId: e.id || e.mediaId, ordem, tipo: e.tipo, url: PS.urlDaMidia?.(e) || null })) : null;
            item.status = 'rascunho'; item.approvalSignature = null; alterados++;
        }
        if (!alterados) { status('Sem mídia disponível para regenerar.'); return; }
        if (plano.itens.some(i => i.status === 'rascunho')) plano.status = 'parcialmente aprovado';
        await sincronizar([plano]);
        renderPlano();
        status(`${alterados} item(ns) regenerado(s); exigem nova aprovação.`);
    }

    function renderPlano() {
        const container = $('calendario-semanal');
        if (!container) return;
        container.replaceChildren();
        if (!plano) return;
        for (const item of plano.itens) {
            const cartao = elemento('div', undefined, 'plano-item');
            const check = document.createElement('input'); check.type = 'checkbox'; check.checked = selecionados.has(item.id);
            check.setAttribute('aria-label', `Selecionar item de ${formatarQuando(item)}`);
            check.onchange = () => { if (check.checked) selecionados.add(item.id); else selecionados.delete(item.id); };
            const conteudo = elemento('div', undefined, 'plano-conteudo');
            conteudo.append(elemento('strong', `${item.tipo} · ${formatarQuando(item)} · ${item.status}`));
            if (item.miniatura) { const img = elemento('img'); img.src = item.miniatura; img.className = 'plano-miniatura'; img.alt = 'Miniatura'; conteudo.append(img); }
            conteudo.append(elemento('p', PS.pendenciasDeExecucao({ itens: [item] }).length ? 'Pendência: mídia sem URL pública.' : 'Mídia pronta.', PS.pendenciasDeExecucao({ itens: [item] }).length ? 'pendente' : 'ok'));
            cartao.append(check, conteudo);
            container.append(cartao);
        }
        const contagem = plano.itens.reduce((t, i) => { t[i.status] = (t[i.status] || 0) + 1; return t; }, {});
        container.prepend(elemento('p', `Plano ${plano.id} · ${plano.status} · ${Object.entries(contagem).map(([k, v]) => `${k}: ${v}`).join(' · ')}`, 'nota'));
    }

    // ========================================================
    // INICIALIZAÇÃO
    // ========================================================
    function iniciar() {
        for (const botao of document.querySelectorAll('[data-view]')) botao.onclick = () => trocarView(botao.dataset.view);
        if ($('atualizar-agendamentos')) $('atualizar-agendamentos').onclick = carregar;
        if ($('executar-agenda')) $('executar-agenda').onclick = async () => {
            try { const r = await ctx().cliente?.('/agenda/executar', {}, { prazo: 120000 }); avisar(`Execução: ${r?.confirmados || 0} confirmada(s), ${r?.incertos || 0} incerta(s), ${r?.falhas || 0} falha(s).`); carregar(); }
            catch (erro) { avisar(erro.message); }
        };
        if ($('gerar-plano-semanal')) $('gerar-plano-semanal').onclick = gerar;
        if ($('aprovar-plano-semanal')) $('aprovar-plano-semanal').onclick = aprovar;
        if ($('pausar-plano-semanal')) $('pausar-plano-semanal').onclick = pausar;
        if ($('regenerar-semana')) $('regenerar-semana').onclick = regenerar;
        const inicio = $('semana-inicio');
        if (inicio && !inicio.value) { inicio.value = new Date().toISOString().slice(0, 10); const fim = new Date(inicio.value + 'T12:00:00Z'); fim.setUTCDate(fim.getUTCDate() + 6); $('semana-fim').value = fim.toISOString().slice(0, 10); }
        if ($('semana-fuso') && !$('semana-fuso').value) $('semana-fuso').value = 'Asia/Tokyo';
        carregar();
    }

    function elemento(tag, texto, classe) {
        const el = document.createElement(tag);
        if (texto !== undefined) el.textContent = texto;
        if (classe) el.className = classe;
        return el;
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
    else iniciar();
    globalThis.Agendamentos = { iniciar, carregar };
})();
