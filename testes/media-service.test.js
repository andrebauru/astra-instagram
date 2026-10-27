'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { criarMediaService } = require('../services/media-service');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AwMCAO+jRZkAAAAASUVORK5CYII=';
const MP4 = `data:video/mp4;base64,${Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(16)]).toString('base64')}`;

/** Serviço com transporte e DNS fictícios. */
function criarServico(comportamento) {
    const fetchImpl = async (url, opcoes = {}) => comportamento(String(url), opcoes);
    return criarMediaService({
        midia: { uploadUrl: 'https://storage.exemplo-publico.com/upload', inventarioUrl: 'https://storage.exemplo-publico.com/inventario', basePublicaUrl: 'https://cdn.dominio-publico.com/media/', uploadKey: 'chave-ficticia' },
        fetchImpl,
        resolverIPs: async () => ['8.8.8.8']
    });
}

test('inventário percorre todas as páginas com autenticação backend', async () => {
    const chamadas = [];
    const servico = criarServico((url, opcoes) => {
        chamadas.push({ url, chave: opcoes.headers?.['X-Astra-Key'] });
        const cursor = new URL(url).searchParams.get('cursor');
        return new Response(JSON.stringify(cursor ? {
            items: [{ url: 'https://cdn.dominio-publico.com/media/b.mp4', filename: 'b.mp4', mime: 'video/mp4' }], next_cursor: null
        } : {
            items: [{ url: 'https://cdn.dominio-publico.com/media/a.png', filename: 'a.png', mime: 'image/png' }], next_cursor: '1'
        }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const itens = await servico.listarInventario();
    assert.deepEqual(itens.map(item => item.filename), ['a.png', 'b.mp4']);
    assert.equal(chamadas.length, 2);
    assert.ok(chamadas.every(item => item.chave === 'chave-ficticia'));
});

test('inventário recusa URL fora da base pública autorizada', async () => {
    const servico = criarServico(() => new Response(JSON.stringify({ items: [{ url: 'https://externo.example/x.png' }], next_cursor: null }), { status: 200 }));
    await assert.rejects(servico.listarInventario(), /fora da base pública autorizada/);
});

test('inventário indisponível falha sem fabricar catálogo', async () => {
    const servico = criarMediaService({ midia: { uploadUrl: 'https://storage.example/upload', uploadKey: 'x' } });
    await assert.rejects(servico.listarInventario(), erro => erro.code === 'MIDIA_INVENTARIO_NAO_CONFIGURADO');
});

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

test('envia Reel MP4 válido e confirma Content-Type público', async () => {
    const servico = criarServico((url, opcoes) => {
        if (opcoes.method === 'POST') return new Response(JSON.stringify({ ok: true, url: 'https://cdn.dominio-publico.com/video.mp4', arquivo: 'video.mp4' }), { status: 201, headers: { 'content-type': 'application/json' } });
        return new Response('', { status: 200, headers: { 'content-type': 'video/mp4' } });
    });
    const resultado = await servico.enviar({ dados: MP4, mime: 'video/mp4', nome: 'reel.mp4' });
    assert.equal(resultado.mime, 'video/mp4');
    assert.match(resultado.url, /\.mp4$/);
});

test('formato inválido é recusado sem chamar a rede', async () => {
    let chamou = false;
    const servico = criarServico(() => { chamou = true; return new Response('{}'); });
    await assert.rejects(servico.enviar({ dados: 'data:image/gif;base64,R0lGOD', mime: 'image/gif', nome: 'x.gif' }), /JPEG, PNG, WebP ou vídeo MP4/);
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

test('resposta vazia HTTP 500 identifica falha da hospedagem sem expor o corpo', async () => {
    const servico = criarServico(() => new Response('', { status: 500, headers: { 'content-type': 'text/html; charset=UTF-8' } }));
    await assert.rejects(servico.enviar({ dados: PNG, mime: 'image/png', nome: 'foto.png' }), /HTTP 500 \(text\/html\).*log de erros/);
});

test('resposta HTML HTTP 413 orienta limites sem exibir conteúdo remoto', async () => {
    const servico = criarServico(() => new Response('<html>conteudo-privado</html>', { status: 413, headers: { 'content-type': 'text/html' } }));
    await assert.rejects(servico.enviar({ dados: PNG, mime: 'image/png', nome: 'foto.png' }), erro => {
        assert.match(erro.message, /HTTP 413.*limites do PHP/);
        assert.equal(erro.message.includes('conteudo-privado'), false);
        return true;
    });
});

test('capacidades indicam configuração do storage', () => {
    const servico = criarServico(() => new Response('{}'));
    const c = servico.capacidades();
    assert.equal(c.configurado, true);
    assert.deepEqual(c.tiposAceitos, ['image/jpeg', 'image/png', 'image/webp', 'video/mp4']);
    assert.equal(c.limiteVideoBytes, 256 * 1024 * 1024);
    assert.equal(c.prazoUploadMs, 600000);
});

test('MP4 acima do antigo limite de 50 MB passa e assinatura falsa é recusada', () => {
    const servico = criarServico(() => { throw new Error('Não deve chamar a rede'); });
    const buffer = Buffer.alloc(51 * 1024 * 1024);
    buffer.write('ftyp', 4, 'ascii');
    const dados = `data:video/mp4;base64,${buffer.toString('base64')}`;
    assert.equal(servico.decodificarMidia(dados, 'video/mp4', 'video.mp4').length, buffer.length);
    assert.throws(() => servico.decodificarMidia(PNG.replace('image/png', 'video/mp4'), 'video/mp4', 'falso.mp4'), /MP4 válido/);
});
