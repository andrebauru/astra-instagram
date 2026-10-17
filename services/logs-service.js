'use strict';

/*
 * LogsService — registro persistente de atividades e erros do Astra.
 *
 * JSON Lines em `dados/logs/astra-YYYY-MM-DD.log` (fora de qualquer diretório
 * público), com rotação por tamanho e retenção configurável. Falha de gravação
 * nunca derruba a aplicação. Segredos são mascarados antes de gravar e o stack
 * trace fica apenas no armazenamento, nunca na consulta pública.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const NIVEIS = ['DEBUG', 'INFO', 'WARNING', 'ERROR'];
const LIMITE_BYTES = 5 * 1024 * 1024;
const LIMITE_FILA = 1000;
const RETENCAO_DIAS = 14;
const MAXIMO_PAGINA = 200;

/** Mascara segredos e limita profundidade/tamanho antes de persistir. */
function sanitizar(valor, profundidade = 0, chavePai = '') {
    if (profundidade > 5) return '[limite]';
    if (/token|secret|senha|password|cookie|authorization|private.?key|api.?key|base64|signed.?url|corpo|body|prompt|caption|legenda|conteudo|content|access_token/i.test(chavePai)) return '[oculto]';
    if (typeof valor === 'string') {
        let texto = valor.replace(/[\r\n\t]+/g, ' ').slice(0, 800);
        texto = texto.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [oculto]');
        texto = texto.replace(/data:[^;\s]+;base64,[A-Za-z0-9+/=]+/gi, '[mídia omitida]');
        texto = texto.replace(/https?:\/\/[^\s?]+\?[^\s]+/gi, '[URL sanitizada]');
        for (const nome of ['ACCESS_TOKEN', 'REFRESH_TOKEN', 'APP_SECRET', 'OPENROUTER_API_KEY', 'MEDIA_UPLOAD_KEY', 'AUTHORIZATION', 'COOKIE', 'PASSWORD', 'PRIVATE_KEY']) {
            texto = texto.replace(new RegExp(`${nome}\\s*[:=]\\s*[^,;\\s]+`, 'gi'), `${nome}=[oculto]`);
        }
        for (const segredo of ['INSTAGRAM_ACCESS_TOKEN', 'META_ACCESS_TOKEN', 'META_APP_SECRET', 'OPENROUTER_API_KEY', 'META_VERIFY_TOKEN', 'MEDIA_UPLOAD_KEY', 'FACEBOOK_PAGE_ACCESS_TOKEN']) {
            if (process.env[segredo] && process.env[segredo].length >= 8) texto = texto.split(process.env[segredo]).join('[oculto]');
        }
        return texto;
    }
    if (Array.isArray(valor)) return valor.slice(0, 40).map(item => sanitizar(item, profundidade + 1, chavePai));
    if (valor && typeof valor === 'object') return Object.fromEntries(Object.entries(valor).slice(0, 60).map(([chave, item]) => [chave, sanitizar(item, profundidade + 1, chave)]));
    return valor;
}

/** Normaliza o nível aceito; desconhecido vira INFO. */
function normalizarNivel(nivel) {
    const valor = String(nivel || 'INFO').toUpperCase();
    return NIVEIS.includes(valor) ? valor : 'INFO';
}

function criarLogsService({ diretorio, agora = Date.now, retencaoDias = RETENCAO_DIAS, limiteBytes = LIMITE_BYTES } = {}) {
    const raizDir = diretorio || path.join(process.cwd(), 'dados', 'logs');
    let fila = [];
    let gravando = false;
    let escritos = 0;
    let ultimaRetencao = 0;

    const caminhoDoDia = (data = new Date(agora())) => path.join(raizDir, `astra-${data.toISOString().slice(0, 10)}.log`);

    /** Rotação simples por tamanho, preservando os arquivos mais recentes. */
    function rotacionar(caminho) {
        try {
            if (!fs.existsSync(caminho) || fs.statSync(caminho).size < limiteBytes) return;
            for (let i = 3; i >= 1; i--) {
                const origem = `${caminho}.${i}`; const destino = `${caminho}.${i + 1}`;
                if (fs.existsSync(origem)) { if (i === 3) fs.rmSync(origem); else fs.renameSync(origem, destino); }
            }
            fs.renameSync(caminho, `${caminho}.1`);
        } catch { /* rotação é melhor esforço */ }
    }

    /** Remove arquivos além da retenção; executada no máximo uma vez por dia. */
    function aplicarRetencao(forcar = false) {
        if (!forcar && agora() - ultimaRetencao < 86400000) return;
        ultimaRetencao = agora();
        try {
            if (!fs.existsSync(raizDir)) return;
            const limite = agora() - retencaoDias * 86400000;
            for (const nome of fs.readdirSync(raizDir)) {
                if (!/^astra-\d{4}-\d{2}-\d{2}\.log(?:\.\d+)?$/.test(nome)) continue;
                const arquivo = path.join(raizDir, nome);
                if (fs.statSync(arquivo).mtimeMs < limite) fs.rmSync(arquivo);
            }
        } catch { /* retenção é melhor esforço */ }
    }

    /** Esvazia a fila sem bloquear a aplicação. */
    async function esvaziarFila() {
        if (gravando || !fila.length) return;
        gravando = true;
        const lote = fila.splice(0, 100);
        try {
            fs.mkdirSync(raizDir, { recursive: true });
            const grupos = Map.groupBy(lote, item => item.caminho);
            for (const [caminho, linhas] of grupos) {
                rotacionar(caminho);
                await fs.promises.appendFile(caminho, linhas.map(item => item.linha).join(''), 'utf8');
            }
        } catch { /* falha de log não gera novo log nem derruba a aplicação */ }
        finally { gravando = false; if (fila.length) setImmediate(esvaziarFila); }
    }

    /** Registra um evento. Nunca lança e nunca grava segredos. */
    function registrar(entrada = {}) {
        try {
            aplicarRetencao();
            const momento = new Date(agora());
            const stack = typeof entrada.stack === 'string' ? sanitizar(entrada.stack).slice(0, 4000) : undefined;
            const registro = sanitizar({
                ts: momento.toISOString(),
                timezone: entrada.timezone || null,
                nivel: normalizarNivel(entrada.nivel),
                modulo: String(entrada.modulo || 'APP').slice(0, 60),
                acao: String(entrada.acao || 'evento').slice(0, 120),
                status: entrada.status !== undefined ? String(entrada.status).slice(0, 60) : null,
                operationId: entrada.operationId ? String(entrada.operationId).slice(0, 120) : null,
                plataforma: entrada.plataforma ? String(entrada.plataforma).slice(0, 40) : null,
                superficie: entrada.superficie ? String(entrada.superficie).slice(0, 40) : null,
                ator: entrada.ator ? String(entrada.ator).slice(0, 80) : 'local',
                mensagem: entrada.mensagem ? String(entrada.mensagem) : null,
                codigo: entrada.codigo ? String(entrada.codigo).slice(0, 80) : null,
                httpStatus: Number.isFinite(Number(entrada.httpStatus)) ? Number(entrada.httpStatus) : null,
                contexto: entrada.contexto && typeof entrada.contexto === 'object' ? entrada.contexto : null
            });
            if (stack) registro.stack = stack;
            if (registro.nivel === 'ERROR' || entrada.stack) escritos += 1;
            if (fila.length >= LIMITE_FILA) fila.shift();
            fila.push({ caminho: caminhoDoDia(momento), linha: `${JSON.stringify(registro)}\n` });
            setImmediate(esvaziarFila);
            return true;
        } catch { return false; }
    }

    /** Lê os arquivos dentro do período, sem revelar stack nem segredos. */
    function lerArquivos({ desde, ate } = {}) {
        const itens = [];
        try {
            if (!fs.existsSync(raizDir)) return itens;
            const inicio = desde ? Date.parse(desde) : null;
            const fim = ate ? Date.parse(ate) : null;
            for (const nome of fs.readdirSync(raizDir)) {
                const correspondencia = /^astra-(\d{4}-\d{2}-\d{2})\.log(?:\.\d+)?$/.exec(nome);
                if (!correspondencia) continue;
                const dia = Date.parse(`${correspondencia[1]}T00:00:00.000Z`);
                if (Number.isFinite(inicio) && dia + 86400000 < inicio) continue;
                if (Number.isFinite(fim) && dia > fim + 86400000) continue;
                const conteudo = fs.readFileSync(path.join(raizDir, nome), 'utf8');
                for (const linha of conteudo.split(/\r?\n/)) {
                    if (!linha.trim()) continue;
                    try { itens.push(JSON.parse(linha)); } catch { /* linha truncada por rotação */ }
                }
            }
        } catch { /* leitura parcial é aceitável */ }
        return itens;
    }

    /** Consulta paginada com filtros; nunca devolve stack nem segredos. */
    function consultar(filtros = {}) {
        const pagina = Math.max(1, Number(filtros.pagina) || 1);
        const limite = Math.min(MAXIMO_PAGINA, Math.max(1, Number(filtros.limite) || 50));
        const nivel = filtros.nivel ? normalizarNivel(filtros.nivel) : null;
        const busca = typeof filtros.busca === 'string' && filtros.busca.trim() ? filtros.busca.trim().toLowerCase() : null;
        const todos = lerArquivos({ desde: filtros.desde, ate: filtros.ate })
            .filter(item => item && typeof item.ts === 'string')
            .filter(item => !filtros.desde || Date.parse(item.ts) >= Date.parse(filtros.desde))
            .filter(item => !filtros.ate || Date.parse(item.ts) <= Date.parse(filtros.ate))
            .filter(item => !nivel || item.nivel === nivel)
            .filter(item => !filtros.modulo || item.modulo === filtros.modulo)
            .filter(item => !filtros.plataforma || item.plataforma === filtros.plataforma)
            .filter(item => !filtros.status || item.status === filtros.status)
            .filter(item => !filtros.operationId || item.operationId === filtros.operationId)
            .filter(item => !busca || JSON.stringify({ acao: item.acao, mensagem: item.mensagem, codigo: item.codigo, modulo: item.modulo }).toLowerCase().includes(busca))
            .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
        const total = todos.length;
        const paginas = Math.max(1, Math.ceil(total / limite));
        const fatia = todos.slice((pagina - 1) * limite, (pagina - 1) * limite + limite)
            .map(item => ({ ...item, temStack: typeof item.stack === 'string', stack: undefined }));
        return { itens: fatia, total, pagina, paginas, limite };
    }

    /** Resumo honesto para o topo da página. */
    function resumo() {
        const todos = lerArquivos({});
        const porNivel = Object.fromEntries(NIVEIS.map(n => [n, todos.filter(i => i.nivel === n).length]));
        const arquivos = [];
        try {
            if (fs.existsSync(raizDir)) for (const nome of fs.readdirSync(raizDir)) {
                if (!/^astra-\d{4}-\d{2}-\d{2}\.log(?:\.\d+)?$/.test(nome)) continue;
                const info = fs.statSync(path.join(raizDir, nome));
                arquivos.push({ nome, bytes: info.size });
            }
        } catch { /* resumo parcial */ }
        return { total: todos.length, porNivel, erros: porNivel.ERROR || 0, arquivos, totalBytes: arquivos.reduce((s, a) => s + a.bytes, 0), retencaoDias, limiteBytes };
    }

    function valoresUnicos(campo) {
        const conjunto = new Set();
        for (const item of lerArquivos({})) if (item?.[campo]) conjunto.add(item[campo]);
        return [...conjunto].sort();
    }

    function limpar() { return new Promise(resolve => { const t = setInterval(() => { if (!gravando && !fila.length) { clearInterval(t); resolve(); } }, 5); }); }

    return { registrar, consultar, resumo, valoresUnicos, limpar, NIVEIS, _fila: () => fila, _escritos: () => escritos };
}

module.exports = { criarLogsService, sanitizar, normalizarNivel, NIVEIS, LIMITE_BYTES, RETENCAO_DIAS, MAXIMO_PAGINA };
