'use strict';

/** Cria metadados fictícios para testes, sem assumir IDs disponíveis em produção. */
function modeloFicticio(id = 'google/gemini-teste', alteracoes = {}) {
    return { id, name: `Modelo fictício ${id}`, architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'], instruct_type: null }, context_length: 128000, pricing: { prompt: '0.0000001', completion: '0.0000004' }, supported_parameters: ['temperature', 'max_tokens'], created: 1700000000, ...alteracoes };
}

const catalogoFicticio = [modeloFicticio(), modeloFicticio('openai/gpt-teste', { pricing: { prompt: '0.000005', completion: '0.000015' }, context_length: 256000 }), modeloFicticio('google/gemini-teste:batch'), modeloFicticio('teste/embedding', { architecture: { input_modalities: ['text'], output_modalities: ['embeddings'] } })];
module.exports = { modeloFicticio, catalogoFicticio };
