'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Mantém o contêiner Meta de cada publicação para retries idempotentes. */
function criarStorePublicacoesMeta(caminho) {
    function lerTudo() {
        try {
            const dados = JSON.parse(fs.readFileSync(caminho, 'utf8'));
            return dados && typeof dados === 'object' && !Array.isArray(dados) ? dados : {};
        } catch { return {}; }
    }

    function gravarTudo(dados) {
        fs.mkdirSync(path.dirname(caminho), { recursive: true });
        const temporario = `${caminho}.${process.pid}.tmp`;
        const descritor = fs.openSync(temporario, 'w', 0o600);
        try {
            fs.writeFileSync(descritor, JSON.stringify(dados, null, 2), 'utf8');
            fs.fsyncSync(descritor);
        } finally { fs.closeSync(descritor); }
        fs.renameSync(temporario, caminho);
    }

    function obter(publicacaoId) {
        return lerTudo()[publicacaoId] || null;
    }

    function salvar(publicacaoId, estado) {
        const dados = lerTudo();
        dados[publicacaoId] = { ...(dados[publicacaoId] || {}), ...estado, atualizadoEm: new Date().toISOString() };
        gravarTudo(dados);
        return dados[publicacaoId];
    }

    return { obter, salvar };
}

module.exports = { criarStorePublicacoesMeta };
