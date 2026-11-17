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
        if (nome === 'historico') carregarHistorico();
    }

    function quando(item) {
        try {
            const instantes = R.instantes(item.data, item.hora, item.timezone) || [];
            if (instantes.length === 1) return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: item.timezone }).format(new Date(instantes[0])) + ` (${item.timezone})`;
        } catch { /* textual */ }
        return `${item.data} ${item.hora} (${item.timezone})`;
    }

    function classe(estado) { return estado === 'confirmada' ? 'ok' : ['falhou', 'incerto', 'bloqueado', 'reagendado', 'vencido'].includes(estado) ? 'erro' : 'nota'; }

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
            const executar = elemento('button', 'Executar plano'); executar.type = 'button'; executar.onclick = () => executarPlano(p.id);
            const pausar = elemento('button', 'Pausar plano'); pausar.type = 'button'; pausar.disabled = p.status === 'pausado'; pausar.onclick = () => acao('/agenda/pausar', p.id);
            const retomar = elemento('button', 'Retomar plano'); retomar.type = 'button'; retomar.disabled = p.status !== 'pausado'; retomar.onclick = () => acao('/agenda/retomar', p.id);
            acoes.append(executar, pausar, retomar);
            for (const [rotulo, rota] of [['Cancelar plano', '/agenda/cancelar-plano'], ['Cancelar vencidos', '/agenda/cancelar-vencidos'], ['Excluir plano da agenda', '/agenda/excluir-plano']]) {
                const botao = elemento('button', rotulo); botao.type = 'button';
                botao.onclick = () => { if (confirm(`${rotulo}? Isso não apaga publicações nas redes. Exclusões preservam um registro local e não podem ser retomadas pelo painel.`)) acao(rota, p.id); };
                acoes.append(botao);
            }
            executar.disabled = p.status === 'cancelado';
            pausar.disabled = ['cancelado', 'pausado'].includes(p.status);
            bloco.append(acoes);
            for (const item of (p.itens || [])) {
                if (item.excluidoEm) continue;
                const linha = elemento('div', undefined, 'agenda-item');
                const prazo = PS.avaliarPrazo(item, Date.now(), item.timezone);
                linha.append(elemento('p', `Prazo máximo: ${prazo.limite || 'não informado'}${item.validadeConteudo?.dataEvento ? ' · Evento: ' + item.validadeConteudo.dataEvento : ''}`, 'nota'));
                const resultados = Object.entries(item.resultados || {});
                const detalhe = resultados.length ? ` · ${resultados.map(([destino, r]) => `${destino}: ${r.estado}${r.message ? ' — ' + r.message : ''}`).join(' | ')}` : '';
                linha.append(elemento('strong', `Destinos aprovados: ${(item.destinos || []).join(' + ')}`));
                if (!(item.destinos || []).some(d => d.startsWith('Facebook'))) linha.append(elemento('p', 'Este item NÃO está agendado para o Facebook.', 'nota'));
                linha.append(elemento('p', `${item.tipo} · ${quando(item)} · ${item.status}${detalhe}${item.motivo ? ' · ' + item.motivo : ''}`, classe(item.status)));
                if (item.legenda) linha.append(elemento('p', String(item.legenda).slice(0, 200), 'nota'));
                const controles = elemento('div', undefined, 'acoes');
                if (!['em andamento', 'confirmada', 'cancelado'].includes(item.status)) {
                    const exigeReagendamento = ['falhou', 'incerto', 'reagendado', 'vencido', 'bloqueado'].includes(item.status);
                    const editar = elemento('button', exigeReagendamento ? 'Editar/reagendar' : 'Editar'); editar.type = 'button'; editar.onclick = () => editarItem(p, item);
                    const cancelar = elemento('button', 'Cancelar'); cancelar.type = 'button'; cancelar.onclick = () => acaoItem('/agenda/cancelar', p.id, item.id);
                    controles.append(editar, cancelar);
                }
                linha.append(controles);
                const excluir = elemento('button', 'Excluir agendamento'); excluir.type = 'button';
                excluir.onclick = () => { if (confirm('Excluir este agendamento da lista? Os recibos serão preservados; nenhuma publicação será apagada nas redes.')) acaoItem('/agenda/excluir-item', p.id, item.id); };
                controles.append(excluir);
                bloco.append(linha);
            }
            container.append(bloco);
        }
    }

    async function acao(rota, planoId) { try { await ctx().cliente?.(rota, { planoId }, { prazo: 15000 }); avisar('Plano atualizado.'); carregar(); } catch (erro) { avisar(erro.message); } }
    async function acaoItem(rota, planoId, itemId) { try { await ctx().cliente?.(rota, { planoId, itemId }, { prazo: 15000 }); avisar('Item atualizado.'); carregar(); } catch (erro) { avisar(erro.message); } }

    /** Executa apenas o plano escolhido por ação explícita do usuário. */
    async function executarPlano(planoId) {
        try {
            const r = await ctx().cliente?.('/agenda/executar', { planoId }, { prazo: 120000 });
            avisar(`Plano executado: ${r?.confirmados || 0} confirmada(s), ${r?.incertos || 0} incerta(s), ${r?.falhas || 0} falha(s).`);
            carregar();
        } catch (erro) { avisar(erro.message); }
    }

    /** Edita data/hora/legenda e exige nova aprovação do item. */
    async function editarItem(planoRemoto, item) {
        const prazoMaximoAgendamento = prompt('Prazo máximo para publicar (AAAA-MM-DD). O padrão é o dia anterior ao evento; a data agendada não define a validade:', PS.avaliarPrazo(item).limite || '');
        if (prazoMaximoAgendamento === null) return;
        if (!PS.dataValida(prazoMaximoAgendamento)) { avisar('Prazo máximo inválido.'); return; }
        const novaData = prompt('Nova data (AAAA-MM-DD):', item.data); if (!novaData) return;
        const novaHora = prompt('Novo horário (HH:MM):', item.hora); if (!novaHora) return;
        const nova = prompt('Nova legenda:', item.legenda || ''); if (nova === null) return;
        if (R.instantes(novaData, novaHora, item.timezone).length !== 1) { avisar('Data/hora inválidas no timezone do item.'); return; }
        const prazo = PS.avaliarPrazo({ ...item, prazoMaximoAgendamento }, R.instantes(novaData, novaHora, item.timezone)[0], item.timezone);
        if (!prazo.elegivel) { avisar(prazo.motivo); return; }
        const plano = PS.editarItem({ id: planoRemoto.id, itens: planoRemoto.itens, status: planoRemoto.status, timezone: item.timezone, config: {} }, item.id, { data: novaData, hora: novaHora, legenda: nova, prazoMaximoAgendamento });
        const aprovado = PS.aprovar(plano);
        try { await ctx().cliente?.('/agenda/planos', { planos: [aprovado] }, { prazo: 15000 }); avisar('Item reeditado (nova aprovação).'); carregar(); }
        catch (erro) { avisar(erro.message); }
    }

    /** Lista recibos locais e consulta links apenas por ação explícita, sem republicar. */
    async function carregarHistorico() {
        const lista = $('lista-historico');
        if (!lista) return;
        lista.replaceChildren(elemento('p', 'Carregando…'));
        try {
            const dados = await ctx().cliente('/publicacoes/historico');
            lista.replaceChildren();
            if (!dados.historico.length) lista.append(elemento('p', 'Nenhum envio registrado nesta instalação.'));
            for (const registro of dados.historico) {
                const linha = elemento('article', undefined, 'cartao');
                linha.append(elemento('p', `${registro.destino} · ${registro.estado} · ${registro.publicadoEm ? new Date(registro.publicadoEm).toLocaleString('pt-BR') : 'Data indisponível'}`));
                if (registro.idPublicado) linha.append(elemento('p', `ID: ${registro.idPublicado}`, 'nota'));
                if (registro.permalink && /^https:\/\/(?:[a-z0-9-]+\.)*(?:facebook\.com|instagram\.com)\//i.test(registro.permalink)) {
                    const link = elemento('a', 'Abrir publicação ↗'); link.href = registro.permalink; link.target = '_blank'; link.rel = 'noopener noreferrer'; linha.append(link);
                } else if (registro.idPublicado && !registro.chave.startsWith('resultado:')) {
                    const botao = elemento('button', 'Consultar link da publicação'); botao.type = 'button';
                    botao.onclick = async () => {
                        botao.disabled = true;
                        try {
                            const resposta = await ctx().cliente(`/publicacoes/link?chave=${encodeURIComponent(registro.chave)}`);
                            if (!resposta.permalink) { botao.textContent = 'Link indisponível (Story pode ter expirado)'; return; }
                            const url = new URL(resposta.permalink);
                            if (url.protocol !== 'https:' || !/^(?:[a-z0-9-]+\.)*(?:facebook\.com|instagram\.com)$/.test(url.hostname) || url.username || url.password) throw new Error('Link retornado não pertence à Meta.');
                            const link = elemento('a', 'Abrir publicação ↗'); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
                            botao.replaceWith(link);
                        } catch (erro) { botao.textContent = 'Tentar consultar link novamente'; botao.disabled = false; avisar(erro.message); }
                    };
                    linha.append(botao);
                }
                lista.append(linha);
            }
        } catch (erro) { lista.replaceChildren(elemento('p', `Não foi possível carregar: ${erro.message}`, 'erro')); }
    }

    function iniciar() {
        for (const botao of document.querySelectorAll('[data-view]')) botao.onclick = () => trocarView(botao.dataset.view);
        if ($('atualizar-agendamentos')) $('atualizar-agendamentos').onclick = carregar;
        if ($('atualizar-historico')) $('atualizar-historico').onclick = carregarHistorico;
        carregar();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
    else iniciar();
    globalThis.Agendamentos = { iniciar, carregar };
})();
