'use strict';
const path = require('node:path');
const os = require('node:os');
// Servidor exclusivo de testes: nunca carrega .env nem realiza chamadas externas.
process.env.INSTAGRAM_ACCESS_TOKEN = 'token-ficticio-ui';
process.env.INSTAGRAM_ACCOUNT_ID = 'conta-ficticia-ui';
process.env.OPENROUTER_API_KEY = 'chave-ficticia-ui';
process.env.OPENROUTER_MODEL = 'google/gemini-teste';
process.env.ASTRA_EMPRESA_ARQUIVO = path.join(os.tmpdir(), `astra-ui-empresa-${process.pid}.json`);
process.env.ASTRA_TEMPLATES_ARQUIVO = path.join(os.tmpdir(), `astra-ui-templates-${process.pid}.json`);
process.env.ASTRA_PUBLICACOES_ARQUIVO = path.join(os.tmpdir(), `astra-ui-publicacoes-${process.pid}.json`);
process.env.ASTRA_PUBLICACOES_META_ARQUIVO = path.join(os.tmpdir(), `astra-ui-meta-${process.pid}.json`);
process.env.ASTRA_AGENDADOR_ARQUIVO = path.join(os.tmpdir(), `astra-ui-agenda-${process.pid}.json`);

process.env.ASTRA_INTEGRACOES_ARQUIVO = require('node:path').join(require('node:os').tmpdir(), `astra-ui-integracoes-${process.pid}.json`);
process.env.ASTRA_META_CONEXAO_ARQUIVO = path.join(os.tmpdir(), `astra-ui-conexao-${process.pid}.json`);
const { server } = require('../server');
const { catalogoFicticio } = require('./catalogo-ficticio');
let totalPublicacoes = 0;

/** Simula os provedores para testar o painel sem publicar conteúdo real. */
globalThis.fetch = async (endereco, opcoes = {}) => {
    const url = String(endereco);
    let dados;
    if (url === 'https://openrouter.ai/api/v1/models') dados = { data: catalogoFicticio };
    else if (url.startsWith('https://openrouter.ai/')) dados = { choices: [{ message: { content: 'SIMULAÇÃO: legenda fictícia para revisão.' } }], model: JSON.parse(opcoes.body).model };
    else if (url.includes('/me/media')) dados = { data: [{ id: 'historico-ficticio-1', caption: 'Publicação histórica fictícia para criar rascunho.', timestamp: '2026-10-01T10:00:00+09:00', media_type: 'IMAGE', permalink: 'https://www.instagram.com/p/ficticio/' }] };
    else if (url.includes('media_publish')) { totalPublicacoes++; dados = { id: `publicacao-ficticia-${totalPublicacoes}` }; }
    else if (url.includes('status_code')) dados = { status_code: 'FINISHED' };
    else if (opcoes.method === 'POST') dados = { id: 'container-ficticio-ui' };
    else dados = { id: 'conta-ficticia-ui', username: 'conta_ficticia_teste', account_type: 'BUSINESS', media_count: totalPublicacoes };
    return new Response(JSON.stringify(dados), { status: 200, headers: { 'content-type': 'application/json' } });
};

server.listen(4320, '127.0.0.1', () => console.log('TESTE SEM REDE EXTERNA: http://127.0.0.1:4320/painel/'));
