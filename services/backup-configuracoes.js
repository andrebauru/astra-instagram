'use strict';
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
const { erroSeguro } = require('../bridge-seguranca');

/** Deriva a chave sem guardar a senha; parâmetros fixos impedem arquivos abusivos. */
async function chave(senha, salt) {
    if (typeof senha !== 'string' || senha.length < 8 || senha.length > 256) throw erroSeguro('BACKUP_INVALIDO', 'Use uma senha entre 8 e 256 caracteres.', 400);
    return scrypt(senha, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

/** Exporta somente as configurações autorizadas em um envelope autenticado. */
async function exportar(configuracoes, senha) {
    const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12), k = await chave(senha, salt);
    try {
        const cifra = crypto.createCipheriv('aes-256-gcm', k, iv);
        const dados = Buffer.concat([cifra.update(JSON.stringify(configuracoes), 'utf8'), cifra.final()]);
        return { formato: 'astra-config-v1', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cifra.getAuthTag().toString('base64'), dados: dados.toString('base64') };
    } finally { k.fill(0); }
}

/** Autentica o arquivo inteiro antes de devolver qualquer configuração para gravação. */
async function importar(arquivo, senha) {
    let k;
    try {
        if (!arquivo || arquivo.formato !== 'astra-config-v1') throw new Error();
        const ler = (nome, tamanho) => {
            const valor = arquivo[nome];
            if (typeof valor !== 'string' || valor.length > 200000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(valor)) throw new Error();
            const buffer = Buffer.from(valor, 'base64');
            if (buffer.toString('base64') !== valor || (tamanho && buffer.length !== tamanho)) throw new Error();
            return buffer;
        };
        const salt = ler('salt', 16), iv = ler('iv', 12), tag = ler('tag', 16), dados = ler('dados');
        k = await chave(senha, salt);
        const cifra = crypto.createDecipheriv('aes-256-gcm', k, iv); cifra.setAuthTag(tag);
        const configuracoes = JSON.parse(Buffer.concat([cifra.update(dados), cifra.final()]).toString('utf8'));
        if (!configuracoes || typeof configuracoes !== 'object' || Array.isArray(configuracoes)) throw new Error();
        return configuracoes;
    } catch { throw erroSeguro('BACKUP_INVALIDO', 'Senha incorreta ou backup inválido. Nada foi importado.', 400); }
    finally { k?.fill(0); }
}
module.exports = { exportar, importar };
