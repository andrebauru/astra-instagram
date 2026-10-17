'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

/** Protege a chave de dados com DPAPI do usuário Windows, sem argumentos secretos. */
function dpapi(bytes, proteger) {
    const metodo = proteger ? 'Protect' : 'Unprotect';
    const script = `Add-Type -AssemblyName System.Security; $entradaAstra=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $saidaAstra=[Security.Cryptography.ProtectedData]::${metodo}($entradaAstra,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($saidaAstra))`;
    const resultado = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input: bytes.toString('base64'), encoding: 'utf8', windowsHide: true, timeout: 15000 });
    if (resultado.status !== 0 || !resultado.stdout?.trim()) throw new Error('Não foi possível abrir o cofre privado do usuário Windows.');
    return Buffer.from(resultado.stdout.trim(), 'base64');
}

/** Cria chave fora do projeto; no Windows o arquivo contém somente a chave protegida por DPAPI. */
function chaveLocal() {
    const pasta = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'Astra', 'segredos');
    const arquivo = path.join(pasta, process.platform === 'win32' ? 'chave.dpapi' : 'chave.bin');
    fs.mkdirSync(pasta, { recursive: true, mode: 0o700 });
    let bytes;
    try { bytes = fs.readFileSync(arquivo); }
    catch (erro) {
        if (erro.code !== 'ENOENT') throw new Error('Cofre privado indisponível.');
        const nova = crypto.randomBytes(32);
        bytes = process.platform === 'win32' ? dpapi(nova, true) : nova;
        try { fs.writeFileSync(arquivo, bytes, { flag: 'wx', mode: 0o600 }); }
        catch (falha) { if (falha.code !== 'EEXIST') throw falha; bytes = fs.readFileSync(arquivo); }
    }
    const chave = process.platform === 'win32' ? dpapi(bytes, false) : bytes;
    if (chave.length !== 32) throw new Error('Chave do cofre inválida. Não substitua a chave existente.');
    return chave;
}

/** JSON autenticado AES-256-GCM, com migração atômica do formato legado. */
function criarCofreLocal(caminho, { obterChave = chaveLocal } = {}) {
    let chave;
    const abrirChave = () => chave || (chave = obterChave());
    /** Grava envelope cifrado; falha de criptografia nunca resulta em texto aberto. */
    function salvar(dados) {
        const iv = crypto.randomBytes(12);
        const cifra = crypto.createCipheriv('aes-256-gcm', abrirChave(), iv);
        cifra.setAAD(Buffer.from('astra-cofre-v1'));
        const bytes = Buffer.concat([cifra.update(JSON.stringify(dados), 'utf8'), cifra.final()]);
        const envelope = { cofre: 1, iv: iv.toString('base64'), tag: cifra.getAuthTag().toString('base64'), dados: bytes.toString('base64') };
        fs.mkdirSync(path.dirname(caminho), { recursive: true, mode: 0o700 });
        const temp = `${caminho}.${crypto.randomUUID()}.tmp`;
        const fd = fs.openSync(temp, 'wx', 0o600);
        try { fs.writeFileSync(fd, JSON.stringify(envelope)); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
        fs.renameSync(temp, caminho);
    }
    /** Recusa corrupção; nunca substitui um cofre ilegível por dados vazios. */
    function ler() {
        let texto;
        try { texto = fs.readFileSync(caminho, 'utf8'); }
        catch (erro) { if (erro.code === 'ENOENT') return {}; throw new Error('Cofre indisponível.'); }
        try {
            const envelope = JSON.parse(texto);
            if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error();
            if (!Object.hasOwn(envelope, 'cofre')) { salvar(envelope); return envelope; }
            if (envelope.cofre !== 1) throw new Error();
            const cifra = crypto.createDecipheriv('aes-256-gcm', abrirChave(), Buffer.from(envelope.iv, 'base64'));
            cifra.setAAD(Buffer.from('astra-cofre-v1'));
            cifra.setAuthTag(Buffer.from(envelope.tag, 'base64'));
            return JSON.parse(Buffer.concat([cifra.update(Buffer.from(envelope.dados, 'base64')), cifra.final()]).toString('utf8'));
        } catch { throw new Error('Não foi possível decifrar o cofre. Preserve o arquivo e a chave do usuário original.'); }
    }
    return { ler, salvar };
}
module.exports = { criarCofreLocal };
