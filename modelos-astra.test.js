'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizarModelo, selecionarModelos, criarCatalogo, sanitizarMensagem } = require('./modelos-astra');
const { modeloFicticio, catalogoFicticio } = require('./testes/catalogo-ficticio');

test('filtra batch, tarefas incompatíveis, IDs inválidos e modelos vencidos', () => {
    for (const id of ['google/gemini-teste:batch', 'google/gemini-teste:batch:free', 'teste/embedding', 'teste/reranker', 'teste/tts', 'teste/modelo-base', 'id-sem-fornecedor', 'https://servidor/modelo']) assert.equal(normalizarModelo(modeloFicticio(id)), null, id);
    for (const [entrada, saida] of [[['audio'], ['text']], [['text'], ['image']], [['text'], ['text', 'image']], [['text'], ['text', 'audio']], [['text'], ['embeddings']], [[], ['text']]]) assert.equal(normalizarModelo(modeloFicticio('teste/modelo', { architecture: { input_modalities: entrada, output_modalities: saida } })), null);
    assert.equal(normalizarModelo(modeloFicticio('teste/modelo', { expiration_date: '2000-01-01' })), null);
    assert.equal(normalizarModelo({ id: 'teste/modelo' }), null);
    assert.equal(normalizarModelo(null), null);
});

test('suporta metadados antigos e preços ausentes sem confundir ausência com gratuidade', () => {
    const modelo = normalizarModelo(modeloFicticio('teste/chat', { architecture: { modality: 'text+image->text' }, pricing: { prompt: '', completion: '-1' }, context_length: null, top_provider: null, supported_parameters: 'inesperado' }));
    assert.equal(modelo.vision, true); assert.equal(modelo.pricing.inputPerMillion, null); assert.equal(modelo.pricing.outputPerMillion, null); assert.equal(modelo.contextLength, null); assert.equal(modelo.supportedParameters, null);
    const gratuito = normalizarModelo(modeloFicticio('teste/chat', { pricing: { prompt: '0', completion: 0 } }));
    assert.equal(gratuito.pricing.inputPerMillion, 0); assert.equal(gratuito.category, 'Econômico');
    assert.equal(normalizarModelo(modeloFicticio('teste/chat', { architecture: { input_modalities: [], output_modalities: ['text'], modality: 'text->text' } })), null);
});

test('categorias decorrem de preços e contexto e visão é um atributo adicional', () => {
    const economico = normalizarModelo(modeloFicticio()); assert.equal(economico.category, 'Econômico'); assert.ok(economico.categories.includes('Visão'));
    const grande = normalizarModelo(modeloFicticio('teste/grande', { context_length: 200000, pricing: {} })); assert.equal(grande.category, 'Maior capacidade');
    const medio = normalizarModelo(modeloFicticio('teste/medio', { pricing: {} })); assert.equal(medio.category, 'Equilibrado');
});

test('seleção limita a lista, diversifica famílias e conserva fallback compatível', () => {
    const dados = ['google/gemini', 'openai/gpt', 'anthropic/claude', 'deepseek/modelo', 'qwen/modelo', 'mistralai/modelo', 'meta-llama/modelo'].flatMap(familia => Array.from({ length: 6 }, (_, i) => modeloFicticio(`${familia}-${i}`, { created: 1700000000 + i })));
    const selecao = selecionarModelos([...dados, ...dados], 'google/gemini-0');
    assert.equal(selecao.models.length, 21); assert.equal(new Set(selecao.models.map(item => item.id)).size, 21);
    assert.equal(selecao.defaultModel, 'google/gemini-0'); assert.ok(selecao.models.some(item => item.id === selecao.defaultModel));
    assert.equal(new Set(selecao.models.map(item => item.family)).size, 7);
    assert.ok(selecao.models.every(item => dados.some(original => original.id === item.id)));
    const batch = selecionarModelos(catalogoFicticio, 'google/gemini-teste:batch'); assert.equal(batch.configuredModelValid, false); assert.equal(batch.defaultModel, 'google/gemini-teste');
});

test('cache reúne consultas concorrentes, respeita validade e força atualização quando pedida', async () => {
    let agora = Date.now(); let chamadas = 0; let falhar = false;
    const catalogo = criarCatalogo({ relogio: () => agora, ttl: 1200000, transporte: async () => { chamadas++; if (falhar) throw new Error('offline'); return new Response(JSON.stringify({ data: catalogoFicticio })); } });
    await Promise.all([catalogo.obter(), catalogo.obter(), catalogo.obter()]); assert.equal(chamadas, 1);
    assert.equal((await catalogo.obter()).cached, true); assert.equal(chamadas, 1);
    await catalogo.obter(true); assert.equal(chamadas, 2);
    await assert.rejects(catalogo.escolher('google/gemini-teste:batch'), /Modelo indisponível/);
    await assert.rejects(catalogo.escolher('id-inventado'), /Modelo indisponível/);
    assert.equal((await catalogo.escolher()).id, 'google/gemini-teste');
    agora += 1200001; falhar = true;
    await assert.rejects(catalogo.obter(), /Não foi possível atualizar/);
    await assert.rejects(catalogo.escolher('google/gemini-teste'), /Não foi possível atualizar/);
});

test('catálogo inválido, vazio e timeout são falhas controladas', async () => {
    for (const body of [{}, { data: [] }, { data: [modeloFicticio('google/gemini-teste:batch')] }]) {
        const catalogo = criarCatalogo({ transporte: async () => new Response(JSON.stringify(body)) });
        await assert.rejects(catalogo.obter(), erro => erro.seguro);
    }
    const catalogo = criarCatalogo({ prazo: 5, transporte: (_url, { signal }) => new Promise((_resolve, reject) => {
        const limite = setTimeout(() => reject(new Error('timeout do teste')), 500);
        signal.addEventListener('abort', () => { clearTimeout(limite); reject(signal.reason); });
    }) });
    await assert.rejects(catalogo.obter(), erro => erro.codigo === 'CATALOGO_INDISPONIVEL');
});

test('mensagem diagnóstica remove tokens, authorization, URLs e caracteres de controle', () => {
    process.env.OPENROUTER_API_KEY = 'valor-secreto-ficticio';
    const resultado = sanitizarMensagem('Falha valor-secreto-ficticio Bearer token-desconhecido sk-or-v1-123 access_token=outrosegredo https://api.exemplo.com?key=segredo\nLinha');
    for (const segredo of ['valor-secreto-ficticio', 'token-desconhecido', 'sk-or-v1-123', 'outrosegredo', 'https://', '\n']) assert.ok(!resultado.includes(segredo));
});
