'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const raiz = path.resolve(__dirname, '..', 'painel-meta-prototipo');
const IR = require('../painel-meta-prototipo/integracao-regras');
const R = require('../painel-meta-prototipo/regras');

/** Publicação válida com mídia pública e conteúdo confirmado. */
function publicacao(extra = {}) {
    const p = R.criarConteudo();
    p.tipoMidia = 'imagem';
    p.legenda = 'Conteúdo pronto';
    p.imagemUrl = 'https://cdn.dominio-publico.com/a.png';
    p.imagens = [{ id: 'm1', nome: 'a.png', tipo: 'imagem', urlPublica: 'https://cdn.dominio-publico.com/a.png' }];
    p.estado = 'confirmado';
    p.publicarInstagram = false;
    p.publicarFacebook = false;
    p.publicarStory = false;
    p.publicarFacebookStory = false;
    return Object.assign(p, extra);
}

const contextoBase = { servidorOnline: true, instagramVerificado: true, facebookVerificado: true, contaInstagram: 'BUSINESS', enviando: false };

test('destinos são independentes: Feed e Story de cada rede', () => {
    assert.deepEqual(IR.destinosPublicacao({ publicarInstagram: false, publicarFacebook: true, publicarStory: true, publicarFacebookStory: true }),
        { instagram: false, facebook: true, instagramStory: true, facebookStory: true });
    assert.deepEqual(IR.destinosPublicacao({}),
        { instagram: true, facebook: false, instagramStory: false, facebookStory: false });
});

test('Story do Facebook exige Página verificada e não depende do Instagram', () => {
    const soFacebookStory = publicacao({ publicarFacebookStory: true });
    const semFacebook = IR.avaliarPublicacaoImediata(soFacebookStory, R, { ...contextoBase, facebookVerificado: false });
    assert.equal(semFacebook.podePublicar, false);
    assert.ok(semFacebook.motivos.includes('Página Facebook verificada'));
    assert.ok(!semFacebook.motivos.includes('Instagram verificado'), 'não exige Instagram quando só o Story do Facebook é escolhido');

    const comFacebook = IR.avaliarPublicacaoImediata(soFacebookStory, R, contextoBase);
    assert.equal(comFacebook.podePublicar, true);
});

test('Story do Instagram exige conta Business', () => {
    const soInstagramStory = publicacao({ publicarStory: true });
    const negativo = IR.avaliarPublicacaoImediata(soInstagramStory, R, { ...contextoBase, contaInstagram: 'PERSONAL' });
    assert.equal(negativo.podePublicar, false);
    assert.ok(negativo.motivos.includes('Story Instagram requer conta Business verificada'));
    assert.equal(IR.avaliarPublicacaoImediata(soInstagramStory, R, contextoBase).podePublicar, true);
});

test('Feed do Instagram exige Instagram verificado; Feed do Facebook exige Página', () => {
    const feedIg = publicacao({ publicarInstagram: true });
    assert.equal(IR.avaliarPublicacaoImediata(feedIg, R, { ...contextoBase, instagramVerificado: false }).podePublicar, false);
    const feedFb = publicacao({ publicarFacebook: true });
    assert.equal(IR.avaliarPublicacaoImediata(feedFb, R, { ...contextoBase, facebookVerificado: false }).podePublicar, false);
    assert.equal(IR.avaliarPublicacaoImediata(feedFb, R, contextoBase).podePublicar, true);
});

test('carrossel não é convertido em Story', () => {
    const carrossel = publicacao({ tipoMidia: 'carrossel', publicarFacebookStory: true, itens: [] });
    const av = IR.avaliarPublicacaoImediata(carrossel, R, contextoBase);
    assert.equal(av.podePublicar, false);
    assert.ok(av.motivos.some(m => /Story separado indisponível para carrossel/.test(m)));
});

// ============================================================
// Regressão do botão "Publicar agora" (render no DOM simulado)
// ============================================================

const arquivos = ['regras.js', 'empresa.js', 'publicacoes.js', 'planejamento-semanal.js', 'diagnostico.js', 'integracao-regras.js', 'fluxo-editorial.js', 'meta-conexao.js', 'painel.js', 'agendamentos.js'];

function ambiente() {
    const elementos = new Map();
    const stub = id => {
        if (!elementos.has(id)) elementos.set(id, {
            id, value: '', textContent: '', disabled: false, hidden: false, checked: false, dataset: {}, style: {}, children: [],
            classList: { add() {}, remove() {}, toggle() {} },
            replaceChildren(...x) { this.children = x; }, append(...x) { this.children.push(...x); }, appendChild(x) { this.children.push(x); },
            setAttribute() {}, removeAttribute() {}, focus() {}, click() {}, after() {}, before() {}, remove() {},
            querySelectorAll() { return []; }, querySelector() { return null; }, addEventListener() {}, closest() { return null; }
        });
        return elementos.get(id);
    };
    const contexto = {
        console, crypto: globalThis.crypto, URL, URLSearchParams, Intl, Date, JSON, Math, Object, Array, Promise, Number, String, Boolean, Set, Map, Error, RegExp, structuredClone,
        setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
        fetch: async () => new Response('{}'),
        location: { pathname: '/painel/', origin: 'http://127.0.0.1:8080', search: '' },
        navigator: { userAgent: 'teste' },
        document: {
            readyState: 'loading', addEventListener() {},
            createElement: () => stub('novo-' + Math.random()),
            createTextNode: t => ({ nodeType: 3, textContent: t }),
            createTreeWalker: () => ({ nextNode: () => false }),
            querySelectorAll: () => [], querySelector: () => null,
            getElementById: id => stub(id),
            get documentElement() { return { dataset: {} }; }, set title(v) { this._t = v; }
        },
        MutationObserver: class { observe() {} },
        Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
        Image: class { decode() { return Promise.resolve(); } },
        indexedDB: { open: () => ({}) }, confirm: () => false
    };
    contexto.window = contexto; contexto.self = contexto; contexto.globalThis = contexto;
    vm.createContext(contexto);
    for (const arquivo of arquivos) vm.runInContext(fs.readFileSync(path.join(raiz, arquivo), 'utf8'), contexto, { filename: arquivo });
    return { contexto, stub };
}

test('render habilita o botão quando as conexões estão verificadas (sem reload)', () => {
    const { contexto, stub } = ambiente();
    vm.runInContext(`
        servidorOnline = true;
        perfilInstagram = { id: 'ig-1', username: 'conta', account_type: 'BUSINESS' };
        perfilFacebook = { id: '123456', name: 'Pagina' };
        atual.estado = 'confirmado';
        atual.tipoMidia = 'imagem';
        atual.legenda = 'Conteudo pronto';
        atual.imagemUrl = 'https://cdn.dominio-publico.com/a.png';
        atual.imagens = [{ id: 'm1', nome: 'a.png', tipo: 'imagem', urlPublica: 'https://cdn.dominio-publico.com/a.png' }];
        atual.publicarInstagram = true;
        atual.publicarFacebook = true;
        atual.publicarStory = true;
        atual.publicarFacebookStory = true;
        renderizarRevisao();
    `, contexto);
    assert.equal(stub('preparar-publicacao').disabled, false, 'Publicar agora habilitado');
    assert.equal(stub('publicar-agora-revisao').disabled, false, 'Publicar (decisão) habilitado');
    assert.equal(stub('publicar-story').disabled, false, 'Story Instagram habilitado (Business)');
    assert.equal(stub('publicar-facebook-story').disabled, false, 'Story Facebook habilitado (Página verificada)');
    assert.equal(contexto.destinosVerificados(), true);
});

test('render mantém o botão desativado quando o destino exigido não está verificado', () => {
    const { contexto, stub } = ambiente();
    vm.runInContext(`
        servidorOnline = true;
        perfilInstagram = { id: 'ig-1', account_type: 'BUSINESS' };
        perfilFacebook = undefined;
        atual.estado = 'confirmado';
        atual.tipoMidia = 'imagem';
        atual.legenda = 'Conteudo pronto';
        atual.imagemUrl = 'https://cdn.dominio-publico.com/a.png';
        atual.imagens = [{ id: 'm1', nome: 'a.png', tipo: 'imagem', urlPublica: 'https://cdn.dominio-publico.com/a.png' }];
        atual.publicarInstagram = false;
        atual.publicarFacebook = false;
        atual.publicarStory = false;
        atual.publicarFacebookStory = true;
        renderizarRevisao();
    `, contexto);
    assert.equal(stub('preparar-publicacao').disabled, true, 'sem Página verificada, Story Facebook não publica');
    assert.equal(stub('publicar-facebook-story').disabled, true);
    assert.equal(contexto.destinosVerificados(), false);
});

test('atualizarControlesStory não lança quando um elemento está ausente', () => {
    const { contexto } = ambiente();
    // Remove todos os elementos para simular ausência total no DOM.
    contexto.document.getElementById = () => null;
    assert.doesNotThrow(() => contexto.atualizarControlesStory());
});

test('fluxo: revisão habilita Confirmar; confirmação habilita Publicar', () => {
    const { contexto, stub } = ambiente();
    vm.runInContext(`
        servidorOnline = true;
        perfilInstagram = { id: 'ig-1', username: 'conta', account_type: 'BUSINESS' };
        perfilFacebook = undefined;
        atual.tipoMidia = 'imagem';
        atual.legenda = 'Conteudo pronto';
        atual.imagemUrl = 'https://cdn.dominio-publico.com/a.png';
        atual.imagens = [{ id: 'm1', nome: 'a.png', tipo: 'imagem', urlPublica: 'https://cdn.dominio-publico.com/a.png' }];
        atual.ideias = 'Convidar';
        atual.revisoes = [];
        atual.estado = 'rascunho';
        atual.publicarInstagram = true;
        atual.publicarFacebook = false;
        atual.publicarStory = false;
        atual.publicarFacebookStory = false;
        renderizarRevisao();
    `, contexto);
    assert.equal(stub('aprovar').disabled, true, 'Confirmar conteúdo inativo antes da revisão humana');
    assert.equal(stub('preparar-publicacao').disabled, true, 'Publicar agora inativo sem confirmação');

    vm.runInContext(`atual.revisoes = ['Convidar']; renderizarRevisao();`, contexto);
    assert.equal(stub('aprovar').disabled, false, 'Confirmar conteúdo ativo após revisão humana');
    assert.equal(stub('preparar-publicacao').disabled, true, 'Publicar ainda inativo antes de confirmar');

    vm.runInContext(`atual.estado = 'confirmado'; renderizarRevisao();`, contexto);
    assert.equal(stub('preparar-publicacao').disabled, false, 'Publicar ativo após confirmação com Instagram verificado');
});

test('edição após confirmação invalida a publicação', () => {
    const { contexto, stub } = ambiente();
    vm.runInContext(`
        servidorOnline = true;
        perfilInstagram = { id: 'ig-1', account_type: 'BUSINESS' };
        atual.tipoMidia = 'imagem';
        atual.legenda = 'Conteudo pronto';
        atual.imagemUrl = 'https://cdn.dominio-publico.com/a.png';
        atual.imagens = [{ id: 'm1', tipo: 'imagem', urlPublica: 'https://cdn.dominio-publico.com/a.png' }];
        atual.publicarInstagram = true; atual.publicarFacebook = false; atual.publicarStory = false; atual.publicarFacebookStory = false;
        atual.estado = 'confirmado';
        renderizarRevisao();
    `, contexto);
    assert.equal(stub('preparar-publicacao').disabled, false);
    vm.runInContext(`atual.legenda = 'Editado depois'; atual.estado = 'rascunho'; renderizarRevisao();`, contexto);
    assert.equal(stub('preparar-publicacao').disabled, true, 'edição invalida a confirmação anterior');
});
