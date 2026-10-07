'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { criarMediaService } = require('../services/media-service');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AwMCAO+jRZkAAAAASUVORK5CYII=';

/** Serviço com transporte e DNS fictícios. */
function criarServico(comportamento) {
    const fetchImpl = async (url, opcoes = {}) => comportamento(String(url), opcoes);
    return criarMediaService({
        midia: { uploadUrl: 'https://storage.exemplo-publico.com/upload', uploadKey: 'chave-ficticia' },
        fetchImpl,
        resolverIPs: async () => ['8.8.8.8']
    });
}

test('envia imagem válida e devolve URL HTTPS pública verificada', async () => {
    const servico = criarServico((url, opcoes) => {
        if (opcoes.method === 'POST') return new Response(JSON.stringify({ ok: true, url: 'https://cdn.dominio-publico.com/imagem.png', arquivo: 'imagem.png' }), { status: 200, headers: { 'content-type': 'application/json' } });
        return new Response('', { status: 200, headers: { 'content-type': 'image/png' } });
    });
    const resultado = await servico.enviar({ dados: PNG, mime: 'image/png', nome: 'foto.png' });
    assert.equal(resultado.url, 'https://cdn.dominio-publico.com/imagem.png');
    assert.equal(resultado.mime, 'image/png');
    assert.equal(resultado.bytes > 0, true);
});

test('formato inválido é recusado sem chamar a rede', async () => {
    let chamou = false;
    const servico = criarServico(() => { chamou = true; return new Response('{}'); });
    await assert.rejects(servico.enviar({ dados: 'data:image/gif;base64,R0lGOD', mime: 'image/gif', nome: 'x.gif' }), /JPEG, PNG ou WebP/);
    assert.equal(chamou, false);
});

test('URL pública em host privado é recusada', async () => {
    const servico = criarServico((url, opcoes) => {
        if (opcoes.method === 'POST') return new Response(JSON.stringify({ ok: true, url: 'https://127.0.0.1/x.png' }), { status: 200, headers: { 'content-type': 'application/json' } });
        return new Response('', { status: 200, headers: { 'content-type': 'image/png' } });
    });
    await assert.rejects(servico.enviar({ dados: PNG, mime: 'image/png', nome: 'foto.png' }), /fora dos padrões HTTPS públicos/);
});

test('resposta do storage sem URL é recusada', async () => {
    const servico = criarServico(() => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await assert.rejects(servico.enviar({ dados: PNG, mime: 'image/png', nome: 'foto.png' }), /fora dos padrões HTTPS públicos/);
});

test('capacidades indicam configuração do storage', () => {
    const servico = criarServico(() => new Response('{}'));
    const c = servico.capacidades();
    assert.equal(c.configurado, true);
    assert.deepEqual(c.tiposAceitos, ['image/jpeg', 'image/png', 'image/webp']);
});
