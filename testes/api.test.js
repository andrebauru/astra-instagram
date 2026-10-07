'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

// Configuração fictícia antes de carregar o servidor. Nenhuma chamada real.
process.env.INSTAGRAM_ACCESS_TOKEN = 'token-ficticio-secreto-teste';
process.env.INSTAGRAM_ACCOUNT_ID = 'conta-teste';
process.env.OPENROUTER_API_KEY = 'chave-ficticia-secreta-teste';
process.env.OPENROUTER_MODEL = 'google/gemini-teste';
process.env.ASTRA_AGENDADOR_ARQUIVO = path.join(os.tmpdir(), `astra-teste-agenda-${process.pid}.json`);
process.env.ASTRA_EMPRESA_ARQUIVO = path.join(os.tmpdir(), `astra-teste-empresa-${process.pid}.json`);

const { server } = require('../server');
const { catalogoFicticio, modeloFicticio } = require('./catalogo-ficticio');
const fetchOriginal = globalThis.fetch;

/** Prepara um servidor isolado com provedores fictícios. */
async function comServidor(executar) {
    let responder = () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    let chamadas = [];
    globalThis.fetch = async (url, opcoes) => {
        chamadas.push({ url: String(url), opcoes });
        if (String(url) === 'https://openrouter.ai/api/v1/models') return new Response(JSON.stringify({ data: catalogoFicticio }), { status: 200, headers: { 'content-type': 'application/json' } });
        return responder(String(url), opcoes);
    };
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const solicitar = (rota, body, headers = {}) => fetchOriginal(base + rota, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    try {
        await executar({ base, solicitar, definirResponder: fn => { responder = fn; }, chamadas: () => chamadas, limparChamadas: () => { chamadas = []; } });
    } finally {
        globalThis.fetch = fetchOriginal;
        await new Promise(resolve => server.close(resolve));
    }
}

const json = (dados, status = 200) => new Response(JSON.stringify(dados), { status, headers: { 'content-type': 'application/json' } });

test('health, raiz e build sem expor segredos', async () => {
    await comServidor(async ({ solicitar }) => {
        const saude = await (await solicitar('/health')).json();
        assert.equal(saude.status, 'ok');
        assert.equal(saude.instagramConfigured, true);
        assert.equal(saude.aiConfigured, true);
        assert.equal(saude.timezone, 'Asia/Tokyo');
        const texto = await (await solicitar('/health')).text();
        assert.ok(!texto.includes(process.env.OPENROUTER_API_KEY));
        assert.ok(!texto.includes(process.env.INSTAGRAM_ACCESS_TOKEN));
    });
});

test('CORS recusa origem externa e aceita origem local', async () => {
    await comServidor(async ({ solicitar, limparChamadas }) => {
        limparChamadas();
        const permitido = await solicitar('/health', undefined, { Origin: 'http://127.0.0.1:4317' });
        assert.equal(permitido.headers.get('access-control-allow-origin'), 'http://127.0.0.1:4317');
        const negado = await solicitar('/astra/generate', { prompt: 'x' }, { Origin: 'https://malicioso.com' });
        assert.equal(negado.status, 403);
    });
});

test('perfil do Instagram filtra campos e nunca devolve token', async () => {
    await comServidor(async ({ solicitar, definirResponder }) => {
        definirResponder(() => json({ id: 'perfil-teste', username: 'ficticio', account_type: 'BUSINESS', access_token: process.env.INSTAGRAM_ACCESS_TOKEN }));
        const resposta = await (await solicitar('/meta/me')).json();
        assert.equal(resposta.profile.username, 'ficticio');
        assert.ok(!resposta.profile.access_token);
    });
});

test('IA gera texto via OpenRouter com modelo validado', async () => {
    await comServidor(async ({ solicitar, definirResponder, chamadas, limparChamadas }) => {
        limparChamadas();
        definirResponder(() => json({ choices: [{ message: { content: 'Legenda fictícia.' } }], model: 'google/gemini-teste' }));
        const resposta = await (await solicitar('/astra/generate', { prompt: 'Tema fictício', model: 'google/gemini-teste' })).json();
        assert.equal(resposta.astra.text, 'Legenda fictícia.');
        assert.ok(chamadas().some(c => c.url === 'https://openrouter.ai/api/v1/chat/completions'));
    });
});

test('modelo não permitido é recusado sem chamar o provedor', async () => {
    await comServidor(async ({ solicitar, limparChamadas, chamadas }) => {
        limparChamadas();
        const resposta = await (await solicitar('/astra/generate', { prompt: 'x', model: 'inventado/modelo' })).json();
        assert.equal(resposta.success, false);
        assert.equal(resposta.code, 'MODELO_NAO_PERMITIDO');
        assert.equal(chamadas().filter(c => c.url.includes('chat/completions')).length, 0);
    });
});

test('publicação imediata cria container e publica uma única vez', async () => {
    await comServidor(async ({ solicitar, definirResponder, limparChamadas, chamadas }) => {
        limparChamadas();
        definirResponder(url => json(url.includes('media_publish') ? { id: 'pub-1' } : { id: 'container-1' }));
        const body = { formato: 'imagem', imageUrl: 'https://midia.dominio-publico.com/foto.jpg', caption: 'Legenda revisada' };
        const headers = { 'X-Publicacao-Id': 'tentativa-imagem-0001' };
        const a = await (await solicitar('/instagram/publish', body, headers)).json();
        assert.equal(a.published.id, 'pub-1');
        const b = await solicitar('/instagram/publish', { ...body, caption: 'mudou' }, headers);
        assert.equal(b.status, 409);
    });
});

test('mídia sem URL pública é recusada antes da API', async () => {
    await comServidor(async ({ solicitar, limparChamadas, chamadas }) => {
        limparChamadas();
        const resposta = await solicitar('/instagram/publish', { formato: 'imagem', imageUrl: 'C:\\foto.jpg' });
        assert.equal(resposta.status, 400);
        assert.equal(chamadas().filter(c => c.url.includes('graph.instagram')).length, 0);
    });
});

test('agendamento rascunho não executa e aprovado usa o mesmo caminho de publicação', async () => {
    await comServidor(async ({ solicitar, definirResponder }) => {
        definirResponder(url => json(url.includes('media_publish') ? { id: 'pub-agenda' } : { id: 'container-agenda' }));
        const item = {
            id: 'item-api-1', mediaId: 'm1', tipo: 'imagem',
            data: '2099-01-01', hora: '10:00', timezone: 'Asia/Tokyo',
            destinos: ['Instagram'], legenda: 'Agendada', status: 'rascunho',
            approvalSignature: null, atraso: 'reagendar', toleranciaMinutos: 30,
            url: 'https://midia.dominio-publico.com/a.jpg', itens: null, resultados: {}
        };
        const plano = { id: 'plano-api-1', status: 'rascunho', itens: [item] };
        const sincronizado = await (await solicitar('/agenda/planos', { planos: [plano] })).json();
        assert.equal(sincronizado.planos.length, 1);
        const rascunho = await (await solicitar('/agenda/executar', {})).json();
        assert.equal(rascunho.executados, 0);
    });
});

test('rotas removidas de Facebook/Ads/sincronização não existem', async () => {
    await comServidor(async ({ solicitar }) => {
        for (const rota of ['/meta/ads-capabilities', '/meta/ads-insights', '/meta/ads/prepare', '/publicacoes/importadas', '/publicacoes/sincronizar', '/astra/repost-rewrite', '/instagram/metrics', '/instagram/publish/image', '/instagram/publish/reel', '/instagram/publish/carousel']) {
            assert.equal((await solicitar(rota)).status, 404, rota);
        }
    });
});

test('diagnóstico exige token efêmero', async () => {
    await comServidor(async ({ solicitar }) => {
        assert.equal((await solicitar('/diagnostico/status')).status, 401);
        const acesso = await (await solicitar('/diagnostico/access')).json();
        assert.ok(acesso.accessToken);
        const comToken = await solicitar('/diagnostico/status', undefined, { 'X-Diagnostico-Token': acesso.accessToken });
        assert.equal(comToken.status, 200);
    });
});

test('painel é servido com os arquivos novos e sem credenciais', async () => {
    await comServidor(async ({ solicitar }) => {
        const painel = await solicitar('/painel/');
        assert.equal(painel.status, 200);
        const html = await painel.text();
        assert.match(html, /agendamentos\.js/);
        for (const rota of ['/painel/agendamentos.js', '/painel/integracao-regras.js', '/painel/painel.js', '/painel/estilo.css']) {
            assert.equal((await solicitar(rota)).status, 200, rota);
        }
        for (const rota of ['/.env', '/painel/.env', '/painel/../.env', '/painel/__proto__']) assert.equal((await solicitar(rota)).status, 404, rota);
    });
});
