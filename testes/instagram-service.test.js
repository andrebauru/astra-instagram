'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { criarInstagramService } = require('../services/instagram-service');

/** Serviço com fetch fictício que responde ao contrato real da API. */
function criarServico(responder, eventos = []) {
    const fetchImpl = async (url, opcoes) => {
        const endereco = String(url);
        eventos.push({ url: endereco, metodo: opcoes.method });
        return responder(endereco, opcoes);
    };
    return criarInstagramService({
        token: 'token-ficticio-teste',
        accountId: 'conta-teste',
        baseUrl: 'https://graph.instagram.com',
        fetchImpl,
        esperar: async () => {},
        registrar: () => {}
    });
}

const json = (dados, status = 200) => new Response(JSON.stringify(dados), { status });

test('publish de imagem cria container e publica', async () => {
    const servico = criarServico(url => url.includes('media_publish') ? json({ id: 'pub-imagem' }) : json({ id: 'container-imagem' }));
    const resultado = await servico.publish({ formato: 'imagem', imageUrl: 'https://midia.dominio-publico.com/a.jpg', caption: 'Olá' });
    assert.equal(resultado.mediaId, 'pub-imagem');
    assert.equal(resultado.formato, 'imagem');
});

test('publish de reel aguarda FINISHED antes de publicar', async () => {
    const chamadas = [];
    const servico = criarServico(url => {
        chamadas.push(url);
        if (url.includes('media_publish')) return json({ id: 'pub-reel' });
        if (url.includes('status_code')) return json({ status_code: 'FINISHED' });
        return json({ id: 'container-reel' });
    });
    const resultado = await servico.publish({ formato: 'reel', videoUrl: 'https://midia.dominio-publico.com/v.mp4', caption: 'Reel' });
    assert.equal(resultado.mediaId, 'pub-reel');
    assert.ok(chamadas.some(url => url.includes('status_code')));
});

test('publish de carrossel cria os filhos na ordem e confirma o pai', async () => {
    const eventos = [];
    let itens = 0;
    const servico = criarServico((url, opcoes) => {
        if (url.includes('media_publish')) return json({ id: 'pub-carrossel' });
        if (url.includes('status_code')) return json({ status_code: 'FINISHED' });
        const corpo = String(opcoes.body || '');
        if (!corpo.includes('is_carousel_item')) return json({ id: 'container-pai' });
        itens += 1;
        return json({ id: `filho-${itens}` });
    }, eventos);
    const resultado = await servico.publish({
        formato: 'carrossel',
        caption: 'Carrossel',
        itens: [
            { tipo: 'imagem', url: 'https://midia.dominio-publico.com/1.jpg' },
            { tipo: 'imagem', url: 'https://midia.dominio-publico.com/2.jpg' }
        ]
    });
    assert.equal(resultado.mediaId, 'pub-carrossel');
    assert.equal(itens, 2);
    const pai = eventos.find(e => String(e.url).endsWith('/media') && e.metodo === 'POST');
    assert.ok(pai);
});

test('reel com status ERROR falha sem publicar', async () => {
    const servico = criarServico(url => {
        if (url.includes('media_publish')) return json({ id: 'nao-deveria' });
        if (url.includes('status_code')) return json({ status_code: 'ERROR' });
        return json({ id: 'container-erro' });
    });
    await assert.rejects(servico.publish({ formato: 'reel', videoUrl: 'https://midia.dominio-publico.com/v.mp4', caption: 'x' }), /processamento/i);
});

test('URL local é recusada antes de chamar a API', async () => {
    let chamou = false;
    const servico = criarServico(() => { chamou = true; return json({ id: 'x' }); });
    await assert.rejects(servico.publish({ formato: 'imagem', imageUrl: 'C:\\foto.jpg', caption: 'x' }), /URL HTTPS pública/i);
    assert.equal(chamou, false);
});

test('carrossel exige ao menos dois itens públicos', async () => {
    const servico = criarServico(() => json({ id: 'x' }));
    await assert.rejects(servico.publish({ formato: 'carrossel', itens: [{ tipo: 'imagem', url: 'https://midia.dominio-publico.com/1.jpg' }] }), /2 a 20/);
});

test('erro de autenticação da Meta vira INSTAGRAM_TOKEN_INVALIDO', async () => {
    const servico = criarServico(() => json({ error: { code: 190, message: 'Token inválido' } }, 400));
    await assert.rejects(servico.publish({ formato: 'imagem', imageUrl: 'https://midia.dominio-publico.com/a.jpg' }), erro => erro.codigo === 'INSTAGRAM_TOKEN_INVALIDO');
});
