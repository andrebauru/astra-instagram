'use strict';

const crypto = require('node:crypto');
const { hostPublico, verificarUrlPublica } = require('./rede-publica');

const LIMITE_IMAGEM = 5_000_000;
const TIPOS = Object.freeze({
    'image/jpeg': { extensao: 'jpg', assinatura: buffer => buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff },
    'image/png': { extensao: 'png', assinatura: buffer => buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) },
    'image/webp': { extensao: 'webp', assinatura: buffer => buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP' }
});

/** Cria um erro seguro para a camada HTTP. */
function erroMidia(codigo, mensagem, status = 400) {
    return Object.assign(new Error(mensagem), { code: codigo, status });
}

/** Extrai do PHP apenas uma mensagem curta e segura para exibição no painel. */
function mensagemRemota(retorno) {
    const valor = retorno?.erro ?? retorno?.error ?? retorno?.message;
    return typeof valor === 'string' ? valor.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 300) : '';
}

/** Aceita somente URLs HTTPS públicas para a configuração do backend. */
function normalizarUrlConfigurada(valor, exigirBarraFinal = false) {
    try {
        const url = new URL(String(valor || ''));
        if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) return null;
        if (!hostPublico(url.hostname)) return null;
        if (exigirBarraFinal && !url.pathname.endsWith('/')) return null;
        return url;
    } catch { return null; }
}

/** Valida o endpoint de upload sem substituir o endereço configurado. */
function normalizarEndpointUpload(valor) {
    return normalizarUrlConfigurada(valor);
}

/**
 * Aceita qualquer URL HTTPS pública devolvida pelo armazenamento, sem exigir
 * um domínio, diretório ou extensão específica. MEDIA_PUBLIC_BASE_URL informa
 * o storage padrão, mas não funciona mais como whitelist obrigatória. O
 * Content-Type real é conferido depois, por verificação assíncrona.
 */
function normalizarUrlPublica(valor) {
    try {
        const url = new URL(String(valor || ''));
        if (url.protocol !== 'https:' || url.username || url.password || url.hash) return null;
        if (!hostPublico(url.hostname)) return null;
        return url;
    } catch { return null; }
}

/** Decodifica uma imagem local e confere o conteúdo real do arquivo. */
function decodificarImagem(dados, mimeInformado) {
    const correspondencia = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(dados || ''));
    if (!correspondencia || correspondencia[1] !== mimeInformado) throw erroMidia('MIDIA_FORMATO_INVALIDO', 'Use uma imagem JPEG, PNG ou WebP válida.');
    const buffer = Buffer.from(correspondencia[2], 'base64');
    if (!buffer.length || buffer.length > LIMITE_IMAGEM || !TIPOS[mimeInformado].assinatura(buffer)) throw erroMidia('MIDIA_FORMATO_INVALIDO', 'Use uma imagem JPEG, PNG ou WebP válida de até 5 MB.');
    return buffer;
}

/** Produz nome seguro sem reutilizar caminhos fornecidos pelo navegador. */
function nomeDoArquivo(nome, hash, mime) {
    const base = String(nome || '').replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+/, '').slice(0, 80);
    const semExtensao = base.replace(/\.[^.]+$/, '') || `astra-${hash.slice(0, 16)}`;
    return `${semExtensao}.${TIPOS[mime].extensao}`;
}

/** Cria o cliente de upload remoto sem expor a chave ao navegador. */
function criarServicoMidiaPublica(opcoes = {}) {
    const endpoint = normalizarEndpointUpload(opcoes.uploadUrl);
    const baseConfigurada = normalizarUrlConfigurada(opcoes.basePublicaUrl, true);
    const basePublica = baseConfigurada?.href || null;
    const chave = typeof opcoes.uploadKey === 'string' ? opcoes.uploadKey.trim() : '';
    const prazo = Math.max(1000, Number(opcoes.prazoVerificacao || 30000));
    const resolverIPs = opcoes.resolverIPs;

    function capacidades() {
        return {
            configurado: Boolean(endpoint && chave),
            tipo: 'php-remoto',
            endpoint: endpoint?.href || null,
            basePublica,
            tiposAceitos: Object.keys(TIPOS),
            limiteBytes: LIMITE_IMAGEM,
            variaveisObrigatorias: ['MEDIA_UPLOAD_URL', 'MEDIA_UPLOAD_KEY'],
            motivo: endpoint && chave ? null : 'Configure MEDIA_UPLOAD_URL e MEDIA_UPLOAD_KEY no backend local.'
        };
    }

    /** Confirma por HEAD/GET que a URL pública contém uma imagem acessível. */
    async function verificarAcesso(urlHref, transporte, signal) {
        try {
            return await verificarUrlPublica(urlHref, {
                transporte,
                signal,
                resolverIPs,
                tiposAceitos: Object.keys(TIPOS)
            });
        } catch (erro) {
            const motivo = erro?.code === 'TIPO_MIDIA_NAO_PERMITIDO'
                ? 'O PHP enviou uma URL, mas ela não devolve uma imagem JPEG, PNG ou WebP acessível.'
                : erro?.code === 'URL_NAO_SEGURA' || erro?.code === 'URL_CREDENCIAIS' || erro?.code === 'HOST_NAO_PUBLICO' || erro?.code === 'REDIRECT_NAO_PERMITIDO'
                    ? 'O PHP enviou uma URL que não é HTTPS pública (redes locais, privadas ou reservadas não são aceitas).'
                    : 'O PHP enviou uma URL, mas a imagem HTTPS não está acessível publicamente.';
            throw erroMidia('MIDIA_PUBLICA_INACESSIVEL', motivo, 502);
        }
    }

    /** Envia multipart ao PHP e retorna somente uma URL HTTPS pública validada. */
    async function publicar({ dados, mime, nome }) {
        if (!endpoint || !chave) throw erroMidia('MIDIA_STORAGE_NAO_CONFIGURADO', capacidades().motivo, 503);
        if (!Object.hasOwn(TIPOS, mime)) throw erroMidia('MIDIA_FORMATO_INVALIDO', 'Use uma imagem JPEG, PNG ou WebP válida.');
        const buffer = decodificarImagem(dados, mime);
        const hash = crypto.createHash('sha256').update(buffer).digest('hex');
        const formulario = new FormData();
        formulario.append('arquivo', new Blob([buffer], { type: mime }), nomeDoArquivo(nome, hash, mime));
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), prazo);
        const transporte = opcoes.fetchImpl || globalThis.fetch;
        try {
            let resposta;
            try {
                resposta = await transporte(endpoint.href, { method: 'POST', headers: { 'X-Astra-Key': chave }, body: formulario, redirect: 'error', signal: controller.signal });
            } catch {
                throw erroMidia('MIDIA_UPLOAD_FALHOU', 'Não foi possível conectar ao servidor de mídia.', 502);
            }
            let retorno;
            try { retorno = await resposta.json(); } catch { throw erroMidia('MIDIA_UPLOAD_RESPOSTA_INVALIDA', 'O servidor de mídia retornou JSON inválido.', 502); }
            if (!resposta.ok || retorno?.ok !== true) {
                const detalhe = mensagemRemota(retorno);
                throw erroMidia('MIDIA_UPLOAD_RECUSADO', detalhe || 'O servidor de mídia recusou o arquivo.', resposta.status >= 400 ? resposta.status : 502);
            }
            const url = normalizarUrlPublica(retorno.url);
            if (!url) throw erroMidia('MIDIA_UPLOAD_RESPOSTA_INVALIDA', 'O servidor de mídia retornou uma URL fora dos padrões HTTPS públicos aceitos.', 502);
            await verificarAcesso(url.href, transporte, controller.signal);
            return { url: url.href, arquivo: String(retorno.arquivo || ''), mime, bytes: buffer.length, sha256: hash, verificadaEm: new Date().toISOString(), remoteStatus: resposta.status };
        } finally { clearTimeout(timer); }
    }

    return { capacidades, publicar };
}

module.exports = { LIMITE_IMAGEM, normalizarUrlConfigurada, normalizarEndpointUpload, normalizarUrlPublica, decodificarImagem, criarServicoMidiaPublica };
