'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Persistência durável dos rascunhos, sem miniaturas ou arquivos locais embutidos. */
function criarStorePublicacoes(caminho) {
    function lerEstado() {
        try {
            const dados = JSON.parse(fs.readFileSync(caminho, 'utf8'));
            return { publicacoes: Array.isArray(dados?.publicacoes) ? dados.publicacoes : [] };
        } catch { return { publicacoes: [] }; }
    }

    function salvarEstado(estado) {
        fs.mkdirSync(path.dirname(caminho), { recursive: true });
        const temporario = `${caminho}.${process.pid}.tmp`;
        const fd = fs.openSync(temporario, 'w', 0o600);
        try { fs.writeFileSync(fd, JSON.stringify(estado, null, 2), 'utf8'); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
        fs.renameSync(temporario, caminho);
    }

    function limpar(publicacao) {
        const copia = JSON.parse(JSON.stringify(publicacao));
        copia.imagens = (Array.isArray(copia.imagens) ? copia.imagens : []).map(({ dados, miniatura, ...midia }) => midia);
        delete copia.miniatura;
        return copia;
    }

    function listar() { return lerEstado().publicacoes; }
    function obter(id) { return listar().find(item => item.id === id) || null; }

    function salvar(publicacao) {
        const estado = lerEstado();
        const indice = estado.publicacoes.findIndex(item => item.id === publicacao.id);
        const anterior = indice >= 0 ? estado.publicacoes[indice] : null;
        if (anterior?.atualizadoEm && publicacao.atualizadoEm && Date.parse(anterior.atualizadoEm) > Date.parse(publicacao.atualizadoEm)) {
            return { conflito: true, publicacao: anterior };
        }
        const registro = limpar({ ...publicacao, atualizadoEm: new Date().toISOString() });
        if (indice >= 0) estado.publicacoes[indice] = registro; else estado.publicacoes.push(registro);
        salvarEstado(estado);
        return { conflito: false, publicacao: registro };
    }

    return { listar, obter, salvar };
}

module.exports = { criarStorePublicacoes };
