'use strict';
const { createHash } = require('node:crypto');
const tentativas = new Map();

/** Produz erros que podem ser apresentados sem expor respostas externas ou segredos. */
function erroSeguro(codigo, mensagem, status = 502) {
    return Object.assign(new Error(mensagem), { codigo, status, seguro: true });
}

/** Remove segredos configurados de campos textuais antes de qualquer resposta. */
function ocultarSegredos(valor) {
    if (typeof valor !== 'string') return valor;
    for (const nome of ['INSTAGRAM_ACCESS_TOKEN', 'OPENROUTER_API_KEY', 'META_VERIFY_TOKEN', 'MEDIA_UPLOAD_KEY']) {
        if (process.env[nome]) valor = valor.split(process.env[nome]).join('[oculto]');
    }
    return valor;
}

/** Limita o acesso do navegador às origens locais do painel e do próprio bridge. */
function autorizarOrigem(req, res) {
    const porta = req.socket.localPort;
    const portas = [porta, Number(process.env.PAINEL_PORT || 4317)];
    const permitidas = portas.flatMap(numero => [`http://127.0.0.1:${numero}`, `http://localhost:${numero}`]);
    const host = req.headers.host;
    if (host !== `127.0.0.1:${porta}` && host !== `localhost:${porta}`) throw erroSeguro('ORIGEM_RECUSADA', 'Use o endereço local do Astra Instagram Bridge.', 403);
    if (req.headers.origin && !permitidas.includes(req.headers.origin)) throw erroSeguro('ORIGEM_RECUSADA', 'Origem não autorizada para acessar o servidor local.', 403);
    if (req.headers.origin) res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Publicacao-Id, X-Diagnostico-Token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
}

/** Reutiliza o resultado de uma tentativa para impedir cliques duplicados no mesmo processo. */
async function publicarUmaVez(req, body, executar) {
    const chave = req.headers['x-publicacao-id'];
    if (!chave) return executar(); // Preserva clientes anteriores que não usam o painel.
    if (!/^[a-zA-Z0-9-]{16,80}$/.test(chave)) throw erroSeguro('IDENTIFICADOR_INVALIDO', 'Identificador de publicação inválido.', 400);
    const assinatura = createHash('sha256').update(JSON.stringify([req.url, body])).digest('hex');
    const existente = tentativas.get(chave);
    if (existente) {
        if (existente.assinatura !== assinatura) throw erroSeguro('PUBLICACAO_DIVERGENTE', 'Este identificador já foi usado com outro conteúdo.', 409);
        return existente.resultado;
    }
    if (tentativas.size >= 1000) throw erroSeguro('LIMITE_SESSAO', 'Limite de tentativas desta sessão atingido. Revise os envios antes de reiniciar o bridge.', 429);
    const resultado = Promise.resolve().then(executar);
    tentativas.set(chave, { assinatura, resultado });
    return resultado;
}

module.exports = { erroSeguro, ocultarSegredos, autorizarOrigem, publicarUmaVez };
