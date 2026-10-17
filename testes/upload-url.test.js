'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const R = require('../painel-meta-prototipo/regras');
const Publicacoes = require('../painel-meta-prototipo/publicacoes');
const IR = require('../painel-meta-prototipo/integracao-regras');

const URL_OK = 'https://quimbanda.jp/astra/media/public/arquivo.png';

/** Publicação de imagem única com uma mídia ainda sem URL pública. */
function conteudoImagem() {
    const p = R.criarConteudo();
    p.tipoMidia = 'imagem';
    p.imagens = [{ id: 'm1', nome: 'arquivo.png', tipo: 'imagem', mime: 'image/png', tamanho: 10, urlPublica: '', status: 'disponível' }];
    return p;
}

test('upload de imagem preenche midia.urlPublica e atual.imagemUrl', () => {
    const atual = conteudoImagem();
    const atualizada = Publicacoes.registrarUrlPublica(atual, 'm1', URL_OK, { bytes: 68, filename: 'arquivo.png' });
    assert.equal(atualizada.urlPublica, URL_OK, 'midia.urlPublica');
    assert.equal(atual.imagens[0].urlPublica, URL_OK);
    assert.equal(atual.imagemUrl, URL_OK, 'atual.imagemUrl');
    assert.equal(atual.imagens[0].statusUpload, 'concluído');
    assert.equal(atual.imagens[0].tamanho, 68);
    assert.equal(atual.imagens[0].arquivo, 'arquivo.png');
    assert.ok(IR.midiasPublicasProntas(atual), 'revisão reconhece a URL HTTPS');
});

test('campo visual recebe exatamente atual.imagemUrl', () => {
    const atual = conteudoImagem();
    Publicacoes.registrarUrlPublica(atual, 'm1', URL_OK, {});
    const campo = { value: '' };
    const valor = Publicacoes.sincronizarUrlPublicaNoCampo(campo, atual);
    assert.equal(campo.value, URL_OK);
    assert.equal(valor, URL_OK);
});

test('a URL permanece após nova renderização e após migração', () => {
    const atual = conteudoImagem();
    Publicacoes.registrarUrlPublica(atual, 'm1', URL_OK, {});
    const campo = { value: '' };
    Publicacoes.sincronizarUrlPublicaNoCampo(campo, atual);
    Publicacoes.migrarPublicacao(atual); // equivale a re-renderizar/preencher novamente
    assert.equal(atual.imagemUrl, URL_OK);
    assert.equal(atual.imagens[0].urlPublica, URL_OK);
    Publicacoes.sincronizarUrlPublicaNoCampo(campo, atual);
    assert.equal(campo.value, URL_OK, 'a URL não desaparece após rerender');
    assert.equal(atual.imagens[0].urlPublica, atual.imagemUrl, 'imagem única: imagens[0] === imagemUrl');
});

test('mídia é localizada pelo ID mesmo quando a referência foi recriada', () => {
    const atual = conteudoImagem();
    // Simula recriação do objeto da mídia durante renderização/migração.
    atual.imagens[0] = { ...atual.imagens[0] };
    const nova = 'https://quimbanda.jp/astra/media/public/outro.png';
    const encontrada = Publicacoes.registrarUrlPublica(atual, 'm1', nova, {});
    assert.ok(encontrada);
    assert.equal(atual.imagens[0].urlPublica, nova);
    assert.equal(atual.imagemUrl, nova);
});

test('Reel preenche videoUrl e não mexe em imagemUrl', () => {
    const p = R.criarConteudo();
    p.tipoMidia = 'reel';
    p.imagemUrl = 'https://quimbanda.jp/astra/media/public/imagem.png';
    p.imagens = [{ id: 'v1', nome: 'video.mp4', tipo: 'video', urlPublica: '' }];
    Publicacoes.registrarUrlPublica(p, 'v1', 'https://quimbanda.jp/astra/media/public/video.mp4', {});
    assert.equal(p.videoUrl, 'https://quimbanda.jp/astra/media/public/video.mp4');
    assert.equal(p.imagemUrl, 'https://quimbanda.jp/astra/media/public/imagem.png');
    assert.equal(IR.midiasPublicasProntas(p), true);
});

test('carrossel guarda a URL em cada mídia sem sobrescrever imagemUrl', () => {
    const p = R.criarConteudo();
    p.tipoMidia = 'carrossel';
    p.imagens = [
        { id: 'a', tipo: 'imagem', urlPublica: '' },
        { id: 'b', tipo: 'imagem', urlPublica: '' }
    ];
    Publicacoes.registrarUrlPublica(p, 'a', 'https://quimbanda.jp/astra/media/public/a.png', {});
    Publicacoes.registrarUrlPublica(p, 'b', 'https://quimbanda.jp/astra/media/public/b.png', {});
    assert.equal(p.imagens[0].urlPublica, 'https://quimbanda.jp/astra/media/public/a.png');
    assert.equal(p.imagens[1].urlPublica, 'https://quimbanda.jp/astra/media/public/b.png');
    assert.equal(p.imagemUrl, '');
});

test('carrossel com 3 URLs HTTPS válidas libera a revisão', () => {
    const p = R.criarConteudo();
    p.tipoMidia = 'carrossel';
    p.imagens = ['a', 'b', 'c'].map(id => ({ id, tipo: 'imagem', urlPublica: `https://quimbanda.jp/astra/media/public/${id}.png` }));
    assert.equal(IR.midiasPublicasProntas(p), true);
});

test('carrossel com uma das 3 URLs faltando continua bloqueado', () => {
    const p = R.criarConteudo();
    p.tipoMidia = 'carrossel';
    p.imagens = [
        { id: 'a', tipo: 'imagem', urlPublica: 'https://quimbanda.jp/astra/media/public/a.png' },
        { id: 'b', tipo: 'imagem', urlPublica: '' },
        { id: 'c', tipo: 'imagem', urlPublica: 'https://quimbanda.jp/astra/media/public/c.png' }
    ];
    assert.equal(IR.midiasPublicasProntas(p), false);
});

test('mudança do select grava o valor interno aceito', () => {
    const p = R.criarConteudo();
    assert.equal(Publicacoes.definirTipoMidia(p, 'carrossel'), true);
    assert.equal(p.tipoMidia, 'carrossel');
    assert.equal(Publicacoes.definirTipoMidia(p, 'valor inválido'), false);
    assert.equal(p.tipoMidia, 'carrossel');
});

test('publicação existente normaliza o rótulo visual e mantém o select compatível', () => {
    const p = R.criarConteudo();
    p.tipoMidia = 'Carrossel local';
    Publicacoes.migrarPublicacao(p);
    assert.equal(p.tipoMidia, 'carrossel');
});

test('migração não apaga urlPublica existente', () => {
    const atual = conteudoImagem();
    Publicacoes.registrarUrlPublica(atual, 'm1', URL_OK, {});
    Publicacoes.migrarPublicacao(atual);
    assert.equal(atual.imagens[0].urlPublica, URL_OK);
});

test('resposta sem public_url é tratada como falha (não zera a URL atual)', () => {
    const atual = conteudoImagem();
    Publicacoes.registrarUrlPublica(atual, 'm1', URL_OK, {});
    const resultado = Publicacoes.registrarUrlPublica(atual, 'm1', '', {});
    assert.equal(resultado, null);
    assert.equal(atual.imagemUrl, URL_OK);
});
