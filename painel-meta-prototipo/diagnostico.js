'use strict';

let ativo = false;
let solicitarBridge;
let tokenDiagnostico;
let ultimoOperationId = null;

/** Envia somente eventos estruturados e correlacionados quando a sessão está ativa. */
function registrarDiagnostico(secao, evento, dados = {}) {
    if (!ativo || !solicitarBridge || !tokenDiagnostico) return;
    const operationId = dados.operationId || ultimoOperationId || crypto.randomUUID();
    ultimoOperationId = operationId;
    solicitarBridge('/diagnostico/event', { section: secao, event: evento, data: { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, screen: document.querySelector('[role=tab][aria-selected=true]')?.getAttribute('aria-controls') || location.pathname, operationId, ...dados } }, { diagnosticoToken: tokenDiagnostico }).catch(() => {});
}

/** Formata bytes sem sugerir precisão maior que a disponível. */
function formatarBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** Atualiza o painel com o estado confirmado pelo backend. */
function mostrarEstado(estado) {
    ativo = estado.enabled === true;
    const resumo = document.getElementById('diagnostico-estado');
    if (!resumo) return;
    const expiracao = estado.expiresAt ? new Date(estado.expiresAt).toLocaleString('pt-BR') : 'não iniciada';
    resumo.textContent = ativo ? `Ativo até ${expiracao} · ${formatarBytes(estado.totalBytes || 0)} em ${(estado.files || []).length} arquivo(s).` : `Inativo · última expiração/encerramento: ${expiracao} · ${formatarBytes(estado.totalBytes || 0)} armazenados.`;
    document.getElementById('iniciar-diagnostico').disabled = ativo;
    document.getElementById('encerrar-diagnostico').disabled = !ativo;
    document.getElementById('marcar-problema').disabled = !ativo;
}

/** Consulta o estado autenticado sem bloquear o uso normal do editor. */
async function atualizarEstadoDiagnostico() {
    if (!solicitarBridge || !tokenDiagnostico) return;
    try { mostrarEstado(await solicitarBridge('/diagnostico/status', undefined, { diagnosticoToken: tokenDiagnostico })); }
    catch { ativo = false; }
}

/** Cria e conecta os controles temporários de diagnóstico. */
function conectarPainelDiagnostico() {
    const iniciar = document.getElementById('iniciar-diagnostico');
    if (!iniciar || iniciar.dataset.conectado) return;
    iniciar.dataset.conectado = 'true';
    iniciar.onclick = async () => {
        const resposta = await solicitarBridge('/diagnostico/start', { hours: 48, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }, { diagnosticoToken: tokenDiagnostico });
        mostrarEstado(resposta); registrarDiagnostico('FRONTEND', 'diagnostic_ui_started', { result: 'salvo localmente' });
    };
    document.getElementById('encerrar-diagnostico').onclick = async () => mostrarEstado(await solicitarBridge('/diagnostico/stop', {}, { diagnosticoToken: tokenDiagnostico }));
    document.getElementById('marcar-problema').onclick = async () => {
        const campo = document.getElementById('diagnostico-observacao'); const note = campo.value.trim();
        if (!note) { campo.focus(); return; }
        await solicitarBridge('/diagnostico/mark', { note, screen: document.querySelector('[role=tab][aria-selected=true]')?.getAttribute('aria-controls'), operationId: ultimoOperationId, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }, { diagnosticoToken: tokenDiagnostico });
        campo.value = ''; document.getElementById('diagnostico-retorno').textContent = 'Problema marcado no horário atual.';
    };
    document.getElementById('baixar-diagnostico').onclick = async () => {
        const resposta = await solicitarBridge('/diagnostico/export', {}, { diagnosticoToken: tokenDiagnostico, prazo: 30000 });
        const url = URL.createObjectURL(new Blob([resposta.content], { type: 'text/plain;charset=utf-8' }));
        const link = document.createElement('a'); link.href = url; link.download = resposta.filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
}

/** Inicializa a autorização efêmera do navegador e captura falhas relevantes. */
async function iniciarDiagnostico(solicitar) {
    solicitarBridge = solicitar;
    try {
        tokenDiagnostico = (await solicitarBridge('/diagnostico/access')).accessToken;
        conectarPainelDiagnostico();
        await atualizarEstadoDiagnostico();
        window.addEventListener('error', evento => registrarDiagnostico('FRONTEND', 'uncaught_error', { message: evento.message, file: evento.filename?.split('/').pop(), line: evento.lineno, result: 'falhou' }));
        window.addEventListener('unhandledrejection', evento => registrarDiagnostico('FRONTEND', 'unhandled_rejection', { message: evento.reason?.message || String(evento.reason || 'rejeição sem mensagem'), result: 'falhou' }));
        registrarDiagnostico('FRONTEND', 'loaded', { result: 'sucesso' });
    } catch { ativo = false; }
}

window.registrarDiagnostico = registrarDiagnostico;
window.iniciarDiagnostico = iniciarDiagnostico;
