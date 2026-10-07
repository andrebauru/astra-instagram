'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const pacote = require('./package.json');

const diretorio = path.resolve(__dirname, 'logs');
const caminhoEstado = path.join(diretorio, '.diagnostico-estado.json');
const limiteBytes = 2 * 1024 * 1024;
const limiteFila = 500;
const retencaoDias = 7;
const tokenAcesso = crypto.randomBytes(32).toString('base64url');
const desabilitadoPorAmbiente = String(process.env.ASTRA_DIAGNOSTIC_LOG || '').toLowerCase() === 'false';
let fila = [];
let gravando = false;
let estado = carregarEstado();

/** Remove segredos, conteúdo excessivo e dados incompatíveis com o diagnóstico. */
function sanitizar(valor, profundidade = 0, chavePai = '') {
    if (profundidade > 4) return '[limite]';
    if (/token|secret|senha|password|cookie|authorization|private.?key|api.?key|base64|signed.?url|corpo|body|prompt|caption|legenda|conteudo|content/i.test(chavePai)) return '[oculto]';
    if (typeof valor === 'string') {
        let texto = valor.replace(/[\r\n]+/g, ' ').slice(0, 500);
        texto = texto.replace(/Bearer\s+[^ ]+/gi, 'Bearer [oculto]');
        texto = texto.replace(/data:[^;\s]+;base64,[A-Za-z0-9+/=]+/gi, '[mídia omitida]');
        texto = texto.replace(/https?:\/\/[^\s?]+\?[^\s]+/gi, '[URL sanitizada]');
        for (const nome of ['ACCESS_TOKEN', 'REFRESH_TOKEN', 'APP_SECRET', 'OPENROUTER_API_KEY', 'MEDIA_UPLOAD_KEY', 'AUTHORIZATION', 'COOKIE', 'PASSWORD', 'PRIVATE_KEY']) {
            texto = texto.replace(new RegExp(`${nome}\\s*[:=]\\s*[^,; ]+`, 'gi'), `${nome}=[oculto]`);
        }
        for (const segredo of ['INSTAGRAM_ACCESS_TOKEN', 'META_ACCESS_TOKEN', 'META_APP_SECRET', 'OPENROUTER_API_KEY', 'META_VERIFY_TOKEN', 'MEDIA_UPLOAD_KEY']) {
            if (process.env[segredo] && process.env[segredo].length >= 8) texto = texto.split(process.env[segredo]).join('[oculto]');
        }
        return texto;
    }
    if (Array.isArray(valor)) return valor.slice(0, 30).map(item => sanitizar(item, profundidade + 1, chavePai));
    if (valor && typeof valor === 'object') return Object.fromEntries(Object.entries(valor).slice(0, 50).map(([chave, item]) => [chave, sanitizar(item, profundidade + 1, chave)]));
    return valor;
}

/** Lê o estado persistido sem renovar automaticamente a expiração. */
function carregarEstado() {
    try {
        const valor = JSON.parse(fs.readFileSync(caminhoEstado, 'utf8'));
        return valor && typeof valor === 'object' ? valor : { ativo: false };
    } catch { return { ativo: false }; }
}

/** Persiste somente metadados operacionais da sessão. */
function salvarEstado() {
    try {
        fs.mkdirSync(diretorio, { recursive: true });
        fs.writeFileSync(caminhoEstado, JSON.stringify(estado, null, 2), { encoding: 'utf8', mode: 0o600 });
        return true;
    } catch { return false; }
}

/** Informa se a sessão detalhada continua dentro do intervalo autorizado. */
function estaAtivo(agora = Date.now()) {
    if (desabilitadoPorAmbiente) return false;
    if (!estado.ativo || !estado.expiraEm || Date.parse(estado.expiraEm) <= agora) {
        if (estado.ativo) { estado.ativo = false; estado.encerradoEm = new Date(agora).toISOString(); salvarEstado(); }
        return false;
    }
    return true;
}

/** Retorna o arquivo diário atual fora do diretório público. */
function caminhoDoDia(data = new Date()) {
    return path.join(diretorio, `astra-debug-${data.toISOString().slice(0, 10)}.log`);
}

/** Faz rotação conservadora antes de acrescentar novos eventos. */
function rotacionar(caminho) {
    try {
        if (fs.existsSync(caminho) && fs.statSync(caminho).size >= limiteBytes) {
            for (let indice = 4; indice >= 1; indice--) {
                const origem = `${caminho}.${indice}`; const destino = `${caminho}.${indice + 1}`;
                if (fs.existsSync(origem)) { if (indice === 4) fs.rmSync(origem); else fs.renameSync(origem, destino); }
            }
            fs.renameSync(caminho, `${caminho}.1`);
        }
    } catch { /* log nunca interrompe o aplicativo */ }
}

/** Remove somente arquivos do diagnóstico que excederam a retenção. */
function aplicarRetencao(agora = Date.now()) {
    try {
        if (!fs.existsSync(diretorio)) return;
        const limite = agora - retencaoDias * 86400000;
        for (const nome of fs.readdirSync(diretorio)) {
            if (!/^astra-debug-\d{4}-\d{2}-\d{2}\.log(?:\.\d+)?$/.test(nome)) continue;
            const arquivo = path.join(diretorio, nome);
            if (fs.statSync(arquivo).mtimeMs < limite) fs.rmSync(arquivo);
        }
    } catch { /* retenção é melhor esforço */ }
}

/** Esvazia a fila limitada sem bloquear operações da aplicação. */
async function esvaziarFila() {
    if (gravando || !fila.length) return;
    gravando = true;
    const lote = fila.splice(0, 50);
    try {
        fs.mkdirSync(diretorio, { recursive: true });
        const grupos = Map.groupBy(lote, item => item.caminho);
        for (const [caminho, linhas] of grupos) {
            rotacionar(caminho);
            await fs.promises.appendFile(caminho, linhas.map(item => item.linha).join(''), 'utf8');
        }
    } catch { /* falha do logger não gera novo log nem derruba a aplicação */ }
    finally { gravando = false; if (fila.length) setImmediate(esvaziarFila); }
}

/** Aguarda somente a fila interna terminar, usado por verificações isoladas. */
async function drenarFila() {
    while (gravando || fila.length) {
        if (!gravando) await esvaziarFila();
        if (gravando || fila.length) await new Promise(resolve => setImmediate(resolve));
    }
}

/** Enfileira uma entrada JSON Lines correlacionável durante a sessão ativa. */
function registrar(secao, evento, dados = {}) {
    if (!estaAtivo()) return false;
    const agora = new Date();
    const entrada = sanitizar({ timestampUtc: agora.toISOString(), timezone: dados.timezone || null, appVersion: pacote.version, build: process.env.ASTRA_BUILD || pacote.version, diagnosticSessionId: estado.id, requestId: dados.requestId || null, operationId: dados.operationId || null, screen: dados.screen || null, step: dados.step || null, action: evento, section: secao, ...dados });
    if (fila.length >= limiteFila) fila.shift();
    fila.push({ caminho: caminhoDoDia(agora), linha: `${JSON.stringify(entrada)}\n` });
    setImmediate(esvaziarFila);
    return true;
}

/** Inicia uma sessão por prazo limitado, preservando a expiração após reinícios. */
function iniciarSessao({ horas = 48, timezone = null } = {}) {
    const duracao = Math.min(168, Math.max(1, Number(horas) || 48));
    const agora = new Date();
    estado = { ativo: true, id: crypto.randomUUID(), iniciadoEm: agora.toISOString(), expiraEm: new Date(agora.getTime() + duracao * 3600000).toISOString(), timezone: sanitizar(timezone) };
    salvarEstado(); aplicarRetencao();
    registrar('DIAGNOSTIC', 'started', { timezone, durationHours: duracao, result: 'salvo localmente' });
    return obterStatus();
}

/** Encerra o detalhamento sem apagar os arquivos coletados. */
function encerrarSessao() {
    if (estaAtivo()) registrar('DIAGNOSTIC', 'stopped', { result: 'salvo localmente' });
    estado.ativo = false; estado.encerradoEm = new Date().toISOString(); salvarEstado();
    return obterStatus();
}

/** Lista tamanho e intervalo dos arquivos sem expor caminhos locais ao navegador. */
function obterStatus() {
    const arquivos = [];
    try {
        if (fs.existsSync(diretorio)) for (const nome of fs.readdirSync(diretorio)) {
            if (!/^astra-debug-\d{4}-\d{2}-\d{2}\.log(?:\.\d+)?$/.test(nome)) continue;
            const info = fs.statSync(path.join(diretorio, nome)); arquivos.push({ nome, bytes: info.size, alteradoEm: info.mtime.toISOString() });
        }
    } catch { /* status continua disponível */ }
    return { enabled: estaAtivo(), sessionId: estado.id || null, startedAt: estado.iniciadoEm || null, expiresAt: estado.expiraEm || null, stoppedAt: estado.encerradoEm || null, files: arquivos, totalBytes: arquivos.reduce((soma, item) => soma + item.bytes, 0), defaultHours: 48 };
}

/** Gera um arquivo exportável já sanitizado com resumo verificável. */
function exportar() {
    const linhas = [];
    for (const arquivo of obterStatus().files) {
        try { linhas.push(...fs.readFileSync(path.join(diretorio, arquivo.nome), 'utf8').split(/\r?\n/).filter(Boolean)); } catch {}
    }
    const eventos = linhas.map(linha => { try { return sanitizar(JSON.parse(linha)); } catch { return null; } }).filter(item => item?.diagnosticSessionId === estado.id);
    const resultados = {}; const erros = {}; const exercitadas = new Set(); const pendentes = [];
    for (const item of eventos) {
        exercitadas.add(item.section); const resultado = item.result || item.status || item.action || 'não informado'; resultados[resultado] = (resultados[resultado] || 0) + 1;
        if (item.errorCode || item.code) { const chave = `${item.section}:${item.errorCode || item.code}`; erros[chave] = (erros[chave] || 0) + 1; }
        if (/incerto|pendente|não confirmado/i.test(String(resultado))) pendentes.push({ operationId: item.operationId, section: item.section, result: resultado });
    }
    const esperadas = ['FRONTEND', 'EDITOR', 'BACKEND', 'PERSISTENCE', 'MEDIA', 'SCHEDULING', 'PUBLISH', 'META', 'AI'];
    const resumo = sanitizar({ type: 'diagnostic_summary', appVersion: pacote.version, diagnosticSessionId: estado.id || null, observedFrom: estado.iniciadoEm || null, observedUntil: estado.encerradoEm || estado.expiraEm || null, results: resultados, errorsByOperation: erros, pendingOrUncertain: pendentes.slice(0, 100), unexercisedFeatures: esperadas.filter(nome => !exercitadas.has(nome)), approval: 'Nenhuma aprovação de sistema é inferida pela ausência de erros.' });
    return { filename: `astra-diagnostico-${estado.id || 'sem-sessao'}.log`, content: [JSON.stringify(resumo), ...eventos.map(item => JSON.stringify(item))].join('\n') + '\n' };
}

/** Valida o token efêmero emitido somente para origens locais autorizadas. */
function autorizar(req) {
    const informado = req.headers['x-diagnostico-token'];
    return typeof informado === 'string' && informado.length === tokenAcesso.length && crypto.timingSafeEqual(Buffer.from(informado), Buffer.from(tokenAcesso));
}

/** Informa somente a presença das configurações, sem ler nem registrar seus valores. */
function presencaConfiguracao(nomes = []) {
    return Object.fromEntries(nomes.map(nome => [nome, Boolean(process.env[nome])]));
}

/** Mantém compatibilidade com o cabeçalho operacional anterior. */
function iniciar(porta) {
    aplicarRetencao();
    registrar('BACKEND', 'server_started', { port: porta, node: process.version, platform: os.platform(), result: 'salvo localmente' });
}

module.exports = { get habilitado() { return estaAtivo(); }, get caminho() { return caminhoDoDia(); }, limiteBytes, sanitizar, registrar, iniciar, iniciarSessao, encerrarSessao, obterStatus, exportar, autorizar, tokenAcesso, presencaConfiguracao, drenarFila, _testes: { caminhoEstado, esvaziarFila, carregarEstado } };
