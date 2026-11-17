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

    /** Expõe somente recibos públicos, nunca estado de upload ou credenciais. */
    function listarHistorico() {
        return Object.entries(lerTudo()).filter(([, e]) => e.mediaId || e.incerto).map(([chave, e]) => ({
            chave, idPublicado: e.mediaId || null,
            destino: chave.endsWith(':facebook-story') ? 'Facebook Story' : chave.endsWith(':facebook') ? 'Facebook Page' : chave.endsWith(':story') || chave.endsWith(':Instagram Story') || e.formato === 'story' ? 'Instagram Story' : 'Instagram Feed',
            estado: e.mediaId ? 'confirmada' : 'incerto',
            publicadoEm: e.publicadoEm || e.atualizadoEm || null,
            permalink: typeof e.permalink === 'string' && /^https:\/\/(?:[a-z0-9-]+\.)*(?:facebook\.com|instagram\.com)\//i.test(e.permalink) ? e.permalink : null
        }));
    }
    return { obter, salvar, listarHistorico };
}

module.exports = { criarStorePublicacoesMeta };
