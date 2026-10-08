'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const R = require('../painel-meta-prototipo/regras');
const PS = require('../painel-meta-prototipo/planejamento-semanal');
const Publicacoes = require('../painel-meta-prototipo/publicacoes');
const Fluxo = require('../painel-meta-prototipo/fluxo-editorial');
const { normalizarMidia } = require('../services/insights-service');

const URL = 'https://quimbanda.jp/astra/media/public/imagem.png';

function conteudoCompleto() {
    const p = R.criarConteudo();
    p.id = 'publicacao-1'; p.legenda = 'Texto editorial original.';
    p.templateTexto = 'Informações fixas\nhttps://quimbanda.jp';
    p.linksAdicionais = 'https://umbanda.jp'; p.hashtags = '#Quimbanda';
    p.imagens = [{ id: 'midia-1', tipo: 'imagem', urlPublica: URL }]; p.imagemUrl = URL;
    return p;
}

function planoVariavel() {
    const midias = Fluxo.prepararMidiasParaAgenda([{ id: 'midia-1', tipo: 'imagem', urlPublica: URL }], [conteudoCompleto()]);
    return PS.planejarPeriodo({ id: 'plano-1', inicio: '2026-10-10', fim: '2026-10-10', timezone: 'Asia/Tokyo', quantidade: 1, diasPermitidos: [6], estrategiaHorario: 'manual', horarios: ['20:00'], permitirReutilizacao: true, variarTexto: true, nivelVariacao: 'Baixa' }, midias, { agoraMs: Date.parse('2026-10-08T00:00:00Z') });
}

test('mídia da biblioteca recebe legenda editorial e final sem perder o template', () => {
    const preparada = Fluxo.prepararMidiasParaAgenda([{ id: 'midia-1', tipo: 'imagem', urlPublica: URL }], [conteudoCompleto()])[0];
    assert.equal(preparada.publicacaoId, 'publicacao-1');
    assert.equal(preparada.legendaEditorial, 'Texto editorial original.');
    assert.match(preparada.legenda, /Informações fixas/);
    assert.match(preparada.legenda, /https:\/\/umbanda\.jp/);
});

test('resposta válida da IA varia só o editorial e preserva template, links e hashtags', async () => {
    const original = planoVariavel();
    const alterado = await Fluxo.aplicarVariacoes(original, { localizarConteudo: () => conteudoCompleto(), gerarTexto: async () => 'Novo convite editorial.' });
    assert.equal(original.itens[0].legendaEditorial, 'Texto editorial original.', 'plano original não é mutado');
    assert.equal(alterado.itens[0].legendaEditorial, 'Novo convite editorial.');
    assert.match(alterado.itens[0].legenda, /Informações fixas/);
    assert.match(alterado.itens[0].legenda, /https:\/\/quimbanda\.jp/);
    assert.match(alterado.itens[0].legenda, /https:\/\/umbanda\.jp/);
    assert.match(alterado.itens[0].legenda, /#Quimbanda/);
});

test('resposta vazia, erro e timeout da IA preservam integralmente o plano original', async () => {
    for (const gerarTexto of [async () => '   ', async () => { throw new Error('Falha segura'); }, async () => { throw Object.assign(new Error('Tempo esgotado'), { codigo: 'ASTRA_TIMEOUT' }); }]) {
        const plano = planoVariavel(); const antes = structuredClone(plano);
        await assert.rejects(() => Fluxo.aplicarVariacoes(plano, { localizarConteudo: () => conteudoCompleto(), gerarTexto }));
        assert.deepEqual(plano, antes);
    }
});

test('sincronização só confirma com resposta do backend e retry mantém o mesmo plano', async () => {
    const plano = planoVariavel(); plano.itens.forEach(item => { item.variarTexto = false; });
    let chamadas = 0; const ids = new Set();
    const enviar = async aprovado => { chamadas += 1; ids.add(aprovado.id); if (chamadas === 1) throw Object.assign(new Error('Servidor offline'), { codigo: 'OFFLINE' }); return { success: true, planos: [aprovado] }; };
    let recuperavel;
    await assert.rejects(() => Fluxo.sincronizarPlano(plano, { aprovar: PS.aprovar, enviar }), erro => { recuperavel = erro.planoRecuperavel; return erro.codigo === 'OFFLINE'; });
    assert.equal(recuperavel.status, 'rascunho'); assert.equal(recuperavel.sincronizacao.estado, 'falhou');
    const confirmado = await Fluxo.sincronizarPlano(recuperavel, { aprovar: PS.aprovar, enviar });
    assert.equal(confirmado.status, 'aprovado'); assert.equal(confirmado.sincronizacao.estado, 'confirmado_servidor');
    assert.equal(chamadas, 2); assert.equal(ids.size, 1, 'retry é idempotente pelo ID do plano');
});

test('primeira tentativa, falha, retry e publicação concluída respeitam idempotência', () => {
    const p = conteudoCompleto(); p.estado = 'confirmado';
    const primeira = Publicacoes.iniciarTentativa(p, 'tentativa-00000001', '2026-10-08T00:00:00Z');
    assert.ok(primeira); assert.equal(Publicacoes.iniciarTentativa(p, 'tentativa-00000002'), null, 'clique duplo bloqueado');
    Publicacoes.registrarPublicacao(p, { erro: 'Falha segura' });
    assert.equal(Publicacoes.podeIniciarPublicacao(p), true, 'erro permite nova tentativa explícita');
    assert.ok(Publicacoes.iniciarTentativa(p, 'tentativa-00000002', '2026-10-08T00:01:00Z'));
    Publicacoes.registrarPublicacao(p, { mediaId: 'meta-1' });
    assert.equal(Publicacoes.podeIniciarPublicacao(p), false); assert.equal(p.tentativasPublicacao.length, 2);
});

test('miniatura usa thumbnail e oferece fallback seguro para vídeo e carrossel', () => {
    const reel = normalizarMidia({ id: 'r1', media_type: 'VIDEO', thumbnail_url: 'https://cdn.site.jp/thumb.jpg', media_url: 'https://cdn.site.jp/video.mp4' });
    assert.deepEqual(reel.miniaturas, ['https://cdn.site.jp/thumb.jpg', 'https://cdn.site.jp/video.mp4']);
    const carrossel = normalizarMidia({ id: 'c1', media_type: 'CAROUSEL_ALBUM', children: { data: [{ media_type: 'IMAGE', media_url: 'https://cdn.site.jp/filho.jpg' }] }, media_url: 'https://cdn.site.jp/pai.jpg' });
    assert.equal(carrossel.miniatura, 'https://cdn.site.jp/filho.jpg');
});

test('frontend mantém um único handler de salvar e mostra as duas decisões explícitas', () => {
    const painel = fs.readFileSync('./painel-meta-prototipo/painel.js', 'utf8');
    const html = fs.readFileSync('./painel-meta-prototipo/index.html', 'utf8');
    assert.equal((painel.match(/\$\('salvar'\)\.onclick/g) || []).length, 1);
    assert.match(painel, /salvarEAvancar/);
    assert.match(html, /id="publicar-agora-revisao"[\s\S]*Publicar agora/);
    assert.match(html, /id="ir-agendamento"[\s\S]*Salvar e ir para agendamento/);
});

test('salvar persiste e avança por todo o fluxo editorial', () => {
    const etapas = ['midia', 'informacoes', 'ia', 'revisao'];
    const p = conteudoCompleto();
    p.ideias = 'Tema de teste';
    p.revisoes = ['Tema de teste'];
    p.estado = 'confirmado';

    let etapaAtual = 'midia';
    const visitadas = [etapaAtual];

    while (etapaAtual && etapaAtual !== 'agendamento') {
        const erros = Publicacoes.validarEtapa(etapaAtual, p, {
            midiaPublicaPronta: true,
            errosDeConteudo: []
        });
        assert.equal(erros.length, 0, `Etapa ${etapaAtual} deve estar válida`);
        etapaAtual = Publicacoes.proximaEtapa(etapaAtual);
        if (etapaAtual) visitadas.push(etapaAtual);
    }

    assert.deepEqual(visitadas, ['midia', 'informacoes', 'ia', 'revisao', 'agendamento']);
});

test('dados completos da publicação permanecem intactos entre transições de abas', () => {
    const original = conteudoCompleto();
    original.ideias = 'Ideia do post';
    original.revisoes = ['Ideia do post'];
    original.site = 'https://quimbanda.jp';
    original.maps = 'https://maps.google.com/?q=quimbanda.jp';
    original.chamadasFixas = 'Visite-nos';

    // Simula migração/clonagem como o IndexedDB e sincronizações fazem
    const clonado = Publicacoes.migrarPublicacao(structuredClone(original));

    assert.equal(clonado.id, original.id);
    assert.equal(clonado.imagemUrl, original.imagemUrl);
    assert.equal(clonado.imagens[0].urlPublica, original.imagens[0].urlPublica);
    assert.equal(clonado.legenda, original.legenda);
    assert.equal(clonado.templateTexto, original.templateTexto);
    assert.equal(clonado.site, original.site);
    assert.equal(clonado.maps, original.maps);
    assert.equal(clonado.linksAdicionais, original.linksAdicionais);
    assert.equal(clonado.hashtags, original.hashtags);
    assert.equal(clonado.ideias, original.ideias);
    assert.deepEqual(clonado.revisoes, original.revisoes);
});

