'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const R = require('./regras');
const Publicacoes = require('./publicacoes');
const PS = require('./planejamento-semanal');
const IR = require('./integracao-regras');
const { criarServidor } = require('./servidor');

/** Prepara um conteúdo completo e determinístico. */
function exemplo() {
    const p = R.criarConteudo();
    p.imagens = [{ id: 'm1', nome: 'teste.png', urlPublica: 'https://midia.dominio-publico.com/teste.png', tipo: 'imagem' }];
    p.tipoMidia = 'imagem'; p.imagemUrl = p.imagens[0].urlPublica;
    p.hashtags = '#Marca #Ação'; p.palavras = 'arte'; p.ideias = 'Convidar';
    p.legenda = 'Venha conhecer a arte. #Marca #Marca';
    p.revisoes = ['Convidar'];
    return p;
}

test('compõe hashtags exatas sem duplicações', () => {
    const p = exemplo();
    const final = R.compor(p);
    assert.equal(R.hashtags(final).filter(tag => tag === '#Marca').length, 1);
    assert.ok(final.includes('#Ação'));
    assert.ok(R.validar(p).every(item => item.ok));
});

test('dicas de tema não bloqueiam por ausência literal', () => {
    const p = exemplo(); p.legenda = 'artesanato Arte'; p.palavras = 'Mie\nArte';
    assert.ok(R.validar(p).every(item => item.ok));
});

test('legenda vazia, hashtag inválida e sem mídia bloqueiam', () => {
    const p = exemplo(); p.hashtags = '#correta inválida'; p.legenda = ''; p.imagens = [];
    assert.ok(R.validar(p).filter(item => !item.ok).length >= 3);
});

test('ideias exigem revisão humana', () => {
    const p = exemplo(); p.revisoes = [];
    assert.ok(R.validar(p).some(item => !item.ok && item.texto.includes('Revisão humana')));
});

test('metadados separados e URLs perigosas recusadas', () => {
    const p = exemplo(); p.local = 'Local informado'; p.site1 = 'https://example.com'; p.incluir.local = true;
    assert.ok(R.compor(p).includes(p.local));
    assert.ok(R.compor(p).includes(p.site1));
    p.site1 = 'javascript:alert(1)'; assert.ok(R.validar(p).some(item => !item.ok && item.texto.includes('site1')));
});

test('todos os links preenchidos entram na legenda sem depender de flags ocultas', () => {
    const p = exemplo();
    Object.assign(p, { site: 'https://site.example/a', maps: 'https://maps.example/b', site1: 'https://site.example/c', site2: 'https://site.example/d', linksAdicionais: 'https://site.example/e\nhttps://site.example/f' });
    p.incluir = { site: false, maps: false, site1: false, site2: false };
    const legenda = R.compor(p);
    for (const link of [p.site, p.maps, p.site1, p.site2, ...p.linksAdicionais.split('\n')]) assert.ok(legenda.includes(link), `${link} deve constar na legenda`);
});

test('converte fusos e recusa datas inválidas ou transições ambíguas', () => {
    assert.deepEqual(R.instantes('2099-01-10', '18:00', 'Asia/Tokyo'), [Date.parse('2099-01-10T09:00:00Z')]);
    assert.deepEqual(R.instantes('2026-02-30', '10:00', 'UTC'), []);
    assert.equal(R.instantes('2026-11-01', '01:30', 'America/New_York').length, 2);
});

test('migração é idempotente e preserva conteúdo', () => {
    const p = R.criarConteudo(); p.legenda = 'Original';
    const antes = structuredClone(p); Publicacoes.migrarPublicacao(p); const primeira = structuredClone(p); Publicacoes.migrarPublicacao(p);
    assert.deepEqual(p, primeira);
    assert.equal(p.legenda, antes.legenda);
    assert.equal(p.fuso, 'Asia/Tokyo');
});

test('aprovacão semanal assina e edição exige nova aprovação', () => {
    const plano = PS.aprovar(PS.planejar({ id: 'p1', semente: 's', inicio: '2026-09-28', fim: '2026-09-28', dias: [1], horarios: ['10:00'], porDia: 1, timezone: 'Asia/Tokyo', modo: 'manual' }, [{ id: 'a', tipo: 'video', status: 'disponível', urlPublica: 'https://midia.dominio-publico.com/a.mp4' }]));
    assert.equal(plano.status, 'aprovado');
    assert.ok(plano.itens[0].approvalSignature);
    const editado = PS.editarItem(plano, plano.itens[0].id, { hora: '11:00' });
    assert.equal(editado.itens[0].approvalSignature, null);
});

test('URL pública recusa rede privada e aceita HTTPS público', () => {
    for (const url of ['http://midia.dominio-publico.com/x.jpg', 'https://127.0.0.1/x.jpg', 'https://10.0.0.1/x.jpg', 'C:\\x.jpg', 'https://example.com/x.jpg']) assert.equal(IR.urlPublica(url), false, url);
    assert.equal(IR.urlPublica('https://midia.dominio-publico.com/x.jpg'), true);
});

test('servidor estático entrega o painel e bloqueia credenciais', async () => {
    const servidor = criarServidor(); await new Promise(resolve => servidor.listen(0, '127.0.0.1', resolve));
    try {
        const base = `http://127.0.0.1:${servidor.address().port}`;
        const resposta = await fetch(base); assert.equal(resposta.status, 200); assert.match(await resposta.text(), /view-agendamentos/);
        for (const rota of ['/.env', '/server.js', '/../.env', '/__proto__', '/constructor']) assert.equal((await fetch(base + rota)).status, 404, rota);
        assert.equal((await fetch(base, { method: 'POST' })).status, 404);
    } finally { await new Promise(resolve => servidor.close(resolve)); }
});
