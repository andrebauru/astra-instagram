'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { criarStoreBibliotecaMidias, reconciliarMidias } = require('../services/biblioteca-midias-store');

test('biblioteca persiste metadados e remove base64 e miniaturas locais', () => {
    const diretorio = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-midias-'));
    const store = criarStoreBibliotecaMidias(path.join(diretorio, 'midias.json'));
    const salvas = store.salvar([{ id: 'm1', nome: 'A', urlPublica: 'https://cdn.example/a.png', dados: 'data:image/png;base64,segredo', miniatura: 'data:image/png;base64,mini' }]);
    assert.equal(salvas[0].dados, undefined);
    assert.equal(salvas[0].miniatura, undefined);
    assert.equal(store.listar()[0].urlPublica, 'https://cdn.example/a.png');
});

test('reconciliação remove duplicatas e preserva nome e metadados locais', () => {
    const url = 'https://quimbanda.jp/astra/media/public/a.png';
    const resultado = reconciliarMidias(
        [{ id: 'local', nome: 'Nome editorial', urlPublica: url, tags: ['campanha'] }],
        [{ filename: 'a.png', name: 'Nome remoto', url, mime: 'image/png', bytes: 10 }, { filename: 'a.png', url, mime: 'image/png', bytes: 10 }]
    );
    assert.equal(resultado.length, 1);
    assert.equal(resultado[0].id, 'local');
    assert.equal(resultado[0].nome, 'Nome editorial');
    assert.deepEqual(resultado[0].tags, ['campanha']);
});
