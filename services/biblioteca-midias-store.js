'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** Mescla o inventário por URL canônica, preservando personalizações já salvas. */
function reconciliarMidias(existentes, remotas) {
    const porUrl = new Map();
    for (const item of existentes || []) {
        if (!item?.urlPublica) continue;
        porUrl.set(new URL(item.urlPublica).href, item);
    }
    for (const remota of remotas || []) {
        if (!remota || typeof remota.url !== 'string') continue;
        const url = new URL(remota.url).href;
        const anterior = porUrl.get(url) || {};
        porUrl.set(url, {
            ...remota, ...anterior, id: anterior.id || crypto.randomUUID(), nome: anterior.nome || remota.name || remota.filename || 'Mídia remota',
            tipo: anterior.tipo || (String(remota.mime || '').startsWith('video/') ? 'video' : 'imagem'), mime: anterior.mime || remota.mime || '',
            tamanho: anterior.tamanho || remota.bytes || 0, criadaEm: anterior.criadaEm || remota.modified_at || null,
            urlPublica: url, origem: 'inventario-remoto', statusUpload: 'concluido'
        });
    }
    return [...porUrl.values()];
}

/** Mantém o catálogo de URLs públicas sem persistir base64 ou miniaturas locais. */
function criarStoreBibliotecaMidias(caminho) {
    function limpar(item) {
        const { dados, miniatura, ...seguro } = item || {};
        return { ...seguro, id: seguro.id || crypto.randomUUID() };
    }

    function ler() {
        try {
            const estado = JSON.parse(fs.readFileSync(caminho, 'utf8'));
            return Array.isArray(estado?.midias) ? estado.midias : [];
        } catch { return []; }
    }

    function salvar(midias) {
        const estado = { versao: 1, midias: (Array.isArray(midias) ? midias : []).map(limpar) };
        fs.mkdirSync(path.dirname(caminho), { recursive: true });
        const temporario = `${caminho}.${process.pid}.tmp`;
        const fd = fs.openSync(temporario, 'w', 0o600);
        try { fs.writeFileSync(fd, JSON.stringify(estado, null, 2), 'utf8'); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
        fs.renameSync(temporario, caminho);
        return estado.midias;
    }

    return { listar: ler, salvar };
}

module.exports = { criarStoreBibliotecaMidias, reconciliarMidias };
