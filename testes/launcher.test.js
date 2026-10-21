'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { garantirEnvLocal } = require('../iniciar');

/** Exercita o provisionamento em pasta temporária, sem tocar no .env do projeto. */
test('primeira execução cria .env sem segredos e preserva o arquivo existente', () => {
    const diretorio = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-launcher-'));
    try {
        fs.copyFileSync(path.join(__dirname, '..', '.env.example'), path.join(diretorio, '.env.example'));
        assert.equal(garantirEnvLocal(diretorio), true);
        const modelo = fs.readFileSync(path.join(diretorio, '.env'), 'utf8');
        assert.match(modelo, /INSTAGRAM_ACCESS_TOKEN=\s*$/m);
        assert.match(modelo, /OPENROUTER_API_KEY=\s*$/m);
        assert.equal(garantirEnvLocal(diretorio), false);
        fs.writeFileSync(path.join(diretorio, '.env'), 'SEGREDO_LOCAL=manter\n');
        assert.equal(garantirEnvLocal(diretorio), false);
        assert.equal(fs.readFileSync(path.join(diretorio, '.env'), 'utf8'), 'SEGREDO_LOCAL=manter\n');
    } finally { fs.rmSync(diretorio, { recursive: true, force: true }); }
});
