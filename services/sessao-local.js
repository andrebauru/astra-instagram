'use strict';
const crypto = require('node:crypto');
const { erroSeguro } = require('../bridge-seguranca');

/** Sessões locais HttpOnly; o acesso ao computador é a identidade desta instalação monousuário. */
function criarSessoesLocais({ agora = Date.now } = {}) {
    const sessoes = new Map();
    /** Recupera sessão existente sem criar autorização implicitamente em um POST. */
    function obter(req) {
        const id = /(?:^|;\s*)astra_sessao=([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
        const sessao = sessoes.get(id);
        if (!sessao || sessao.expira <= agora() || sessao.host !== req.headers.host) return null;
        return { id, ...sessao };
    }
    /** Emite cookie de sessão e nonce CSRF somente através da origem local já validada. */
    function iniciar(req, res) {
        const existente = obter(req);
        if (existente) return existente;
        for (const [id, s] of sessoes) if (s.expira <= agora()) sessoes.delete(id);
        if (sessoes.size >= 100) throw erroSeguro('LIMITE_SESSAO', 'Limite de sessões locais atingido.', 429);
        const id = crypto.randomBytes(32).toString('base64url');
        const sessao = { csrf: crypto.randomBytes(32).toString('base64url'), expira: agora() + 3600000, host: req.headers.host };
        sessoes.set(id, sessao);
        res.setHeader('Set-Cookie', `astra_sessao=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600`);
        return { id, ...sessao };
    }
    /** Compara nonce em tempo constante e rejeita POST sem sessão. */
    function exigir(req) {
        const sessao = obter(req);
        const recebido = req.headers['x-astra-csrf'];
        if (!sessao || typeof recebido !== 'string' || recebido.length !== sessao.csrf.length || !crypto.timingSafeEqual(Buffer.from(recebido), Buffer.from(sessao.csrf))) throw erroSeguro('SESSAO_INVALIDA', 'Reabra o painel para iniciar uma sessão local válida.', 403);
        return sessao;
    }
    /** Guarda somente mensagem segura de retorno, limitada à sessão do navegador. */
    function falhar(req, mensagem) { const s = obter(req); if (s) sessoes.get(s.id).erroConexao = mensagem; }
    return { obter, iniciar, exigir, falhar };
}
module.exports = { criarSessoesLocais };
