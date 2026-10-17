'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.INSTAGRAM_ACCESS_TOKEN = 'token-ficticio-logs-teste-123456';
process.env.MEDIA_UPLOAD_KEY = 'chave-midia-ficticia-987654';

const { criarLogsService } = require('../services/logs-service');

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'astra-logs-')); }

test('registra e consulta com filtros, paginação e resumo', async () => {
    const dir = tempDir();
    const logs = criarLogsService({ diretorio: dir });
    logs.registrar({ nivel: 'INFO', modulo: 'EDITOR', acao: 'rascunho_salvo', status: 'servidor', operationId: 'op-1' });
    logs.registrar({ nivel: 'WARNING', modulo: 'PUBLISH', acao: 'publicar_agora_bloqueado', status: 'sem_destino', operationId: 'op-2' });
    logs.registrar({ nivel: 'ERROR', modulo: 'PUBLISH', acao: 'tentativa_falha', status: 'falhou', plataforma: 'facebook', codigo: 'FACEBOOK_RECUSADO', httpStatus: 400, operationId: 'op-2', mensagem: 'O Facebook recusou a operação.' });
    await logs.limpar();

    const todos = logs.consultar({});
    assert.equal(todos.total, 3);
    assert.ok(todos.itens.some(i => i.nivel === 'ERROR' && i.codigo === 'FACEBOOK_RECUSADO'));

    const erros = logs.consultar({ nivel: 'ERROR' });
    assert.equal(erros.total, 1);
    assert.equal(erros.itens[0].codigo, 'FACEBOOK_RECUSADO');

    const porModulo = logs.consultar({ modulo: 'EDITOR' });
    assert.equal(porModulo.total, 1);

    const porOperacao = logs.consultar({ operationId: 'op-2' });
    assert.equal(porOperacao.total, 2);

    const porBusca = logs.consultar({ busca: 'recusou' });
    assert.equal(porBusca.total, 1);

    const paginado = logs.consultar({ pagina: 1, limite: 2 });
    assert.equal(paginado.itens.length, 2);
    assert.equal(paginado.paginas, 2);

    const resumo = logs.resumo();
    assert.equal(resumo.total, 3);
    assert.equal(resumo.erros, 1);
    assert.ok(resumo.arquivos.length >= 1);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('mascara segredos e não devolve stack na consulta', async () => {
    const dir = tempDir();
    const logs = criarLogsService({ diretorio: dir });
    logs.registrar({
        nivel: 'ERROR', modulo: 'BACKEND', acao: 'falha', mensagem: `Falha com Bearer ${process.env.INSTAGRAM_ACCESS_TOKEN}`,
        contexto: { header: `Authorization: Bearer ${process.env.MEDIA_UPLOAD_KEY}`, access_token: 'valor-secreto' },
        stack: 'Error: falha\n    at arquivo.js:1:1'
    });
    await logs.limpar();
    const item = logs.consultar({}).itens[0];
    const texto = JSON.stringify(item);
    assert.ok(!texto.includes('token-ficticio-logs-teste-123456'), 'token não aparece');
    assert.ok(!texto.includes('chave-midia-ficticia-987654'), 'chave de mídia não aparece');
    assert.ok(!texto.includes('valor-secreto'), 'campo sensível oculto');
    assert.equal(item.temStack, true, 'stack existe no armazenamento');
    assert.equal(item.stack, undefined, 'stack não é devolvido na consulta');
    fs.rmSync(dir, { recursive: true, force: true });
});

test('retenção remove arquivos antigos', async () => {
    const dir = tempDir();
    const antigo = path.join(dir, 'astra-2000-01-01.log');
    fs.writeFileSync(antigo, `${JSON.stringify({ ts: '2000-01-01T00:00:00.000Z', nivel: 'INFO', modulo: 'X', acao: 'y' })}\n`);
    const passado = new Date(Date.now() - 40 * 86400000);
    fs.utimesSync(antigo, passado, passado);
    const logs = criarLogsService({ diretorio: dir, retencaoDias: 7 });
    logs.registrar({ nivel: 'INFO', modulo: 'X', acao: 'novo' });
    await logs.limpar();
    assert.equal(fs.existsSync(antigo), false, 'arquivo fora da retenção foi removido');
    fs.rmSync(dir, { recursive: true, force: true });
});

// ============================================================
// Rotas com sessão/CSRF (servidor simulado, sem chamadas externas)
// ============================================================

const fsp = require('node:fs');
const osTmp = os.tmpdir();
process.env.OPENROUTER_MODEL = 'google/gemini-teste';
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'chave-ficticia-logs';
process.env.INSTAGRAM_ACCOUNT_ID = 'conta-ficticia';
process.env.ASTRA_EMPRESA_ARQUIVO = path.join(osTmp, `astra-logs-empresa-${process.pid}.json`);
process.env.ASTRA_TEMPLATES_ARQUIVO = path.join(osTmp, `astra-logs-templates-${process.pid}.json`);
process.env.ASTRA_PUBLICACOES_ARQUIVO = path.join(osTmp, `astra-logs-publicacoes-${process.pid}.json`);
process.env.ASTRA_PUBLICACOES_META_ARQUIVO = path.join(osTmp, `astra-logs-meta-${process.pid}.json`);
process.env.ASTRA_AGENDADOR_ARQUIVO = path.join(osTmp, `astra-logs-agenda-${process.pid}.json`);
process.env.ASTRA_INTEGRACOES_ARQUIVO = path.join(osTmp, `astra-logs-integracoes-${process.pid}.json`);
process.env.ASTRA_META_CONEXAO_ARQUIVO = path.join(osTmp, `astra-logs-conexao-${process.pid}.json`);
const dirLogs = tempDir();
process.env.ASTRA_LOGS_DIR = dirLogs;

const { server } = require('../server');
const fetchOriginal = globalThis.fetch;

test('rotas de logs exigem sessão e CSRF e persistem eventos', async () => {
    globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        // Sem sessão: 403.
        assert.equal((await fetchOriginal(`${base}/logs`)).status, 403);

        // Bootstrap de sessão/CSRF.
        const bootstrap = await fetchOriginal(`${base}/meta/conexao`);
        const cookie = (bootstrap.headers.get('set-cookie') || '').split(';')[0];
        const csrf = (await bootstrap.json()).csrf;
        assert.ok(cookie && csrf);

        // POST sem CSRF: 403.
        assert.equal((await fetchOriginal(`${base}/logs/event`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ modulo: 'X', acao: 'y' }) })).status, 403);

        // POST com CSRF: registra.
        const enviar = await fetchOriginal(`${base}/logs/event`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-Astra-CSRF': csrf }, body: JSON.stringify({ eventos: [{ nivel: 'ERROR', modulo: 'PUBLISH', acao: 'tentativa_falha', status: 'falhou', plataforma: 'facebook', mensagem: `erro com Bearer ${process.env.INSTAGRAM_ACCESS_TOKEN}` }] }) });
        assert.equal(enviar.status, 200);

        // GET com sessão: evento presente e segredo mascarado.
        let dados;
        for (let tentativa = 0; tentativa < 40; tentativa++) {
            dados = await (await fetchOriginal(`${base}/logs`, { headers: { Cookie: cookie } })).json();
            if (dados.itens.some(i => i.acao === 'tentativa_falha')) break;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.equal(dados.success, true);
        assert.ok(dados.total >= 1);
        assert.ok(dados.itens.some(i => i.acao === 'tentativa_falha'));
        const texto = JSON.stringify(dados.itens);
        assert.ok(!texto.includes(process.env.INSTAGRAM_ACCESS_TOKEN));

        const resumo = await (await fetchOriginal(`${base}/logs/resumo`, { headers: { Cookie: cookie } })).json();
        assert.equal(resumo.success, true);
        assert.ok(resumo.total >= 1);
    } finally {
        globalThis.fetch = fetchOriginal;
        await new Promise(resolve => server.close(resolve));
        try { fsp.rmSync(dirLogs, { recursive: true, force: true }); } catch { /* melhor esforço */ }
    }
});
