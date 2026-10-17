'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { criarInstagramService } = require('../services/instagram-service');

/** Serviço com fetch fictício que responde ao contrato real da API. */
function criarServico(responder, eventos = []) {
    const fetchImpl = async (url, opcoes) => {
        const endereco = String(url);
        eventos.push({ url: endereco, metodo: opcoes.method, corpo: String(opcoes.body || '') });
        return responder(endereco, opcoes);
    };
    return criarInstagramService({
        token: 'token-ficticio-teste',
        accountId: 'conta-teste',
        baseUrl: 'https://graph.instagram.com',
        fetchImpl,
        resolverIPs: async () => ['8.8.8.8'],
        esperar: async () => {},
        registrar: () => {}
    });
}

const json = (dados, status = 200) => new Response(JSON.stringify(dados), { status });

test('publish de imagem cria container e publica', async () => {
    const servico = criarServico(url => url.includes('media_publish') ? json({ id: 'pub-imagem' }) : url.includes('status_code') ? json({ status_code: 'FINISHED' }) : json({ id: 'container-imagem' }));
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
    await assert.rejects(servico.publish({ formato: 'reel', videoUrl: 'https://midia.dominio-publico.com/v.mp4', caption: 'x' }), /processar/i);
});

test('imagem aguarda IN_PROGRESS até FINISHED antes de media_publish', async () => {
    const eventos = [];
    let consultas = 0;
    const servico = criarServico(url => {
        if (url.includes('status_code')) return json({ status_code: ++consultas < 3 ? 'IN_PROGRESS' : 'FINISHED' });
        if (url.includes('media_publish')) return json({ id: 'pub-pronta' });
        return json({ id: 'container-pronto' });
    }, eventos);
    const resultado = await servico.publish({ formato: 'imagem', imageUrl: 'https://midia.dominio-publico.com/a.jpg' });
    assert.equal(resultado.mediaId, 'pub-pronta');
    assert.equal(consultas, 3);
    assert.ok(eventos.findIndex(e => e.url.includes('media_publish')) > eventos.findLastIndex(e => e.url.includes('status_code')));
});

test('retry consulta contêiner PUBLISHED e não cria nem publica novamente', async () => {
    const eventos = [];
    const servico = criarServico(url => {
        if (url.includes('status_code')) return json({ status_code: 'PUBLISHED', media_id: 'pub-existente' });
        throw new Error(`chamada inesperada: ${url}`);
    }, eventos);
    const resultado = await servico.publish({ formato: 'imagem', imageUrl: 'https://midia.dominio-publico.com/a.jpg', containerId: 'container-existente' });
    assert.equal(resultado.mediaId, 'pub-existente');
    assert.equal(resultado.recuperado, true);
    assert.equal(eventos.filter(e => e.metodo === 'POST').length, 0);
});

test('timeout preserva container e não chama media_publish', async () => {
    const eventos = [];
    const servico = criarServico(url => url.includes('status_code') ? json({ status_code: 'IN_PROGRESS' }) : json({ id: 'container-lento' }), eventos);
    await assert.rejects(servico.publish({ formato: 'imagem', imageUrl: 'https://midia.dominio-publico.com/a.jpg' }), erro => {
        assert.equal(erro.codigo, 'INSTAGRAM_CONTAINER_TEMPO_ESGOTADO');
        assert.equal(erro.containerId, 'container-lento');
        return true;
    });
    assert.equal(eventos.filter(e => e.url.includes('media_publish')).length, 0);
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

test('Story de imagem exige Business, usa STORIES e não envia legenda', async () => {
    const eventos = [];
    const servico = criarServico((url, opcoes) => {
        if (url.includes('/conta-teste?')) return json({ id: 'business-1', account_type: 'BUSINESS' });
        if (url.includes('status_code')) return json({ status_code: 'FINISHED' });
        if (url.includes('media_publish')) return json({ id: 'story-imagem' });
        return json({ id: 'container-story-imagem' });
    }, eventos);
    const resultado = await servico.publish({ formato: 'story', imageUrl: 'https://midia.dominio-publico.com/story.jpg', storyTipo: 'imagem', caption: 'não enviar' });
    assert.equal(resultado.mediaId, 'story-imagem');
    const criacao = eventos.find(e => e.metodo === 'POST' && /\/media(?:\?|$)/.test(e.url));
    assert.ok(criacao);
    assert.match(criacao.corpo, /media_type=STORIES/);
    assert.match(criacao.corpo, /image_url=/);
    assert.doesNotMatch(criacao.corpo, /caption=/);
});

test('Story em vídeo MP4 percorre IN_PROGRESS e FINISHED', async () => {
    let consultas = 0;
    const eventos = [];
    const servico = criarServico((url, opcoes) => {
        if (url.includes('/conta-teste?')) return json({ id: 'business-1', account_type: 'BUSINESS' });
        if (url.includes('status_code')) return json({ status_code: ++consultas === 1 ? 'IN_PROGRESS' : 'FINISHED' });
        if (url.includes('media_publish')) return json({ id: 'story-video' });
        return json({ id: 'container-story-video' });
    }, eventos);
    const resultado = await servico.publish({ formato: 'story', videoUrl: 'https://midia.dominio-publico.com/story.mp4', storyTipo: 'video' });
    assert.equal(resultado.mediaId, 'story-video');
    assert.equal(consultas, 2);
});

test('Story é recusado para conta não Business', async () => {
    const servico = criarServico(url => url.includes('/conta-teste?') ? json({ id: 'creator-1', account_type: 'MEDIA_CREATOR' }) : json({ id: 'inesperado' }));
    await assert.rejects(servico.publish({ formato: 'story', imageUrl: 'https://midia.dominio-publico.com/story.jpg', storyTipo: 'imagem' }), erro => erro.codigo === 'STORY_REQUER_BUSINESS');
});

for (const [status, codigo] of [['ERROR', 'INSTAGRAM_CONTAINER_ERRO'], ['EXPIRED', 'INSTAGRAM_CONTAINER_EXPIRADO']]) {
    test(`Story trata ${status} sem chamar media_publish`, async () => {
        let publicou = false;
        const servico = criarServico(url => {
            if (url.includes('/conta-teste?')) return json({ id: 'business-1', account_type: 'BUSINESS' });
            if (url.includes('status_code')) return json({ status_code: status });
            if (url.includes('media_publish')) { publicou = true; return json({ id: 'indevido' }); }
            return json({ id: `container-${status}` });
        });
        await assert.rejects(servico.publish({ formato: 'story', imageUrl: 'https://midia.dominio-publico.com/story.jpg', storyTipo: 'imagem' }), erro => erro.codigo === codigo);
        assert.equal(publicou, false);
    });
}

test('Story em timeout preserva contêiner e PUBLISHED é recuperado sem duplicar', async () => {
    let publicar = 0;
    const lento = criarServico(url => {
        if (url.includes('/conta-teste?')) return json({ id: 'business-1', account_type: 'BUSINESS' });
        if (url.includes('status_code')) return json({ status_code: 'IN_PROGRESS' });
        if (url.includes('media_publish')) publicar += 1;
        return json({ id: 'container-story-lento' });
    });
    await assert.rejects(lento.publish({ formato: 'story', imageUrl: 'https://midia.dominio-publico.com/story.jpg', storyTipo: 'imagem' }), erro => erro.codigo === 'INSTAGRAM_CONTAINER_TEMPO_ESGOTADO' && erro.containerId === 'container-story-lento');
    assert.equal(publicar, 0);

    const recuperado = criarServico(url => {
        if (url.includes('/conta-teste?')) return json({ id: 'business-1', account_type: 'BUSINESS' });
        if (url.includes('status_code')) return json({ status_code: 'PUBLISHED', media_id: 'story-existente' });
        throw new Error('não deve criar nem publicar');
    });
    const resultado = await recuperado.publish({ formato: 'story', imageUrl: 'https://midia.dominio-publico.com/story.jpg', storyTipo: 'imagem', containerId: 'container-story-existente' });
    assert.equal(resultado.mediaId, 'story-existente');
});

test('Reel rejeita URL sem extensão MP4 quando Content-Type não é video/mp4', async () => {
    const servico = criarServico((url, opcoes) => {
        if (opcoes.method === 'HEAD' || opcoes.method === 'GET') return new Response('', { status: 200, headers: { 'content-type': 'video/webm' } });
        return json({ id: 'não-deveria' });
    });
    await assert.rejects(servico.publish({ formato: 'reel', videoUrl: 'https://midia.dominio-publico.com/video.webm' }), erro => erro.codigo === 'REEL_MP4_OBRIGATORIO');
});
