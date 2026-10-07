'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const raiz = path.resolve(__dirname, '..', 'painel-meta-prototipo');
const arquivos = ['regras.js', 'empresa.js', 'publicacoes.js', 'planejamento-semanal.js', 'diagnostico.js', 'integracao-regras.js', 'painel.js', 'agendamentos.js'];

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
    for (const arquivo of ['painel.js', 'agendamentos.js', 'diagnostico.js']) {
        const js = fs.readFileSync(path.join(raiz, arquivo), 'utf8');
        const usados = [...js.matchAll(/\$\('([^']+)'\)|getElementById\('([^']+)'\)/g)].map(m => m[1] || m[2]);
        const faltando = usados.filter(id => !definidos.has(id));
        assert.deepEqual(faltando, [], `${arquivo} referencia ids ausentes`);
    }
});
