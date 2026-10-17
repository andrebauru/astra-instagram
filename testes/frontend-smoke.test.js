'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const raiz = path.resolve(__dirname, '..', 'painel-meta-prototipo');
const arquivos = ['regras.js', 'empresa.js', 'publicacoes.js', 'planejamento-semanal.js', 'diagnostico.js', 'integracao-regras.js', 'fluxo-editorial.js', 'logs.js', 'meta-conexao.js', 'painel.js', 'agendamentos.js'];

/** Simula janela e relógio; nunca abre Facebook ou usa credenciais reais. */
async function prepararPopupMeta({ bloqueado = false, configurado = true, falha = false } = {}) {
    const elementos = new Map(), eventos = [];
    const el = id => {
        if (!elementos.has(id)) elementos.set(id, { value: '', textContent: '', disabled: false, replaceChildren() {}, append() {} });
        return elementos.get(id);
    };
    let tick, instante = 0, atualizacoes = 0;
    const popup = { closed: false, opener: {}, location: { href: 'about:blank', replace(url) { this.href = url; } }, close() { this.closed = true; } };
    const contexto = { URL, URLSearchParams, Date: { now: () => instante },
        Option: function (texto, valor) { this.text = texto; this.value = valor; },
        location: { origin: 'http://localhost:8080', search: '', pathname: '/painel/' },
        document: { getElementById: el, querySelector: () => null },
        setInterval(fn) { tick = fn; return 1; }, clearInterval() { tick = null; },
        open() { eventos.push('abrir'); return bloqueado ? null : popup; }
    };
    contexto.window = contexto;
    vm.createContext(contexto);
    vm.runInContext(fs.readFileSync(path.join(raiz, 'meta-conexao.js'), 'utf8'), contexto);
    contexto.MetaConexao.iniciar({ aoAtualizar: () => { atualizacoes++; }, cliente: async rota => {
        eventos.push(rota);
        if (rota === '/meta/oauth/iniciar') {
            if (falha) throw new Error('Falha segura de configuração');
            return { url: 'https://www.facebook.com/v25.0/dialog/oauth?redirect_uri=http%3A%2F%2Flocalhost%3A8080%2Fmeta%2Foauth%2Fretorno' };
        }
        return { conexao: { configurado, estado: 'desconectado', mensagem: 'Teste', paginas: [], pendenciasConfiguracao: ['App Secret da Meta'] } };
    } });
    await contexto.MetaConexao.carregar();
    return { el, popup, eventos, tick: () => tick?.(), avancar: () => { instante = 600001; }, atualizacoes: () => atualizacoes };
}

test('popup abre no clique antes da requisição, isola opener e atualiza painel no retorno', async () => {
    const p = await prepararPopupMeta();
    const fim = p.el('meta-conectar').onclick();
    assert.ok(p.eventos.indexOf('abrir') < p.eventos.indexOf('/meta/oauth/iniciar'));
    assert.equal(p.popup.opener, null);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(p.el('meta-conectar').disabled, true);
    p.popup.location.href = 'http://localhost:8080/painel/?meta=conectado';
    p.tick(); await fim;
    assert.equal(p.popup.closed, true);
    assert.equal(p.atualizacoes(), 1);
    assert.equal(p.el('meta-conectar').disabled, false);
});

test('popup bloqueado não inicia OAuth e informa como tentar novamente', async () => {
    const p = await prepararPopupMeta({ bloqueado: true });
    await p.el('meta-conectar').onclick();
    assert.ok(!p.eventos.includes('/meta/oauth/iniciar'));
    assert.match(p.el('meta-estado').textContent, /Permita popups/);
});

test('fechamento ou timeout do popup encerra espera sem declarar login bem-sucedido', async () => {
    for (const expirar of [false, true]) {
        const p = await prepararPopupMeta();
        const fim = p.el('meta-conectar').onclick(); await new Promise(resolve => setImmediate(resolve));
        if (expirar) p.avancar(); else p.popup.closed = true;
        p.tick(); await fim;
        assert.match(p.el('meta-estado').textContent, expirar ? /prazo/ : /Janela fechada/);
        assert.equal(p.el('meta-conectar').disabled, false);
    }
});

test('erro ao iniciar fecha popup vazio e configuração incompleta explica bloqueio', async () => {
    const p = await prepararPopupMeta({ falha: true });
    await p.el('meta-conectar').onclick();
    assert.equal(p.popup.closed, true);
    assert.match(p.el('meta-estado').textContent, /Falha segura/);
    const incompleto = await prepararPopupMeta({ configurado: false });
    assert.equal(incompleto.el('meta-conectar').disabled, true);
    assert.match(incompleto.el('meta-configuracao-pendente').textContent, /App Secret da Meta/);
    await incompleto.el('meta-conectar').onclick();
    assert.ok(!incompleto.eventos.includes('abrir'));
});

test('cada campo de integração oferece atalho oficial em nova aba sem credenciais', () => {
    const html = fs.readFileSync(path.join(raiz, 'index.html'), 'utf8');
    const formulario = html.match(/<form id="form-integracoes">([\s\S]*?)<\/form>/)[1];
    const campos = [...formulario.matchAll(/<input id="config-([^"]+)"[^>]*><\/label>\s*<p class="nota"><a href="([^"]+)" target="_blank" rel="noopener noreferrer">/g)];
    assert.equal(campos.length, 11);
    for (const [, , href] of campos) {
        const url = new URL(href);
        assert.equal(url.protocol, 'https:');
        assert.ok(['developers.facebook.com', 'business.facebook.com', 'openrouter.ai'].includes(url.hostname));
        assert.equal(url.search, '');
    }
    for (const campo of ['INSTAGRAM_ACCESS_TOKEN', 'FACEBOOK_PAGE_ACCESS_TOKEN', 'OPENROUTER_API_KEY']) assert.match(formulario, new RegExp(`id="config-${campo}" type="password"`));
});

/** Cria um contexto com DOM mínimo (readyState=loading) para avaliar os scripts. */
function criarContexto(registrados) {
    const contexto = {
        console, crypto: globalThis.crypto,
        URL, URLSearchParams, Intl, Date, JSON, Math, Object, Array, Promise, Number, String, Boolean, Set, Map, Error, RegExp, structuredClone,
        setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
        fetch: async () => new Response('{}'),
        location: { pathname: '/painel/', origin: 'http://127.0.0.1:8080' },
        navigator: { userAgent: 'smoke' },
        document: {
            readyState: 'loading',
            addEventListener: (evento, fn) => { if (evento === 'DOMContentLoaded') registrados.push('DOMContentLoaded'); },
            createElement: () => ({ style: {}, classList: { add() {} }, setAttribute() {}, append() {}, addEventListener() {}, dataset: {} }),
            createTreeWalker: () => ({ nextNode: () => false }),
            querySelectorAll: () => [],
            querySelector: () => null,
            getElementById: () => null,
            get documentElement() { return { dataset: {} }; },
            set title(v) { this._t = v; }
        },
        MutationObserver: class { observe() {} },
        Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
        Image: class { decode() { return Promise.resolve(); } },
        indexedDB: { open: () => ({}) }
    };
    contexto.window = contexto; contexto.self = contexto; contexto.globalThis = contexto;
    vm.createContext(contexto);
    return contexto;
}

test('scripts do painel avaliam sem colisões globais e registram os globais esperados', () => {
    const registrados = [];
    const contexto = criarContexto(registrados);
    for (const arquivo of arquivos) {
        const codigo = fs.readFileSync(path.join(raiz, arquivo), 'utf8');
        assert.doesNotThrow(() => vm.runInContext(codigo, contexto, { filename: arquivo }), `avaliar ${arquivo}`);
    }
    for (const nome of ['Regras', 'Empresa', 'Publicacoes', 'PlanejamentoSemanal', 'IntegracaoRegras', 'Agendamentos']) assert.ok(contexto[nome], `global ${nome}`);
    assert.equal(typeof contexto.window.registrarDiagnostico, 'function');
    assert.equal(typeof contexto.window.iniciarDiagnostico, 'function');
    assert.ok(registrados.includes('DOMContentLoaded'));
});

test('todo id de DOM referenciado existe no index.html', () => {
    const html = fs.readFileSync(path.join(raiz, 'index.html'), 'utf8');
    const definidos = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
    for (const arquivo of ['painel.js', 'agendamentos.js', 'diagnostico.js', 'logs.js']) {
        const js = fs.readFileSync(path.join(raiz, arquivo), 'utf8');
        const usados = [...js.matchAll(/\$\('([^']+)'\)|getElementById\('([^']+)'\)/g)].map(m => m[1] || m[2]);
        const faltando = usados.filter(id => !definidos.has(id));
        assert.deepEqual(faltando, [], `${arquivo} referencia ids ausentes`);
    }
});

test('frontend aceita MP4 com MIME vazio ou genérico e recusa tamanho excessivo', async () => {
    const contexto = criarContexto([]);
    contexto.FileReader = class {
        readAsDataURL(arquivo) { this.result = `data:${arquivo.type || 'application/octet-stream'};base64,AAAA`; this.onload(); }
    };
    contexto.document.createElement = () => ({ duration: 12, set src(valor) { this.onloadedmetadata(); } });
    for (const arquivo of arquivos) vm.runInContext(fs.readFileSync(path.join(raiz, arquivo), 'utf8'), contexto);
    for (const type of ['', 'application/octet-stream', 'video/mp4']) {
        const midia = await contexto.lerArquivo({ name: 'video.MP4', type, size: 256 * 1024 * 1024 });
        assert.equal(midia.mime, 'video/mp4');
        assert.equal(midia.tipo, 'video');
        assert.match(midia.dados, /^data:video\/mp4;base64,/);
    }
    await assert.rejects(contexto.lerArquivo({ name: 'video.mp4', type: 'video/mp4', size: 256 * 1024 * 1024 + 1 }), /256 MB/);
    await assert.rejects(contexto.lerArquivo({ name: 'video.mov', type: 'video/quicktime', size: 100 }), /MP4|mp4/);
});

test('análise MP4 produz seis quadros JPEG ordenados e libera o vídeo', async () => {
    const contexto = criarContexto([]);
    const eventos = new Map(), tempos = [], quadros = [];
    let liberado = false;
    const video = {
        duration: 12, videoWidth: 1920, videoHeight: 1080,
        addEventListener(nome, fn) { eventos.set(nome, fn); },
        removeEventListener(nome) { eventos.delete(nome); },
        set src(valor) { eventos.get('loadeddata')(); },
        set currentTime(valor) { tempos.push(valor); eventos.get('seeked')(); },
        pause() {}, removeAttribute() { liberado = true; }, load() {}
    };
    const jpeg = 'data:image/jpeg;base64,/9j/';
    contexto.document.createElement = tipo => tipo === 'video' ? video : {
        getContext() { return { fillRect() {}, fillText() {}, drawImage(...args) { quadros.push(args); } }; },
        toDataURL(tipo) { assert.equal(tipo, 'image/jpeg'); return jpeg; }
    };
    for (const arquivo of arquivos) vm.runInContext(fs.readFileSync(path.join(raiz, arquivo), 'utf8'), contexto);
    const entrada = await contexto.prepararMidiaParaVisao({ tipoMidia: 'reel', imagens: [{ tipo: 'video', dados: 'data:video/mp4;base64,AAAA' }] });
    assert.equal(entrada.imagem, jpeg);
    assert.deepEqual(tempos, [1, 3, 5, 7, 9, 11]);
    assert.equal(quadros.length, 6);
    assert.match(entrada.contexto, /áudio não foi fornecido/);
    assert.equal(liberado, true);
    assert.equal(eventos.size, 0);
    assert.equal(require('../astra-visao').validarImagem(entrada.imagem), jpeg);
    assert.throws(() => require('../astra-visao').validarImagem('data:video/mp4;base64,AAAA'), erro => erro.code === 'VIDEO_REQUER_QUADROS' || erro.codigo === 'VIDEO_REQUER_QUADROS');
    video.duration = Infinity;
    await assert.rejects(contexto.prepararMidiaParaVisao({ tipoMidia: 'reel', imagens: [], videoUrl: 'https://exemplo.com/video.mp4' }), /duração/);
});
