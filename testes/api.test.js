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
process.env.ASTRA_PUBLICACOES_META_ARQUIVO = path.join(os.tmpdir(), `astra-teste-publicacoes-meta-${process.pid}.json`);
process.env.ASTRA_TEMPLATES_ARQUIVO = path.join(os.tmpdir(), `astra-teste-templates-${process.pid}.json`);
process.env.ASTRA_PUBLICACOES_ARQUIVO = path.join(os.tmpdir(), `astra-teste-publicacoes-${process.pid}.json`);
process.env.ASTRA_INTEGRACOES_ARQUIVO = path.join(os.tmpdir(), `astra-teste-integracoes-${process.pid}.json`);
process.env.ASTRA_META_CONEXAO_ARQUIVO = path.join(os.tmpdir(), `astra-teste-meta-conexao-${process.pid}.json`);
process.env.FACEBOOK_PAGE_ID = '123456';
process.env.FACEBOOK_PAGE_ACCESS_TOKEN = 'token-facebook-ficticio';

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

test('template padrão e dados recorrentes são confirmados e relidos exatamente', async () => {
    await comServidor(async ({ solicitar }) => {
        const templatePadrao = { texto: 'Site 1\nSite 2\n#hashtag', aplicarAutomatico: true };
        const recorrentes = {
            site: 'https://exemplo.test/site-1', maps: 'https://maps.google.com/?q=teste',
            linksAdicionais: 'https://exemplo.test/site-2\nhttps://exemplo.test/link-extra',
            hashtagsPadrao: '#tag1 #tag2', informacoesAdicionais: 'Informação fixa',
            chamadasFixas: 'Participe', templateTexto: 'Rodapé fixo'
        };
        assert.equal((await solicitar('/empresa/template-padrao', { templatePadrao })).status, 200);
        assert.equal((await solicitar('/empresa/recorrentes', { recorrentes })).status, 200);
        const templateRelido = await (await solicitar('/empresa/template-padrao')).json();
        const recorrentesRelidos = await (await solicitar('/empresa/recorrentes')).json();
        assert.deepEqual(templateRelido.templatePadrao, templatePadrao);
        assert.deepEqual(recorrentesRelidos.recorrentes, recorrentes);
    });
});

test('biblioteca de templates e rascunhos usam o backend como fonte de verdade', async () => {
    await comServidor(async ({ solicitar }) => {
        const primeiro = await (await solicitar('/empresa/templates', { novo: true, template: { nome: 'Template A', texto: 'Texto A', hashtags: '#a', site: 'https://a.jp' } })).json();
        const segundo = await (await solicitar('/empresa/templates', { novo: true, template: { nome: 'Template B', texto: 'Texto B', linksAdicionais: 'https://b.jp' } })).json();
        assert.notEqual(primeiro.template.id, segundo.template.id);
        const biblioteca = await (await solicitar('/empresa/templates')).json();
        assert.ok(biblioteca.templates.some(item => item.nome === 'Template A'));
        assert.ok(biblioteca.templates.some(item => item.nome === 'Template B'));

        const publicacao = { id: `rascunho-api-${process.pid}`, titulo: 'Rascunho no servidor', atualizadoEm: new Date().toISOString(), imagens: [{ id: 'm1', dados: 'não persistir', miniatura: 'não persistir', urlPublica: '' }] };
        assert.equal((await solicitar('/publicacoes', { publicacao })).status, 200);
        const lista = await (await solicitar('/publicacoes')).json();
        const relida = lista.publicacoes.find(item => item.id === publicacao.id);
        assert.equal(relida.titulo, publicacao.titulo);
        assert.equal(relida.imagens[0].dados, undefined);
    });
});

test('template preserva Informações mas exclui resultados IA e legenda', async () => {
    await comServidor(async ({ solicitar }) => {
        const campos = { objetivo: 'Divulgar', tema: 'Evento', fatos: 'Domingo', contexto: 'Empresa', palavras: 'Comunidade', ideias: 'Participação', hashtagsPublicacao: '#evento' };
        const dados = await (await solicitar('/empresa/templates', { novo: true, template: { nome: 'Completo', ...campos, fatosIa: 'Não salvar', textoMidia: 'Não salvar', legenda: 'Não salvar' } })).json();
        for (const [campo, valor] of Object.entries(campos)) assert.equal(dados.template[campo], valor);
        for (const campo of ['fatosIa', 'textoMidia', 'legenda']) assert.equal(dados.template[campo], undefined);
        const lista = await (await solicitar('/empresa/templates')).json();
        assert.equal(lista.templates.find(t => t.id === dados.template.id).tema, 'Evento');
    });
});

test('publicação imediata cria container e publica uma única vez', async () => {
    await comServidor(async ({ solicitar, definirResponder, limparChamadas, chamadas }) => {
        limparChamadas();
        definirResponder(url => json(url.includes('media_publish') ? { id: 'pub-1' } : url.includes('status_code') ? { status_code: 'FINISHED' } : { id: 'container-1' }));
        const body = { formato: 'imagem', imageUrl: 'https://midia.dominio-publico.com/foto.jpg', caption: 'Legenda revisada' };
        const headers = { 'X-Publicacao-Id': 'tentativa-imagem-0001' };
        const a = await (await solicitar('/instagram/publish', body, headers)).json();
        assert.equal(a.published.id, 'pub-1');
        const b = await solicitar('/instagram/publish', { ...body, caption: 'mudou' }, headers);
        assert.equal(b.status, 409);
    });
});

test('retry usa o contêiner persistido e não duplica publicação já confirmada', async () => {
    await comServidor(async ({ solicitar, definirResponder, chamadas, limparChamadas }) => {
        limparChamadas();
        let consultas = 0;
        definirResponder(url => {
            if (url.includes('status_code')) {
                consultas += 1;
                if (consultas === 1) return json({ status_code: 'IN_PROGRESS' });
                if (consultas === 2) return json({ status_code: 'FINISHED' });
                return json({ status_code: 'PUBLISHED', media_id: 'pub-idempotente' });
            }
            if (url.includes('media_publish')) return json({ id: 'pub-idempotente' });
            if (url.includes('fields=id%2Cpermalink')) return json({ id: 'pub-idempotente' });
            return json({ id: 'container-idempotente' });
        });
        const publicationId = `publicacao-idempotente-${process.pid}-${Date.now()}`;
        const body = { formato: 'imagem', imageUrl: 'https://midia.dominio-publico.com/foto.jpg', caption: 'Legenda', publicationId };
        const primeira = await (await solicitar('/instagram/publish', body, { 'X-Publicacao-Id': `tentativa-primeira-${Date.now()}` })).json();
        const segunda = await (await solicitar('/instagram/publish', body, { 'X-Publicacao-Id': `tentativa-segunda-${Date.now()}` })).json();
        assert.equal(primeira.media_id, 'pub-idempotente');
        assert.equal(segunda.media_id, 'pub-idempotente');
        assert.equal(chamadas().filter(c => c.url.includes('media_publish')).length, 1);
        const criacoes = chamadas().filter(c => c.opcoes.method === 'POST' && /\/media(?:\?|$)/.test(c.url));
        assert.equal(criacoes.length, 1);
    });
});

test('Feed e Story são publicados como destinos independentes e retry não duplica', async () => {
    await comServidor(async ({ solicitar, definirResponder, chamadas, limparChamadas }) => {
        limparChamadas();
        let criacoes = 0; let publicacoes = 0;
        definirResponder((url, opcoes) => {
            if (url.includes('/conta-teste?')) return json({ id: 'business-1', username: 'teste', account_type: 'BUSINESS' });
            if (url.includes('status_code')) {
                if (publicacoes >= 2) return json({ status_code: 'PUBLISHED', media_id: url.includes('container-story') ? 'story-1' : 'feed-1' });
                return json({ status_code: 'FINISHED' });
            }
            if (url.includes('media_publish')) return json({ id: ++publicacoes === 1 ? 'feed-1' : 'story-1' });
            if (url.includes('fields=id%2Cpermalink')) return json({ id: 'feed-1' });
            if (opcoes.method === 'POST' && /\/media(?:\?|$)/.test(url)) return json({ id: ++criacoes === 1 ? 'container-feed' : 'container-story' });
            return json({});
        });
        const publicationId = `feed-story-${process.pid}-${Date.now()}`;
        const body = { formato: 'imagem', imageUrl: 'https://midia.dominio-publico.com/story.jpg', caption: 'Feed', publicarStory: true, publicationId };
        const primeira = await (await solicitar('/instagram/publish', body, { 'X-Publicacao-Id': `destinos-um-${Date.now()}` })).json();
        const segunda = await (await solicitar('/instagram/publish', body, { 'X-Publicacao-Id': `destinos-dois-${Date.now()}` })).json();
        assert.equal(primeira.resultadosPublicacao.feed.idPublicado, 'feed-1');
        assert.equal(primeira.resultadosPublicacao.story.idPublicado, 'story-1');
        assert.equal(segunda.resultadosPublicacao.story.idPublicado, 'story-1');
        assert.equal(chamadas().filter(item => item.url.includes('media_publish')).length, 2);
    });
});

test('Facebook opcional publica sem chamar Instagram e exige destino e ID antes de enviar', async () => {
    await comServidor(async ({ solicitar, definirResponder, chamadas, limparChamadas }) => {
        definirResponder(() => json({ id: 'foto-facebook', post_id: 'post-facebook' }));
        const body = { formato: 'imagem', imageUrl: 'https://midia.dominio-publico.com/foto.jpg', publicarInstagram: false, publicarFacebook: true, publicationId: `facebook-${process.pid}` };
        const resultado = await (await solicitar('/instagram/publish', body)).json();
        assert.equal(resultado.resultadosPublicacao.facebook.idPublicado, 'post-facebook');
        assert.equal(chamadas().length, 1);
        assert.ok(chamadas()[0].url.includes('graph.facebook.com'));
        limparChamadas();
        assert.equal((await solicitar('/instagram/publish', { ...body, publicarFacebook: false })).status, 400);
        assert.equal((await solicitar('/instagram/publish', { ...body, publicarInstagram: true, publicationId: undefined })).status, 400);
        assert.equal(chamadas().length, 0);
    });
});

test('carrossel com Story é recusado antes de publicar no Feed', async () => {
    await comServidor(async ({ solicitar, chamadas }) => {
        const resposta = await solicitar('/instagram/publish', { formato: 'carrossel', publicarStory: true, itens: [1, 2].map(i => ({ tipo: 'imagem', url: `https://midia.dominio-publico.com/${i}.jpg` })) });
        assert.equal(resposta.status, 400);
        assert.equal(chamadas().length, 0);
    });
});

test('rota Story preserva tipo vídeo e não cria imagem', async () => {
    await comServidor(async ({ solicitar, definirResponder, chamadas }) => {
        definirResponder(url => {
            if (url.includes('/conta-teste?')) return json({ id: 'business', account_type: 'BUSINESS' });
            if (url.includes('status_code')) return json({ status_code: 'FINISHED' });
            if (url.includes('media_publish')) return json({ id: 'story-video' });
            return json({ id: 'story-video-container' });
        });
        const resposta = await solicitar('/instagram/publish', { formato: 'story', storyTipo: 'video', videoUrl: 'https://midia.dominio-publico.com/story.mp4', publicationId: `story-video-${process.pid}` });
        assert.equal(resposta.status, 200);
        const criacao = chamadas().find(c => c.opcoes.method === 'POST' && /\/media$/.test(c.url));
        assert.match(criacao.opcoes.body, /video_url=/);
        assert.doesNotMatch(criacao.opcoes.body, /image_url=/);
    });
});

test('configurações não devolvem segredos e recusam origem externa', async () => {
    await comServidor(async ({ solicitar, chamadas }) => {
        const resposta = await (await solicitar('/config/integracoes')).json();
        assert.equal(resposta.configuracoes.FACEBOOK_PAGE_ACCESS_TOKEN, true);
        assert.equal(resposta.configuracoes.OPENROUTER_API_KEY, true);
        assert.ok(!JSON.stringify(resposta).includes('ficticio-secreto'));
        const recusado = await solicitar('/config/integracoes', { META_APP_ID: '123' }, { Origin: 'https://site-externo.com' });
        assert.equal(recusado.status, 403);
        assert.equal(chamadas().length, 0);
    });
});

test('teste da Página exige seleção OAuth mesmo com credenciais legadas e não publica', async () => {
    await comServidor(async ({ solicitar, chamadas }) => {
        const resposta = await solicitar('/facebook/me');
        assert.equal(resposta.status, 403);
        const dados = await resposta.json();
        assert.equal(dados.code, 'FACEBOOK_NAO_CONFIGURADO');
        assert.match(dados.error, /Conecte com Facebook/);
        assert.equal(chamadas().length, 0);
    });
});

test('sessão OAuth exige CSRF e callback inválido retorna URL limpa sem chamar Meta', async () => {
    await comServidor(async ({ solicitar, chamadas }) => {
        const inicial = await solicitar('/meta/conexao');
        const cookie = inicial.headers.get('set-cookie').split(';')[0];
        const sessao = await inicial.json();
        assert.ok(sessao.csrf);
        assert.equal((await solicitar('/meta/oauth/iniciar', {})).status, 403);
        const semConfig = await solicitar('/meta/oauth/iniciar', {}, { Cookie: cookie, 'X-Astra-CSRF': sessao.csrf });
        assert.equal(semConfig.status, 400);
        assert.equal((await semConfig.json()).code, 'META_CONFIG_INCOMPLETA');
        const urlBase = `http://127.0.0.1:${server.address().port}`;
        const retorno = await fetchOriginal(urlBase + '/meta/oauth/retorno?state=invalid&code=nao-expor-este-code', { redirect: 'manual', headers: { Cookie: cookie } });
        assert.equal(retorno.status, 303);
        assert.equal(retorno.headers.get('location'), '/painel/?meta=falhou');
        assert.equal(retorno.headers.get('referrer-policy'), 'no-referrer');
        assert.equal(chamadas().length, 0);
        const status = await (await solicitar('/meta/conexao', undefined, { Cookie: cookie })).json();
        assert.ok(status.erroConexao);
        assert.ok(!JSON.stringify(status).includes('nao-expor-este-code'));
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
        definirResponder(url => json(url.includes('media_publish') ? { id: 'pub-agenda' } : url.includes('status_code') ? { status_code: 'FINISHED' } : { id: 'container-agenda' }));
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

test('publicação registra logs objetivos e nunca expõe token', async () => {
    await comServidor(async ({ solicitar, definirResponder }) => {
        definirResponder(url => {
            if (url.includes('media_publish')) return json({ id: 'pub-log-1' });
            if (url.includes('status_code')) return json({ status_code: 'FINISHED' });
            if (url.includes('fields=id%2Cpermalink')) return json({ id: 'pub-log-1', permalink: 'https://www.instagram.com/p/XYZ/', timestamp: '2026-10-08T09:32:00+09:00' });
            return json({ id: 'container-log-1' });
        });
        const linhas = [];
        const original = console.log;
        console.log = (...argumentos) => { linhas.push(argumentos.map(String).join(' ')); };
        try {
            const resposta = await (await solicitar('/instagram/publish', { formato: 'imagem', imageUrl: 'https://midia.dominio-publico.com/foto.jpg', caption: 'Texto', publicationId: 'pub-log' })).json();
            assert.equal(resposta.success, true);
            assert.equal(resposta.media_id, 'pub-log-1');
            assert.equal(resposta.permalink, 'https://www.instagram.com/p/XYZ/');
            assert.equal(resposta.published_at, '2026-10-08T09:32:00+09:00');
        } finally { console.log = original; }
        const texto = linhas.join('\n');
        assert.match(texto, /\[HTTP\] POST \/instagram\/publish/);
        assert.match(texto, /\[INSTAGRAM\] publish_requested type=imagem/);
        assert.match(texto, /\[INSTAGRAM\] creating_media_container/);
        assert.match(texto, /\[INSTAGRAM\] container_created id=/);
        assert.match(texto, /\[INSTAGRAM\] publishing_container/);
        assert.match(texto, /\[INSTAGRAM\] publish_success media_id=pub-log-1/);
        assert.match(texto, /\[HTTP\] \/instagram\/publish status=200/);
        assert.ok(!texto.includes(process.env.INSTAGRAM_ACCESS_TOKEN));
        assert.ok(!texto.includes(process.env.OPENROUTER_API_KEY));
    });
});

test('falha da Meta aparece no terminal e na resposta, sem segredo', async () => {
    await comServidor(async ({ solicitar, definirResponder }) => {
        definirResponder(() => json({ error: { code: 190, message: 'Token inválido', error_user_msg: 'Reautorize a conta.' } }, 400));
        const linhas = [];
        const original = console.log;
        console.log = (...argumentos) => { linhas.push(argumentos.map(String).join(' ')); };
        let resposta;
        try {
            resposta = await (await solicitar('/instagram/publish', { formato: 'imagem', imageUrl: 'https://midia.dominio-publico.com/foto.jpg', caption: 'Texto' })).json();
        } finally { console.log = original; }
        assert.equal(resposta.success, false);
        assert.ok(resposta.error.includes('Reautorize a conta.'));
        const texto = linhas.join('\n');
        assert.match(texto, /\[HTTP\] POST \/instagram\/publish/);
        assert.match(texto, /publish_failed/);
        assert.match(texto, /\[HTTP\] \/instagram\/publish status=401/);
        assert.ok(!texto.includes(process.env.INSTAGRAM_ACCESS_TOKEN));
    });
});

test('confirmar plano de agenda não publica imediatamente', async () => {
    await comServidor(async ({ solicitar, limparChamadas, chamadas }) => {
        limparChamadas();
        const plano = { id: 'plano-sem-publicar', status: 'rascunho', itens: [{ id: 'i1', mediaId: 'm1', tipo: 'imagem', data: '2099-01-02', hora: '10:00', timezone: 'Asia/Tokyo', destinos: ['Instagram Feed'], legenda: 'Conteúdo', status: 'rascunho', approvalSignature: null, url: 'https://midia.dominio-publico.com/a.png', itens: null, resultados: {} }] };
        const resposta = await (await solicitar('/agenda/planos', { planos: [plano] })).json();
        assert.equal(resposta.success, true);
        assert.equal(chamadas().filter(c => c.url.includes('graph.instagram') || c.url.includes('graph.facebook')).length, 0, 'agendar não publica');
    });
});

test('painel é servido com os arquivos novos e sem credenciais', async () => {
    await comServidor(async ({ solicitar }) => {
        const painel = await solicitar('/painel/');
        assert.equal(painel.status, 200);
        const html = await painel.text();
        assert.match(html, /agendamentos\.js/);
        assert.match(html, /fluxo-editorial\.js/);
        assert.match(painel.headers.get('content-security-policy'), /img-src[^;]*https:/);
        for (const rota of ['/painel/agendamentos.js', '/painel/integracao-regras.js', '/painel/fluxo-editorial.js', '/painel/painel.js', '/painel/estilo.css']) {
            assert.equal((await solicitar(rota)).status, 200, rota);
        }
        for (const rota of ['/.env', '/painel/.env', '/painel/../.env', '/painel/__proto__']) assert.equal((await solicitar(rota)).status, 404, rota);
    });
});
