'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

/** Cria o arquivo local de configuração somente quando ele ainda não existe. */
function garantirEnvLocal(diretorio = __dirname) {
    const destino = path.join(diretorio, '.env');
    const modelo = path.join(diretorio, '.env.example');
    try { fs.copyFileSync(modelo, destino, fs.constants.COPYFILE_EXCL); return true; }
    catch (erro) {
        if (erro.code === 'EEXIST') return false;
        throw erro;
    }
}

/** Inicia o backend depois de preparar a configuração local. */
function iniciar() {
    try {
        if (garantirEnvLocal()) console.log('Arquivo .env criado a partir do modelo. Preencha as integrações localmente.');
    } catch (erro) {
        console.error(`Não foi possível preparar o arquivo .env: ${erro.message}`);
        process.exitCode = 1;
        return;
    }
    const processo = spawn(process.execPath, ['--env-file=.env', 'server.js'], { cwd: __dirname, stdio: 'inherit', windowsHide: true });
    processo.on('error', erro => { console.error(`Não foi possível iniciar o Astra: ${erro.message}`); process.exitCode = 1; });
    processo.on('exit', codigo => { process.exitCode = codigo ?? 1; });
}

if (require.main === module) iniciar();
module.exports = { garantirEnvLocal, iniciar };
