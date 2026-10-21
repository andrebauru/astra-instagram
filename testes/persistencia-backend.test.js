'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const IR = require('../painel-meta-prototipo/integracao-regras');
const { decodificarMidia } = require('../midia-publica');
const { criarStoreTemplates } = require('../services/templates-store');
const { criarStorePublicacoes } = require('../services/publicacoes-store');

function temporario(nome) { return path.join(os.tmpdir(), `${nome}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`); }

test('Reel exige arquivo .mp4 e MIME video/mp4', () => {
    assert.equal(IR.arquivoReelMp4({ tipo: 'video', mime: 'video/mp4', nome: 'ritual.MP4' }), true);
    assert.equal(IR.arquivoReelMp4({ tipo: 'video', mime: 'video/mp4', nome: 'ritual.mov' }), false);
    assert.equal(IR.arquivoReelMp4({ tipo: 'video', mime: 'video/webm', nome: 'ritual.mp4' }), false);
    assert.equal(IR.reelMp4Valido({ videoUrl: 'https://cdn.dominio-publico.com/ritual.mp4', imagens: [] }), true);
    assert.equal(IR.reelMp4Valido({ videoUrl: 'https://cdn.dominio-publico.com/ritual.webm', imagens: [] }), false);
});

test('assinatura MP4 válida é aceita e extensão ou MIME incompatível é recusado', () => {
    const buffer = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(16)]);
    const dados = `data:video/mp4;base64,${buffer.toString('base64')}`;
    assert.equal(decodificarMidia(dados, 'video/mp4', 'video.mp4').length, buffer.length);
    assert.throws(() => decodificarMidia(dados, 'video/mp4', 'video.mov'), /extensão \.mp4/);
    assert.throws(() => decodificarMidia(dados.replace('video/mp4', 'video/webm'), 'video/webm', 'video.mp4'), /JPEG, PNG, WebP ou vídeo MP4/);
});

test('biblioteca mantém dois templates e migra configuração anterior sem perda', () => {
    const caminho = temporario('astra-templates');
    const store = criarStoreTemplates(caminho);
    const migrados = store.migrar({ texto: 'Texto anterior', aplicarAutomatico: true }, { site: 'https://site.jp', linksAdicionais: 'https://outro.jp', hashtagsPadrao: '#fixa' });
    assert.equal(migrados.length, 1);
    assert.equal(migrados[0].id, 'template-migrado');
    const segundo = store.salvar({ nome: 'Segundo', texto: 'Outro texto', hashtags: '#outra' }, { novo: true });
    assert.ok(segundo.id);
    const aposReinicio = criarStoreTemplates(caminho).listar();
    assert.equal(aposReinicio.length, 2);
    assert.equal(aposReinicio[0].site, 'https://site.jp');
    assert.equal(aposReinicio[1].nome, 'Segundo');
    fs.rmSync(caminho, { force: true });
});

test('rascunho persiste sem mídia embutida e conflito não sobrescreve versão mais nova', () => {
    const caminho = temporario('astra-publicacoes');
    const store = criarStorePublicacoes(caminho);
    const salvo = store.salvar({ id: 'rascunho-1', titulo: 'Primeiro', atualizadoEm: '2026-10-08T00:00:00.000Z', imagens: [{ id: 'm1', dados: 'data:image/png;base64,AAA', miniatura: 'data:image/png;base64,AAA', urlPublica: 'https://cdn.jp/a.png' }] });
    assert.equal(salvo.conflito, false);
    const relido = criarStorePublicacoes(caminho).obter('rascunho-1');
    assert.equal(relido.titulo, 'Primeiro');
    assert.equal(relido.imagens[0].dados, undefined);
    const conflito = store.salvar({ id: 'rascunho-1', titulo: 'Antigo', atualizadoEm: '2020-01-01T00:00:00.000Z', imagens: [] });
    assert.equal(conflito.conflito, true);
    assert.equal(conflito.publicacao.titulo, 'Primeiro');
    fs.rmSync(caminho, { force: true });
});

test('painel expõe biblioteca, Story e criação evidente de rascunho histórico', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'painel-meta-prototipo', 'index.html'), 'utf8');
    const js = fs.readFileSync(path.join(__dirname, '..', 'painel-meta-prototipo', 'painel.js'), 'utf8');
    const css = fs.readFileSync(path.join(__dirname, '..', 'painel-meta-prototipo', 'estilo.css'), 'utf8');
    for (const id of ['template-nome', 'template-seletor', 'template-atualizar', 'publicar-story', 'periodo-story']) assert.match(html, new RegExp(`id="${id}"`));
    assert.match(js, /Usar como exemplo e criar rascunho/);
    assert.match(js, /referenciaImportada/);
    assert.match(js, /nova\.imagens = \[\]/);
    assert.match(js, /Rascunho salvo no servidor/);
    assert.match(js, /const sincronizado = await sincronizarPublicacaoBackend\(atual\);/);
    assert.match(js, /if \(!sincronizado\) throw erro;/);
    assert.match(js, /img\.loading = indice < 6 \? 'eager' : 'lazy'/);
    assert.doesNotMatch(js, /img\.hidden = true/);
    assert.match(css, /#urls-publicas-midias li,#urls-publicas-midias a\{overflow-wrap:anywhere/);
});
