'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { criarCofreLocal } = require('../services/cofre-local');
const { criarMetaConexaoService, ESCOPOS } = require('../services/meta-conexao-service');
const { criarSessoesLocais } = require('../services/sessao-local');

/** Provedor completamente simulado; nenhum endpoint real é acessado. */
function preparar(extra = {}) {
    let estado = {}, instante = Date.parse('2026-10-14T00:00:00Z');
    const c = { appId: '123', secret: 'app-secret-ficticio', configId: '456', redirect: 'http://localhost:8080/meta/oauth/retorno', versao: 'v25.0' };
    const chamadas = [], selecionadas = [], logs = [];
    let desconexoes = 0;
    const servico = criarMetaConexaoService({
        cofre: { ler: () => structuredClone(estado), salvar: e => { estado = structuredClone(e); } },
        configuracao: () => ({ ...c }), agora: () => instante,
        aoSelecionar: pagina => selecionadas.push(pagina), aoDesconectar: () => { desconexoes++; },
        registrar: (...args) => logs.push(args),
        fetchImpl: async (entrada, opcoes) => {
            const url = new URL(entrada); chamadas.push({ url, opcoes });
            const custom = extra.responder?.(url, opcoes);
            if (custom !== undefined) return custom;
            if (url.pathname.endsWith('/oauth/access_token')) return Response.json({ access_token: url.searchParams.has('fb_exchange_token') ? 'token-usuario-longo-ficticio' : 'token-usuario-curto-ficticio' });
            if (url.pathname.endsWith('/debug_token')) return Response.json({ data: { is_valid: true, type: 'USER', app_id: '123', application: 'GPT2 fictício', expires_at: (instante + 3600000) / 1000, scopes: ESCOPOS, granular_scopes: [{ scope: 'pages_show_list', target_ids: ['789'] }], ...extra.debug } });
            if (url.pathname.endsWith('/me/permissions')) return Response.json(opcoes.method === 'DELETE' ? { success: true } : { data: (extra.escopos || [...ESCOPOS, 'instagram_basic']).map(permission => ({ permission, status: 'granted' })) });
            if (url.pathname.endsWith('/me/accounts')) return Response.json({ data: extra.vazia ? [] : [{ id: '789', name: 'Página fictícia', access_token: 'token-pagina-ficticio', tasks: ['CREATE_CONTENT'] }] });
            if (url.pathname.endsWith('/789')) return Response.json({ id: '789', name: 'Página fictícia', instagram_business_account: { id: '987' } });
            throw new Error('Endpoint não simulado');
        }
    });
    /** Conclui somente o OAuth simulado, sem selecionar ou publicar automaticamente. */
    async function conectar() {
        const url = new URL(servico.iniciar('sessao-1', 'http://localhost:8080').url);
        return servico.retorno('sessao-1', { state: url.searchParams.get('state'), code: 'codigo-ficticio' }, 'http://localhost:8080');
    }
    return { servico, conectar, c, chamadas, selecionadas, logs, estado: () => estado, desconexoes: () => desconexoes, avancar: ms => { instante += ms; } };
}

test('OAuth gera code flow e state sem enviar segredo ou token ao navegador', () => {
    const p = preparar();
    const url = new URL(p.servico.iniciar('sessao-1', 'http://localhost:8080').url);
    assert.equal(url.origin, 'https://www.facebook.com');
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('redirect_uri'), p.c.redirect);
    assert.equal(url.searchParams.get('config_id'), '456');
    assert.ok(url.searchParams.get('state').length >= 43);
    assert.ok(!url.href.includes(p.c.secret));
    assert.ok(!url.searchParams.has('access_token'));
    assert.deepEqual(url.searchParams.get('scope').split(','), ESCOPOS);
});

test('estado público lista requisitos ausentes sem expor valores secretos', () => {
    const p = preparar();
    p.c.secret = ''; p.c.configId = ''; p.c.redirect = ''; p.c.versao = '';
    const estado = p.servico.status();
    assert.equal(estado.configurado, false);
    assert.deepEqual(Object.keys(estado.errosConfiguracao).sort(), ['META_APP_SECRET', 'META_LOGIN_CONFIG_ID', 'META_REDIRECT_URI', 'FACEBOOK_GRAPH_VERSION'].sort());
    p.c.secret = 'segredo-nao-expor';
    assert.ok(!JSON.stringify(p.servico.status()).includes('segredo-nao-expor'));
});

test('configuração pronta não exige Page ID/token, mas valida callback e origem exatos', () => {
    const p = preparar();
    assert.equal(p.servico.status('http://localhost:8080').etapa, 'pronto_para_autorizar');
    assert.equal(p.servico.status('http://127.0.0.1:8080').configurado, false);
    p.c.redirect = 'http://localhost:8080/rota-inexistente';
    assert.equal(p.servico.status().etapa, 'nao_configurado');
    assert.throws(() => p.servico.iniciar('sessao', 'http://localhost:8080'));
});

test('teste de Página usa token OAuth selecionado e somente GET', async () => {
    const p = preparar();
    await assert.rejects(p.servico.testarPagina(), /Conecte com Facebook/);
    assert.equal(p.chamadas.length, 0);
    await p.conectar();
    await assert.rejects(p.servico.testarPagina(), /Selecione uma Página/);
    await p.servico.selecionar('789');
    const perfil = await p.servico.testarPagina();
    assert.equal(perfil.id, '789');
    assert.ok(p.chamadas.every(c => c.opcoes.method === 'GET'));
    assert.equal(p.chamadas.at(-1).opcoes.headers.Authorization, 'Bearer token-pagina-ficticio');
    assert.ok(!JSON.stringify(perfil).includes('token-'));
});

test('OAuth solicita apenas permissões Facebook e independe de instagram_basic', async () => {
    const p = preparar({ escopos: ESCOPOS });
    const url = new URL(p.servico.iniciar('sessao', 'http://localhost:8080').url);
    assert.equal(url.searchParams.get('scope'), 'pages_show_list,pages_read_engagement,pages_manage_posts');
    await p.conectar(); await p.servico.selecionar('789');
    assert.equal((await p.servico.testarPagina()).id, '789');
});

test('revogação externa bloqueia teste e seleção de Página previamente armazenada', async () => {
    let revogado = false;
    const p = preparar({ responder: url => revogado && url.pathname.endsWith('/debug_token') ? Response.json({ error: { code: 190 } }, { status: 400 }) : undefined });
    await p.conectar(); await p.servico.selecionar('789'); revogado = true;
    await assert.rejects(p.servico.testarPagina(), /190/);
    await assert.rejects(p.servico.selecionar('789'));
    assert.equal(p.servico.status().estado, 'token_expirado');
});

test('state é vinculado à sessão, expira e não aceita replay', async () => {
    const p = preparar();
    const state = new URL(p.servico.iniciar('a', 'http://localhost:8080').url).searchParams.get('state');
    await assert.rejects(p.servico.retorno('b', { state, code: 'x' }, 'http://localhost:8080'), e => e.codigo === 'META_STATE_INVALIDO');
    assert.equal(p.chamadas.length, 0);
    await p.servico.retorno('a', { state, code: 'x' }, 'http://localhost:8080');
    await assert.rejects(p.servico.retorno('a', { state, code: 'x' }, 'http://localhost:8080'), e => e.codigo === 'META_STATE_INVALIDO');
    const outro = new URL(p.servico.iniciar('a', 'http://localhost:8080').url).searchParams.get('state');
    p.avancar(600001);
    await assert.rejects(p.servico.retorno('a', { state: outro, code: 'x' }, 'http://localhost:8080'));
});

test('configuração incompleta ou callback diferente bloqueia antes da rede', () => {
    const p = preparar();
    assert.throws(() => p.servico.iniciar('a', 'http://127.0.0.1:8080'), e => e.codigo === 'META_CALLBACK_INVALIDO');
    p.c.secret = '';
    assert.throws(() => p.servico.iniciar('a', 'http://localhost:8080'), e => e.codigo === 'META_CONFIG_INCOMPLETA');
    assert.equal(p.chamadas.length, 0);
});

test('cancelamento e alteração de configuração consomem state sem trocar tokens', async () => {
    const p = preparar();
    const state = new URL(p.servico.iniciar('a', 'http://localhost:8080').url).searchParams.get('state');
    await assert.rejects(p.servico.retorno('a', { state, error: 'access_denied' }, 'http://localhost:8080'), e => e.codigo === 'META_CONSENTIMENTO_NEGADO');
    const outro = new URL(p.servico.iniciar('a', 'http://localhost:8080').url).searchParams.get('state');
    p.c.appId = '999';
    await assert.rejects(p.servico.retorno('a', { state: outro, code: 'x' }, 'http://localhost:8080'), e => e.codigo === 'META_STATE_INVALIDO');
    assert.equal(p.chamadas.length, 0);
});

test('descobre Página e Instagram vinculado, seleção explícita e status sem tokens', async () => {
    const p = preparar();
    const status = await p.conectar();
    assert.equal(status.estado, 'selecionar_pagina');
    assert.equal(status.paginas[0].instagramId, '987');
    assert.equal(p.selecionadas.length, 0);
    await assert.rejects(p.servico.selecionar('outra'), e => e.codigo === 'META_PAGINA_INVALIDA');
    const selecionada = await p.servico.selecionar('789');
    assert.equal(selecionada.estado, 'conectado');
    assert.equal(p.selecionadas[0].access_token, 'token-pagina-ficticio');
    assert.equal(p.estado().token, 'token-usuario-longo-ficticio');
    assert.ok(!JSON.stringify(selecionada).includes('token-pagina-ficticio'));
    assert.ok(!JSON.stringify(selecionada).includes('token-usuario-longo-ficticio'));
    assert.doesNotThrow(() => p.servico.exigirPublicacao('789'));
    assert.throws(() => p.servico.exigirPublicacao('999'));
    assert.ok(p.chamadas.every(c => c.opcoes.method === 'GET'));
});

test('lista vazia informa apenas evidências, sem inventar bloqueio App Review', async () => {
    const p = preparar({ vazia: true });
    const status = await p.conectar();
    assert.equal(status.estado, 'pagina_nao_encontrada');
    assert.equal(status.diagnostico.totalPaginas, 0);
    assert.deepEqual(status.diagnostico.faltantes, []);
    assert.match(status.mensagem, /não verificados/);
});

test('permissão negada é distinta de Página inexistente', async () => {
    const p = preparar({ escopos: ['pages_show_list'] });
    const status = await p.conectar();
    assert.equal(status.estado, 'autorizacao_insuficiente');
    assert.ok(status.diagnostico.faltantes.includes('pages_manage_posts'));
    await assert.rejects(p.servico.selecionar('789'));
});

test('token de outro app ou tipo não aceito não consulta páginas', async () => {
    for (const debug of [{ app_id: '999' }, { type: 'PAGE' }, { is_valid: false }]) {
        const p = preparar({ debug });
        await assert.rejects(p.conectar());
        assert.equal(p.chamadas.some(c => c.url.pathname.endsWith('/me/accounts')), false);
    }
});

test('expiração bloqueia publicação e desconectar local não revoga na Meta', async () => {
    const p = preparar(); await p.conectar(); await p.servico.selecionar('789');
    p.avancar(3600001);
    assert.equal(p.servico.status().estado, 'token_expirado');
    assert.throws(() => p.servico.exigirPublicacao('789'));
    await p.servico.desconectar(false);
    assert.equal(p.desconexoes(), 1);
    assert.equal(p.chamadas.some(c => c.opcoes.method === 'DELETE'), false);
    assert.equal(p.servico.status().estado, 'desconectado');
    assert.ok(!p.estado().token);
});

test('revogação ocorre apenas quando explicitamente solicitada', async () => {
    const p = preparar(); await p.conectar();
    await p.servico.desconectar(true);
    assert.equal(p.chamadas.filter(c => c.opcoes.method === 'DELETE').length, 1);
    assert.equal(p.servico.status().estado, 'desconectado');
});

test('revogação não confirmada preserva conexão e não afirma sucesso sem token', async () => {
    const p = preparar({ responder: (url, opcoes) => opcoes.method === 'DELETE' ? Response.json({ success: false }) : undefined });
    await assert.rejects(p.servico.desconectar(true), /Sem token local/);
    await p.conectar();
    await assert.rejects(p.servico.desconectar(true), /não confirmou/);
    assert.equal(p.desconexoes(), 0);
    assert.ok(p.estado().token);
});

test('erros Meta registram código e referência sem ecoar mensagem ou segredo', async () => {
    const p = preparar({ responder: url => url.pathname.endsWith('/me/accounts') ? Response.json({ error: { code: 100, error_subcode: 33, fbtrace_id: 'trace_123', message: 'token-usuario-longo-ficticio app-secret-ficticio' } }, { status: 400 }) : undefined });
    await assert.rejects(p.conectar(), e => e.message.includes('100') && !e.message.includes('ficticio'));
    assert.ok(JSON.stringify(p.logs).includes('trace_123'));
    assert.ok(!JSON.stringify(p.logs).includes('ficticio'));
});

test('cofre cifra, migra legado, detecta adulteração e não recria conteúdo corrompido', () => {
    const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-cofre-test-'));
    const arquivo = path.join(pasta, 'cofre.json');
    try {
        const opcoes = { obterChave: () => Buffer.alloc(32, 42) };
        const cofre = criarCofreLocal(arquivo, opcoes);
        fs.writeFileSync(arquivo, JSON.stringify({ token: 'segredo-legado' }));
        assert.equal(cofre.ler().token, 'segredo-legado');
        assert.ok(!fs.readFileSync(arquivo, 'utf8').includes('segredo-legado'));
        assert.equal(criarCofreLocal(arquivo, opcoes).ler().token, 'segredo-legado');
        assert.throws(() => criarCofreLocal(arquivo, { obterChave: () => Buffer.alloc(32, 5) }).ler());
        const adulterado = JSON.parse(fs.readFileSync(arquivo));
        adulterado.tag = Buffer.alloc(16).toString('base64');
        fs.writeFileSync(arquivo, JSON.stringify(adulterado));
        assert.throws(() => cofre.ler());
        assert.equal(JSON.parse(fs.readFileSync(arquivo)).tag, adulterado.tag);
    } finally { fs.rmSync(pasta, { recursive: true }); }
});

test('sessão é HttpOnly e CSRF exige cookie, nonce, host e validade', () => {
    let agora = 1000; const sessoes = criarSessoesLocais({ agora: () => agora });
    const req = { headers: { host: 'localhost:8080' } }; const cabecalhos = {};
    const sessao = sessoes.iniciar(req, { setHeader: (k, v) => { cabecalhos[k] = v; } });
    assert.match(cabecalhos['Set-Cookie'], /HttpOnly; SameSite=Lax/);
    assert.throws(() => sessoes.exigir(req));
    req.headers.cookie = cabecalhos['Set-Cookie'].split(';')[0]; req.headers['x-astra-csrf'] = sessao.csrf;
    assert.equal(sessoes.exigir(req).id, sessao.id);
    req.headers.host = '127.0.0.1:8080'; assert.throws(() => sessoes.exigir(req));
    req.headers.host = 'localhost:8080'; agora += 3600001; assert.throws(() => sessoes.exigir(req));
});
