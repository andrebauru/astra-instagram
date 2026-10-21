'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { criarFacebookService } = require('../services/facebook-service');
const { criarStoreIntegracoes } = require('../services/integracoes-store');
const IR = require('../painel-meta-prototipo/integracao-regras');

test('elegibilidade respeita os 16 conjuntos de destinos e explica todos os bloqueios', () => {
    for (let mascara = 0; mascara < 16; mascara++) {
        const p = { tipoMidia: 'imagem', imagemUrl: 'https://exemplo.com/foto.jpg', estado: 'confirmado', publicarInstagram: Boolean(mascara & 1), publicarFacebook: Boolean(mascara & 2), publicarStory: Boolean(mascara & 4), publicarFacebookStory: Boolean(mascara & 8) };
        const contexto = { servidorOnline: true, instagramVerificado: Boolean(mascara & 5), facebookVerificado: Boolean(mascara & 10), contaInstagram: 'BUSINESS' };
        const resultado = IR.avaliarPublicacaoImediata(p, { validar: () => [] }, contexto);
        assert.equal(resultado.podePublicar, mascara !== 0, `destinos ${mascara}`);
        assert.equal(resultado.motivos.length === 0, mascara !== 0);
        if (mascara) {
            assert.equal(IR.avaliarPublicacaoImediata({ ...p, estado: 'rascunho' }, { validar: () => [] }, contexto).podePublicar, false);
            assert.equal(IR.avaliarPublicacaoImediata({ ...p, statusPublicacao: 'publicado' }, { validar: () => [] }, contexto).podePublicar, false);
        }
    }
});

test('Facebook Story de foto prepara mídia separada, publica e não repete confirmação', async () => {
    const p = preparar(url => url.endsWith('/photos') ? { id: 'foto-story' } : { success: true, post_id: 'story-1' });
    const entrada = { formato: 'imagem', imageUrl: 'https://exemplo.com/foto.jpg' };
    assert.equal((await p.servico.publicarStory(entrada, 'p')).mediaId, 'story-1');
    await p.servico.publicarStory(entrada, 'p');
    assert.equal(p.chamadas.length, 2);
    assert.equal(new URLSearchParams(p.chamadas[0].opcoes.body).get('published'), 'false');
    assert.ok(p.chamadas[1].url.endsWith('/photo_stories'));
});

test('Facebook Story MP4 realiza início, upload seguro e finalização', async () => {
    const p = preparar((url, opcoes) => {
        const fase = new URLSearchParams(opcoes.body).get('upload_phase');
        return fase === 'START' ? { video_id: 'v1', upload_url: 'https://rupload.facebook.com/video-upload/v1' } : { success: true };
    });
    assert.equal((await p.servico.publicarStory({ formato: 'reel', videoUrl: 'https://exemplo.com/video.mp4' }, 'video')).mediaId, 'v1');
    assert.equal(p.chamadas.length, 3);
    assert.equal(p.chamadas[1].opcoes.headers.file_url, 'https://exemplo.com/video.mp4');
    assert.equal(new URLSearchParams(p.chamadas[2].opcoes.body).get('video_state'), 'PUBLISHED');
});

test('Story Facebook não aceita HTTP 200 sem confirmação nem reenvia resultado incerto', async () => {
    const p = preparar(url => url.endsWith('/photos') ? { id: 'foto' } : {});
    const entrada = { formato: 'imagem', imageUrl: 'https://exemplo.com/foto.jpg' };
    await assert.rejects(p.servico.publicarStory(entrada, 'p'));
    await assert.rejects(p.servico.publicarStory(entrada, 'p'));
    assert.equal(p.chamadas.length, 2);
    assert.ok(!p.estados.get('p:facebook-story').mediaId);
});

test('upload de Story recusa host externo antes de enviar token e rejeita carrossel', async () => {
    const p = preparar(() => ({ video_id: 'v', upload_url: 'https://externo.example/upload' }));
    await assert.rejects(p.servico.publicarStory({ formato: 'reel', videoUrl: 'https://exemplo.com/video.mp4' }, 'p'));
    assert.equal(p.chamadas.length, 1);
    assert.throws(() => p.servico.validarStory({ formato: 'carrossel', itens: [] }));
});

/** Cria serviço isolado com transporte e persistência simulados. */
function preparar(responder = () => ({ id: 'foto', post_id: 'post' })) {
    const estados = new Map(), chamadas = [];
    const store = { obter: chave => structuredClone(estados.get(chave)), salvar: (chave, valor) => estados.set(chave, structuredClone(valor)) };
    const servico = criarFacebookService({ pageId: '123', token: 'segredo-ficticio', versao: 'v25.0', store,
        fetchImpl: async (url, opcoes) => { chamadas.push({ url, opcoes }); const resposta = await responder(url, opcoes); return resposta instanceof Response ? resposta : Response.json(resposta); } });
    return { servico, chamadas, estados };
}

test('Facebook publica imagem, mantém token fora da URL e não repete sucesso', async () => {
    const { servico, chamadas } = preparar();
    const entrada = { formato: 'imagem', imageUrl: 'https://exemplo.com/foto.jpg', caption: 'Teste' };
    assert.equal((await servico.publish(entrada, 'pub')).mediaId, 'post');
    await servico.publish(entrada, 'pub');
    assert.equal(chamadas.length, 1);
    assert.equal(chamadas[0].url, 'https://graph.facebook.com/v25.0/123/photos');
    assert.equal(chamadas[0].opcoes.headers.Authorization, 'Bearer segredo-ficticio');
    assert.ok(!chamadas[0].url.includes('segredo'));
    await assert.rejects(servico.publish({ ...entrada, caption: 'mudou' }, 'pub'), erro => erro.codigo === 'PUBLICACAO_DIVERGENTE');
});

test('Facebook encaminha a legenda completa com links ao campo caption da foto', async () => {
    const { servico, chamadas } = preparar();
    const legenda = 'Visite https://site.example e veja o mapa https://maps.example/local';
    await servico.publish({ formato: 'imagem', imageUrl: 'https://exemplo.com/foto.jpg', caption: legenda }, 'links');
    assert.equal(new URLSearchParams(chamadas[0].opcoes.body).get('caption'), legenda);
});

test('Facebook publica três fotos preservando todos os IDs anexados', async () => {
    let n = 0;
    const { servico, chamadas } = preparar(() => ({ id: `id-${++n}` }));
    await servico.publish({ formato: 'carrossel', itens: [1, 2, 3].map(i => ({ tipo: 'imagem', url: `https://exemplo.com/${i}.jpg` })) }, 'album');
    assert.equal(chamadas.length, 4);
    for (const chamada of chamadas.slice(0, 3)) assert.equal(new URLSearchParams(chamada.opcoes.body).get('published'), 'false');
    assert.deepEqual(JSON.parse(new URLSearchParams(chamadas[3].opcoes.body).get('attached_media')), [{ media_fbid: 'id-1' }, { media_fbid: 'id-2' }, { media_fbid: 'id-3' }]);
});

test('Facebook envia vídeo como vídeo da Página, sem anunciar Reel', async () => {
    const { servico, chamadas } = preparar();
    await servico.publish({ formato: 'reel', videoUrl: 'https://exemplo.com/video.mp4' }, 'video');
    assert.match(chamadas[0].url, /\/videos$/);
    assert.equal(new URLSearchParams(chamadas[0].opcoes.body).get('file_url'), 'https://exemplo.com/video.mp4');
});

test('Facebook recusa mídia privada e carrossel com vídeo antes da rede', async () => {
    const { servico, chamadas } = preparar();
    await assert.rejects(servico.publish({ formato: 'imagem', imageUrl: 'https://127.0.0.1/foto.jpg' }, 'a'));
    await assert.rejects(servico.publish({ formato: 'carrossel', itens: [{ tipo: 'video', url: 'https://exemplo.com/v.mp4' }, { tipo: 'imagem', url: 'https://exemplo.com/f.jpg' }] }, 'b'));
    assert.equal(chamadas.length, 0);
});

test('Facebook não repete upload após perda de confirmação ou erro 500', async () => {
    for (const responder of [() => { throw new Error('rede'); }, () => Response.json({ error: {} }, { status: 500 })]) {
        const { servico, chamadas } = preparar(responder);
        const entrada = { formato: 'imagem', imageUrl: 'https://exemplo.com/f.jpg' };
        await assert.rejects(servico.publish(entrada, 'a'));
        await assert.rejects(servico.publish(entrada, 'a'), erro => erro.codigo === 'PUBLICACAO_INDETERMINADA');
        assert.equal(chamadas.length, 1);
    }
});

test('configuração persiste segredo sem retorná-lo; vazio mantém chave e ID inválido não grava', () => {
    const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-config-test-'));
    const arquivo = path.join(pasta, 'integracoes.json');
    const anterior = { ...process.env };
    try {
        const opcoes = { obterChave: () => Buffer.alloc(32, 7) };
        const store = criarStoreIntegracoes(arquivo, opcoes);
        const retorno = store.salvar({ META_APP_ID: '123', OPENROUTER_API_KEY: 'segredo-config-test' });
        assert.equal(retorno.META_APP_ID, '123');
        assert.equal(retorno.OPENROUTER_API_KEY, true);
        assert.ok(!JSON.stringify(retorno).includes('segredo-config-test'));
        store.salvar({ OPENROUTER_API_KEY: '' });
        assert.equal(JSON.parse(fs.readFileSync(arquivo)).cofre, 1);
        assert.ok(!fs.readFileSync(arquivo, 'utf8').includes('segredo-config-test'));
        assert.throws(() => store.salvar({ META_APP_ID: 'não-numérico' }));
        assert.throws(() => store.salvar({ MEDIA_UPLOAD_URL: 'https://outro.com' }));
        delete process.env.OPENROUTER_API_KEY;
        criarStoreIntegracoes(arquivo, opcoes).carregar();
        assert.equal(process.env.OPENROUTER_API_KEY, 'segredo-config-test');
    } finally {
        for (const campo of ['META_APP_ID', 'OPENROUTER_API_KEY']) { if (anterior[campo] === undefined) delete process.env[campo]; else process.env[campo] = anterior[campo]; }
        fs.rmSync(pasta, { recursive: true });
    }
});

test('trocar destinos invalida assinatura editorial e nenhum destino bloqueia revisão', () => {
    const p = { publicarInstagram: true, publicarFacebook: false };
    const assinatura = IR.assinaturaConteudo(p);
    p.publicarFacebook = true;
    assert.notEqual(IR.assinaturaConteudo(p), assinatura);
    p.publicarInstagram = false; p.publicarFacebook = false;
    assert.equal(IR.validarInstagram(p, { validar: () => [] }).find(item => item.texto === 'Ao menos um destino selecionado').ok, false);
});
