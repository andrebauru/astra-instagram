'use strict';

/*
 * Página Logs e logger do frontend.
 *
 * - AstraLogs.registrar(): envia eventos ao backend (persistentes, mascarados).
 * - Página Logs: filtros, paginação, atualização, detalhes e estados vazios.
 *
 * Nunca envia segredos e nunca lança: a falha de log não pode quebrar a UI.
 */

(function () {
    const $ = id => document.getElementById(id);
    const NIVEIS = ['DEBUG', 'INFO', 'WARNING', 'ERROR'];
    let cliente = null;
    let timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    let buffer = [];
    let enviando = false;
    let temporizador = null;
    let pagina = 1;
    let paginas = 1;
    let total = 0;
    let ultimosItens = [];
    let timerPagina = null;
    let vistaVisivel = () => !$('view-logs')?.hidden;

    /** Enfileira um evento; nunca lança. */
    function registrar(entrada = {}) {
        try {
            buffer.push({
                nivel: NIVEIS.includes(String(entrada.nivel || '').toUpperCase()) ? String(entrada.nivel).toUpperCase() : 'INFO',
                modulo: String(entrada.modulo || 'FRONTEND').slice(0, 60),
                acao: String(entrada.acao || 'evento').slice(0, 120),
                status: entrada.status !== undefined && entrada.status !== null ? String(entrada.status).slice(0, 60) : null,
                operationId: entrada.operationId ? String(entrada.operationId).slice(0, 120) : null,
                plataforma: entrada.plataforma ? String(entrada.plataforma).slice(0, 40) : null,
                superficie: entrada.superficie ? String(entrada.superficie).slice(0, 40) : null,
                mensagem: entrada.mensagem ? String(entrada.mensagem).slice(0, 800) : null,
                codigo: entrada.codigo ? String(entrada.codigo).slice(0, 80) : null,
                httpStatus: Number.isFinite(Number(entrada.httpStatus)) ? Number(entrada.httpStatus) : null,
                contexto: entrada.contexto && typeof entrada.contexto === 'object' ? entrada.contexto : null,
                timezone
            });
            if (buffer.length > 200) buffer = buffer.slice(-200);
            clearTimeout(temporizador);
            temporizador = setTimeout(despejar, 800);
            if (vistaVisivel() && buffer.length >= 5) despejar();
        } catch { /* log nunca quebra a UI */ }
    }

    /** Envia o buffer em lote; em falha, mantém no buffer para nova tentativa. */
    async function despejar() {
        if (enviando || !cliente || !buffer.length) return;
        enviando = true;
        const lote = buffer.splice(0, 50);
        try { await cliente('/logs/event', { eventos: lote }); }
        catch { buffer = [...lote, ...buffer].slice(-200); }
        finally { enviando = false; if (buffer.length) { clearTimeout(temporizador); temporizador = setTimeout(despejar, 2000); } }
    }

    function parametros() {
        const p = {};
        const valor = id => ($(id)?.value || '').trim();
        if (valor('logs-nivel')) p.nivel = valor('logs-nivel');
        if (valor('logs-modulo')) p.modulo = valor('logs-modulo');
        if (valor('logs-plataforma')) p.plataforma = valor('logs-plataforma');
        if (valor('logs-status')) p.status = valor('logs-status');
        if (valor('logs-operation')) p.operationId = valor('logs-operation');
        if (valor('logs-busca')) p.busca = valor('logs-busca');
        if (valor('logs-desde')) p.desde = `${valor('logs-desde')}T00:00:00.000Z`;
        if (valor('logs-ate')) p.ate = `${valor('logs-ate')}T23:59:59.999Z`;
        p.pagina = pagina;
        p.limite = 50;
        return p;
    }

    function formatarBytes(bytes) {
        const v = Number(bytes) || 0;
        if (v < 1024) return `${v} B`;
        if (v < 1048576) return `${(v / 1024).toFixed(1)} KB`;
        return `${(v / 1048576).toFixed(1)} MB`;
    }

    function classe(nivel) { return nivel === 'ERROR' ? 'pendente' : nivel === 'WARNING' ? 'pendente' : nivel === 'DEBUG' ? 'nota' : 'ok'; }

    function preencherSelect(id, valores, rotulo) {
        const seletor = $(id);
        if (!seletor) return;
        const atual = seletor.value;
        seletor.replaceChildren(new Option(rotulo, ''));
        for (const valor of valores || []) seletor.append(new Option(valor, valor));
        if ([...(seletor.options || [])].some(o => o.value === atual)) seletor.value = atual;
    }

    function renderizarLista(dados) {
        const lista = $('logs-lista');
        if (!lista) return;
        lista.replaceChildren();
        ultimosItens = dados.itens || [];
        if (!ultimosItens.length) { lista.append(elemento('p', 'Nenhum log encontrado para os filtros atuais.', 'nota')); return; }
        for (const item of ultimosItens) {
            const linha = elemento('button', undefined, 'agenda-item');
            linha.type = 'button';
            const hora = new Date(item.ts).toLocaleString('pt-BR');
            linha.append(elemento('strong', `[${item.nivel}] ${item.modulo} · ${item.acao}`));
            linha.append(elemento('p', `${hora}${item.status ? ' · ' + item.status : ''}${item.plataforma ? ' · ' + item.plataforma + (item.superficie ? '/' + item.superficie : '') : ''}${item.codigo ? ' · ' + item.codigo : ''}`, classe(item.nivel)));
            if (item.mensagem) linha.append(elemento('p', item.mensagem, 'nota'));
            linha.onclick = () => { const d = $('logs-detalhe'); if (d) d.textContent = JSON.stringify(item, null, 2); };
            lista.append(linha);
        }
    }

    async function carregarResumo() {
        try {
            const r = await cliente('/logs/resumo');
            const resumo = $('logs-resumo');
            if (resumo) resumo.textContent = `${r.total} evento(s) · ${r.erros} erro(s) · ${(r.arquivos || []).length} arquivo(s) · ${formatarBytes(r.totalBytes)} · retenção ${r.retencaoDias} dias`;
        } catch { /* resumo é opcional */ }
    }

    /** Consulta paginada; chamada por filtros, botões e atualização periódica. */
    async function carregar(novaPagina) {
        if (!cliente) return;
        if (novaPagina) pagina = novaPagina;
        try {
            const r = await cliente('/logs', undefined, { params: parametros() });
            paginas = r.paginas || 1; total = r.total || 0;
            preencherSelect('logs-modulo', r.filtrosDisponiveis?.modulos, 'Todos');
            preencherSelect('logs-plataforma', r.filtrosDisponiveis?.plataformas, 'Todas');
            preencherSelect('logs-status', r.filtrosDisponiveis?.status, 'Todos');
            renderizarLista(r);
            const info = $('logs-pagina'); if (info) info.textContent = `Página ${pagina} de ${paginas} · ${total} evento(s)`;
            if ($('logs-anterior')) $('logs-anterior').disabled = pagina <= 1;
            if ($('logs-proxima')) $('logs-proxima').disabled = pagina >= paginas;
            if ($('logs-resumo') && !$('logs-resumo').textContent.includes('arquivo')) carregarResumo();
        } catch (erro) {
            const lista = $('logs-lista');
            if (lista) lista.replaceChildren(elemento('p', `Não foi possível carregar os logs: ${erro.message}`, 'pendente'));
        }
    }

    function elemento(tag, texto, classe) {
        const el = document.createElement(tag);
        if (texto !== undefined) el.textContent = texto;
        if (classe) el.className = classe;
        return el;
    }

    /** Liga os controles da página e inicia a atualização leve. */
    function iniciar(opcoes = {}) {
        if (opcoes.cliente) cliente = opcoes.cliente;
        if (opcoes.timezone) timezone = opcoes.timezone;
        if (!cliente || !$('logs-atualizar')) return;
        for (const id of ['logs-nivel', 'logs-modulo', 'logs-plataforma', 'logs-status', 'logs-desde', 'logs-ate']) if ($(id)) $(id).onchange = () => { pagina = 1; carregar(); };
        if ($('logs-busca')) $('logs-busca').oninput = () => { clearTimeout(temporizador); temporizador = setTimeout(() => { pagina = 1; carregar(); }, 400); };
        if ($('logs-operation')) $('logs-operation').oninput = () => { clearTimeout(temporizador); temporizador = setTimeout(() => { pagina = 1; carregar(); }, 400); };
        if ($('logs-atualizar')) $('logs-atualizar').onclick = () => { despejar(); carregar(); carregarResumo(); };
        if ($('logs-anterior')) $('logs-anterior').onclick = () => carregar(Math.max(1, pagina - 1));
        if ($('logs-proxima')) $('logs-proxima').onclick = () => carregar(Math.min(paginas, pagina + 1));
        if ($('logs-limpar')) $('logs-limpar').onclick = () => {
            for (const id of ['logs-nivel', 'logs-modulo', 'logs-plataforma', 'logs-status', 'logs-operation', 'logs-busca', 'logs-desde', 'logs-ate']) if ($(id)) $(id).value = '';
            pagina = 1; carregar();
        };
        carregarResumo(); carregar();
        // Atualização leve somente quando a página está visível.
        clearInterval(timerPagina);
        timerPagina = setInterval(() => { if (vistaVisivel()) { despejar(); carregar(); carregarResumo(); } }, 15000);
    }

    globalThis.AstraLogs = { registrar, iniciar, carregar, carregarResumo, despejar, _buffer: () => buffer };
})();
