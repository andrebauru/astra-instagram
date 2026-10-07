'use strict';
const { erroSeguro, ocultarSegredos } = require('./bridge-seguranca');
const TEMPO_CACHE = 20 * 60 * 1000;
const LIMITE_MODELOS = 21;
const familias = [
    ['Google Gemini', /^google\/gemini/i], ['OpenAI GPT', /^openai\/(?:gpt|o\d)/i],
    ['Anthropic Claude', /^anthropic\/claude/i], ['DeepSeek', /^deepseek\//i],
    ['Qwen', /^qwen\//i], ['Mistral', /^mistralai\//i], ['Meta Llama', /^meta-llama\//i]
];

/** Converte metadados numéricos sem transformar ausência ou preço negativo em zero. */
function numeroValido(valor) {
    if ((typeof valor !== 'string' && typeof valor !== 'number') || String(valor).trim() === '') return null;
    const numero = Number(valor);
    return Number.isFinite(numero) && numero >= 0 ? numero : null;
}

/** Lê modalidades explícitas, recorrendo ao formato antigo apenas quando necessário. */
function modalidades(arquitetura, campo, lado) {
    if (Array.isArray(arquitetura[campo])) return arquitetura[campo].filter(item => typeof item === 'string').map(item => item.toLowerCase());
    const partes = typeof arquitetura.modality === 'string' ? arquitetura.modality.toLowerCase().split('->') : [];
    return partes.length === 2 ? partes[lado].split('+').map(item => item.trim()) : [];
}

/** Normaliza apenas modelos textuais conversacionais retornados pelo catálogo. */
function normalizarModelo(modelo, agora = Date.now()) {
    if (!modelo || typeof modelo !== 'object' || typeof modelo.id !== 'string') return null;
    const id = modelo.id;
    if (!/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:+-]*$/i.test(id) || id.length > 200 || /:batch(?:$|:)/i.test(id)) return null;
    const nome = typeof modelo.name === 'string' && modelo.name.trim() ? modelo.name.trim().slice(0, 160) : id;
    if (/(?:embed(?:ding)?|rerank|moderation|classifier|transcri(?:be|ption)|speech|\btts\b|\bwhisper\b)/i.test(`${id} ${nome}`)) return null;
    if (/(?:^|[\/-])base(?:$|:)/i.test(id)) return null;
    const arquitetura = modelo.architecture && typeof modelo.architecture === 'object' ? modelo.architecture : {};
    const saidas = modalidades(arquitetura, 'output_modalities', 1);
    // A etapa atual gera legendas: modelos que geram imagens/áudio ficam fora desta seleção.
    if (!modalidades(arquitetura, 'input_modalities', 0).includes('text') || !saidas.includes('text') || saidas.some(item => item !== 'text')) return null;
    if (['base', 'none'].includes(arquitetura.instruct_type)) return null;
    if (modelo.expiration_date && Date.parse(modelo.expiration_date) <= agora) return null;
    const parametros = Array.isArray(modelo.supported_parameters) ? modelo.supported_parameters.filter(item => typeof item === 'string') : null;
    const familia = familias.find(([, padrao]) => padrao.test(id))?.[0] || id.split('/')[0];
    const precoEntrada = numeroValido(modelo.pricing?.prompt);
    const precoSaida = numeroValido(modelo.pricing?.completion);
    const contexto = numeroValido(modelo.context_length) || numeroValido(modelo.top_provider?.context_length);
    const economico = precoEntrada !== null && precoSaida !== null && precoEntrada <= 0.5 / 1e6 && precoSaida <= 2 / 1e6;
    const categoria = economico ? 'Econômico' : contexto >= 200000 ? 'Maior capacidade' : 'Equilibrado';
    const visao = modalidades(arquitetura, 'input_modalities', 0).includes('image');
    return {
        id, name: nome, family: familia, contextLength: contexto, vision: visao,
        pricing: { inputPerMillion: precoEntrada === null ? null : precoEntrada * 1e6, outputPerMillion: precoSaida === null ? null : precoSaida * 1e6, variable: Array.isArray(modelo.pricing?.overrides) && modelo.pricing.overrides.length > 0 },
        category: categoria, categories: [categoria, ...(visao ? ['Visão'] : [])],
        supportedParameters: parametros, created: numeroValido(modelo.created) || 0
    };
}

/** Ordena por adequação geral, visão e atualidade, sem inventar avaliações de qualidade. */
function ordenarModelos(a, b) {
    const especializado = modelo => /(?:coder|codex|code-|devstral|guard|audio|realtime|search|research)/i.test(modelo.id) ? 1 : 0;
    return especializado(a) - especializado(b) || Number(b.vision) - Number(a.vision) || b.created - a.created || a.id.localeCompare(b.id);
}

/** Seleciona até 21 opções com diversidade de famílias e faixas de custo/contexto. */
function selecionarModelos(dados, configurado, agora = Date.now()) {
    const unicos = new Map();
    for (const dado of dados) { const modelo = normalizarModelo(dado, agora); if (modelo && !unicos.has(modelo.id)) unicos.set(modelo.id, modelo); }
    const elegiveis = [...unicos.values()].sort(ordenarModelos);
    const selecionados = new Map();
    for (const [familia] of familias) {
        const grupo = elegiveis.filter(modelo => modelo.family === familia);
        for (const categoria of ['Econômico', 'Equilibrado', 'Maior capacidade']) {
            const modelo = grupo.find(item => item.category === categoria);
            if (modelo) selecionados.set(modelo.id, modelo);
        }
    }
    for (const modelo of elegiveis) {
        if (selecionados.size >= LIMITE_MODELOS) break;
        selecionados.set(modelo.id, modelo);
    }
    const preferido = unicos.get(configurado);
    if (preferido && !selecionados.has(preferido.id)) {
        if (selecionados.size >= LIMITE_MODELOS) selecionados.delete([...selecionados.keys()].at(-1));
        selecionados.set(preferido.id, preferido);
    }
    const models = [...selecionados.values()];
    const padrao = preferido || models.find(item => item.vision && item.category === 'Econômico') || models.find(item => item.category === 'Econômico') || models[0];
    return { models, defaultModel: padrao?.id, configuredModelValid: Boolean(preferido), totalCompatible: elegiveis.length };
}

/** Sanitiza mensagens diagnósticas antes de registrar qualquer dado do provedor. */
function sanitizarMensagem(valor) {
    if (typeof valor !== 'string' && typeof valor !== 'number') return 'Mensagem não informada';
    return ocultarSegredos(String(valor))
        .replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer [oculto]')
        .replace(/sk-[a-z0-9_-]+/gi, '[oculto]')
        .replace(/(?:access_token|api_key|authorization)\s*[=:]\s*[^\s&,;]+/gi, '[credencial oculta]')
        .replace(/https?:\/\/[^\s]+/gi, '[URL omitida]')
        .replace(/[\r\n\t\x00-\x1f\x7f]/g, ' ').slice(0, 500);
}

/** Registra somente os campos diagnósticos permitidos pelo contrato da Astra. */
function registrarErroAstra(status, dados, modelo) {
    console.error('[Astra]', { status, codigo: sanitizarMensagem(dados?.error?.code ?? status), mensagem: sanitizarMensagem(dados?.error?.message), modeloSolicitado: sanitizarMensagem(modelo || 'catálogo') });
}

/** Traduz erros do OpenRouter sem repassar sua resposta bruta ao navegador. */
function erroOpenRouter(status) {
    if (status === 401 || status === 403) return erroSeguro('ASTRA_AUTORIZACAO', 'Autorização recusada pelo OpenRouter. Verifique a configuração no backend.', status);
    if (status === 402) return erroSeguro('ASTRA_SALDO', 'Crédito/saldo insuficiente no OpenRouter.', 402);
    if (status === 404) return erroSeguro('ASTRA_MODELO_INDISPONIVEL', 'Modelo indisponível. Atualize os modelos e escolha outra opção.', 502);
    if (status === 429) return erroSeguro('ASTRA_LIMITE', 'Limite temporário atingido no OpenRouter. Aguarde antes de tentar novamente.', 429);
    if (status >= 500) return erroSeguro('ASTRA_TEMPORARIA', 'Falha temporária no OpenRouter. Tente novamente mais tarde.', 502);
    return erroSeguro('ASTRA_RECUSOU', 'OpenRouter recusou a solicitação. Consulte o diagnóstico no backend.', 502);
}

/** Mantém um catálogo curto em memória, com prazo, atualização explícita e consultas coalescidas. */
function criarCatalogo({ transporte = (...args) => fetch(...args), relogio = Date.now, ttl = TEMPO_CACHE, prazo = 15000 } = {}) {
    let cache;
    let consulta;
    /** Consulta o catálogo real, sem usar IDs fixos ou servir cache vencido como lista válida. */
    async function carregar() {
        let resposta;
        let dados;
        try {
            resposta = await transporte('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(prazo), headers: process.env.OPENROUTER_API_KEY ? { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` } : {} });
            dados = await resposta.json();
        } catch {
            throw erroSeguro('CATALOGO_INDISPONIVEL', 'Não foi possível atualizar o catálogo de modelos. Verifique a conexão e tente novamente.', 503);
        }
        if (!resposta.ok || dados?.error) { registrarErroAstra(resposta.status, dados); throw erroOpenRouter(resposta.ok ? Number(dados.error.code) || 502 : resposta.status); }
        if (!Array.isArray(dados?.data)) throw erroSeguro('CATALOGO_INVALIDO', 'O catálogo retornou um formato inesperado.', 502);
        const filtrado = selecionarModelos(dados.data, process.env.ASTRA_MODEL, relogio());
        if (!filtrado.models.length) throw erroSeguro('CATALOGO_VAZIO', 'Nenhum modelo compatível foi encontrado no catálogo.', 503);
        cache = { ...filtrado, updatedAt: new Date(relogio()).toISOString(), expiresAt: new Date(relogio() + ttl).toISOString() };
        return cache;
    }
    /** Reaproveita a consulta pendente ou o cache ainda válido. */
    async function obter(atualizar = false) {
        if (consulta) return { ...await consulta, cached: false };
        if (!atualizar && cache && Date.parse(cache.expiresAt) > relogio()) return { ...cache, cached: true };
        consulta = carregar();
        try { return { ...await consulta, cached: false }; } finally { consulta = undefined; }
    }
    /** Recusa IDs externos à seleção e usa fallback somente quando não há escolha explícita. */
    async function escolher(solicitado) {
        if (solicitado !== undefined && (typeof solicitado !== 'string' || !solicitado || solicitado.length > 200)) throw erroSeguro('MODELO_NAO_PERMITIDO', 'Selecione um modelo válido da lista do painel.', 400);
        const catalogo = await obter();
        const modelo = catalogo.models.find(item => item.id === (solicitado === undefined ? catalogo.defaultModel : solicitado));
        if (!modelo) throw erroSeguro('MODELO_NAO_PERMITIDO', 'Modelo indisponível na seleção atual. Atualize a lista e escolha novamente.', 400);
        return modelo;
    }
    return { obter, escolher };
}

module.exports = { criarCatalogo, normalizarModelo, selecionarModelos, sanitizarMensagem, registrarErroAstra, erroOpenRouter };
