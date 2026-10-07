'use strict';

/**
 * Persistência de configuração da empresa (template fixo e agenda padrão).
 *
 * Gravação atômica em arquivo fora de qualquer diretório público. O template
 * fixo precisa sobreviver a reinício do servidor, atualização de código,
 * recarga da página e reinício do navegador — por isso não depende de
 * localStorage/IndexedDB.
 */

const fs = require('node:fs');
const path = require('node:path');

function criarStoreEmpresa(caminho) {
    function ler() {
        try {
            const dados = JSON.parse(fs.readFileSync(caminho, 'utf8'));
            return dados && typeof dados === 'object' && !Array.isArray(dados) ? dados : {};
        } catch { return {}; }
    }

    function salvar(estado) {
        try {
            fs.mkdirSync(path.dirname(caminho), { recursive: true });
            const temporario = `${caminho}.tmp`;
            fs.writeFileSync(temporario, JSON.stringify(estado, null, 2), { encoding: 'utf8', mode: 0o600 });
            fs.renameSync(temporario, caminho);
            return true;
        } catch { return false; }
    }

    function atualizar(campo, valor) {
        const estado = ler();
        estado[campo] = valor;
        estado.atualizadoEm = new Date().toISOString();
        salvar(estado);
        return valor;
    }

    return {
        ler,
        salvar,
        lerTemplate: () => ler().template || null,
        salvarTemplate: template => atualizar('template', template),
        lerAgenda: () => ler().agenda || null,
        salvarAgenda: agenda => atualizar('agenda', agenda)
    };
}

module.exports = { criarStoreEmpresa };
