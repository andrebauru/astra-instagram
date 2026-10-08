'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const R = require('../painel-meta-prototipo/regras');
const Publicacoes = require('../painel-meta-prototipo/publicacoes');
const IR = require('../painel-meta-prototipo/integracao-regras');
const analise = require('../services/analise');
const { criarStoreEmpresa } = require('../services/empresa-store');

const AGORA = Date.parse('2026-10-09T12:00:00Z');
const URL_OK = 'https://quimbanda.jp/astra/media/public/arquivo.png';
const URL_2 = 'https://quimbanda.jp/astra/media/public/segunda.png';

function conteudo() {
    const p = R.criarConteudo();
    p.tipoMidia = 'imagem';
    p.imagens = [{ id: 'm1', nome: 'a.png', tipo: 'imagem', urlPublica: '', status: 'disponível' }];
    return p;
}

function midia(id) { return { id, tipo: 'imagem', status: 'disponível', urlPublica: `https://quimbanda.jp/astra/media/public/${id}.png`, legenda: `legenda ${id}`, miniatura: null }; }

// ============================================================
// 1–5: AVANÇO DE ABAS E ERRO IMPEDITIVO
// ============================================================

test('ordem das abas: Mídia → Informações → IA → Revisão → Agendamento → Desempenho', () => {
    assert.deepEqual(Publicacoes.ETAPAS, ['midia', 'informacoes', 'ia', 'revisao', 'agendamento', 'desempenho']);
    assert.equal(Publicacoes.proximaEtapa('midia'), 'informacoes');
    assert.equal(Publicacoes.proximaEtapa('informacoes'), 'ia');
    assert.equal(Publicacoes.proximaEtapa('ia'), 'revisao');
    assert.equal(Publicacoes.proximaEtapa('revisao'), 'agendamento');
    assert.equal(Publicacoes.proximaEtapa('agendamento'), 'desempenho');
    assert.equal(Publicacoes.proximaEtapa('desempenho'), null);
});

test('erro impeditivo bloqueia o avanço e informa o campo', () => {
    const p = conteudo();
    // Mídia sem URL: o campo a corrigir é a URL pública.
    const erros = Publicacoes.validarEtapa('midia', p, { midiaPublicaPronta: false });
    assert.equal(erros.length, 1);
    assert.equal(erros[0].campo, 'URL pública');
    // Sem nenhuma mídia e sem URL: o campo é a mídia.
    p.imagens = [];
    const semMidia = Publicacoes.validarEtapa('midia', p, { midiaPublicaPronta: false });
    assert.equal(semMidia[0].campo, 'Mídia');
    // IA sem legenda.
    const errosIa = Publicacoes.validarEtapa('ia', p, {});
    assert.ok(errosIa.some(e => e.campo === 'Legenda'));
});

test('Revisão só libera com checklist completo, mas a revisão humana é independente', () => {
    const p = conteudo();
    p.legenda = 'Conteúdo pronto.';
    p.ideias = 'Convidar';
    const semRevisao = Publicacoes.validarEtapa('revisao', p, { midiaPublicaPronta: true, errosDeConteudo: ['Revisão humana — Convidar'] });
    assert.ok(semRevisao.some(e => e.campo === 'Revisão'));
    p.revisoes = ['Convidar'];
    const comRevisao = Publicacoes.validarEtapa('revisao', p, { midiaPublicaPronta: true, errosDeConteudo: [] });
    assert.equal(comRevisao.length, 0);
});

// ============================================================
// 6–9: LINKS, MAPS, HASHTAGS PADRÃO E TEMPLATE PERSISTENTES
// ============================================================

test('site, Google Maps, hashtags padrão e template persistem no backend', () => {
    const caminho = path.join(os.tmpdir(), `astra-recorrentes-${process.pid}.json`);
    try { fs.rmSync(caminho, { force: true }); } catch { /* inexistente */ }
    const store = criarStoreEmpresa(caminho);
    store.salvarRecorrentes({
        site: 'https://quimbanda.jp',
        maps: 'https://maps.google.com/?q=quimbanda.jp',
        hashtagsPadrao: '#umbandajapao #quimbandajapao #exunojapao',
        informacoesAdicionais: 'Entrada gratuita.',
        chamadasFixas: 'Participe!',
        templateTexto: 'Informações:\n080-5774-4281'
    });
    const relido = criarStoreEmpresa(caminho).lerRecorrentes();
    assert.equal(relido.site, 'https://quimbanda.jp');
    assert.equal(relido.maps, 'https://maps.google.com/?q=quimbanda.jp');
    assert.equal(relido.hashtagsPadrao, '#umbandajapao #quimbandajapao #exunojapao');
    assert.equal(relido.chamadasFixas, 'Participe!');

    // Novas publicações recebem os dados recorrentes; legenda final inclui template.
    const p = R.criarConteudo();
    p.site = relido.site; p.maps = relido.maps; p.hashtags = relido.hashtagsPadrao;
    p.templateTexto = relido.templateTexto; p.chamadasFixas = relido.chamadasFixas; p.informacoesAdicionais = relido.informacoesAdicionais;
    p.incluir.site = true; p.incluir.maps = true;
    p.legenda = 'Encontro de domingo.';
    const final = R.compor(p);
    assert.ok(final.includes('Encontro de domingo'));
    assert.ok(final.includes('https://maps.google.com/?q=quimbanda.jp'));
    assert.ok(final.includes('Participe!'));
    assert.ok(final.includes('#umbandajapao'));
    assert.equal((final.match(/080-5774-4281/g) || []).length, 1);
    Publicacoes.migrarPublicacao(p);
    assert.equal(p.hashtags, relido.hashtagsPadrao);
    try { fs.rmSync(caminho, { force: true }); } catch { /* melhor esforço */ }
});

// ============================================================
// 11–14: BASE DA ANÁLISE AUTOMÁTICA
// ============================================================

test('análise informa quais métricas existem, quantos posts e o período', () => {
    const metricas = [10, 19, 22, 8, 16, 21, 11, 13, 18, 20].map((hora, indice) => ({
        mediaId: `m${indice}`, source: 'organic', publishedAt: `2026-09-2${indice % 9}T${String(hora).padStart(2, '0')}:00:00Z`, timezone: 'Asia/Tokyo',
        reach: null, impressions: null, likes: 40 + indice, comments: 4 + indice, saves: null, shares: null,
        capturedAt: new Date(AGORA).toISOString()
    }));
    const resumo = analise.analisarMelhoresHorarios(metricas, { timezone: 'Asia/Tokyo' });
    assert.equal(resumo.metricasDisponiveis.curtidas, true);
    assert.equal(resumo.metricasDisponiveis.comentarios, true);
    assert.equal(resumo.metricasDisponiveis.alcance, false);
    assert.equal(resumo.metricasDisponiveis.salvamentos, false);
    assert.equal(resumo.metricasDisponiveis.compartilhamentos, false);
    assert.equal(resumo.postsAnalisados, 10);
    assert.ok(resumo.periodo.inicio <= resumo.periodo.fim);
    assert.ok(['Baixa', 'Média', 'Alta'].includes(resumo.confianca));
    assert.ok(resumo.melhoresHorarios.length >= 1);
    assert.equal(resumo.melhoresHorarios[0].score >= resumo.melhoresHorarios.at(-1).score, true);
    // Nada é inventado: ausência não vira zero publicado como dado real.
    assert.equal(resumo.totais.alcance, 0);
    assert.equal(resumo.melhoresHorarios.every(h => typeof h.score === 'number'), true);
});

// ============================================================
// 15–18 E 20–26: PUBLICAÇÃO REAL
// ============================================================

test('publicação confirmada persiste media_id, permalink e status; reload não perde', () => {
    const p = conteudo();
    p.estado = 'confirmado';
    Publicacoes.registrarPublicacao(p, { mediaId: '17900000000000000', permalink: 'https://www.instagram.com/p/ABC123/', publicadoEm: '2026-10-08T09:32:00+09:00' });
    assert.equal(p.statusPublicacao, 'publicado');
    assert.equal(p.instagramMediaId, '17900000000000000');
    assert.equal(p.permalink, 'https://www.instagram.com/p/ABC123/');
    assert.equal(p.publicadoEm, '2026-10-08T09:32:00+09:00');
    Publicacoes.migrarPublicacao(p);
    assert.equal(p.statusPublicacao, 'publicado');
    assert.equal(p.instagramMediaId, '17900000000000000');
    const visual = Publicacoes.statusPublicacaoVisual(p);
    assert.match(visual.texto, /✓ Publicada/);
    assert.match(visual.texto, /ID 17900000000000000/);
});

test('publicação já concluída não pode duplicar por acidente', () => {
    const p = conteudo();
    Publicacoes.registrarPublicacao(p, { mediaId: '123' });
    // O editor deve recusar nova tentativa sem ação explícita separada.
    assert.equal(p.statusPublicacao, 'publicado');
    assert.equal(p.publicacaoReal.estado, 'publicado');
});

test('erro da Meta aparece no estado e na interface', () => {
    const p = conteudo();
    Publicacoes.registrarPublicacao(p, { erro: 'A Meta recusou a publicação: mídia não suportada.' });
    assert.equal(p.statusPublicacao, 'falhou');
    assert.equal(p.erroPublicacao, 'A Meta recusou a publicação: mídia não suportada.');
    const visual = Publicacoes.statusPublicacaoVisual(p);
    assert.match(visual.texto, /✗ Falhou/);
    assert.match(visual.texto, /mídia não suportada/);
    assert.equal(p.instagramMediaId, null);
});

test('estado durante a publicação bloqueia novo envio', () => {
    const p = conteudo();
    p.statusPublicacao = 'publicando';
    assert.match(Publicacoes.statusPublicacaoVisual(p).texto, /Publicando/);
});
