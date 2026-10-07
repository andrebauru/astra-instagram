'use strict';

/**
 * VALIDAÇÃO DE URL PÚBLICA DE MÍDIA (backend)
 *
 * Classificação real de hosts e verificação assíncrona de URLs HTTPS públicas,
 * sem dependências externas:
 *  - CIDR IPv4/IPv6 por net.BlockList (faixas privadas, locais, reservadas);
 *  - resolução de DNS A e AAAA por node:dns (todos os destinos precisam ser
 *    públicos — proteção SSRF);
 *  - consulta HEAD com fallback para GET (405/501 ou Content-Type ausente);
 *  - redirecionamentos manuais, no máximo 3, sempre revalidados;
 *  - Content-Type normalizado: image/jpeg, image/png, image/webp.
 *
 * A função síncrona usada pelo frontend (integracao-regras.js) aplica as mesmas
 * regras de protocolo, credenciais e classificação de host sem tocar a rede.
 */

const dns = require('node:dns');
const net = require('node:net');

const TIPOS_MIDIA = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);
const MAXIMO_REDIRECIONAMENTOS = 3;

/** Faixas reservadas, privadas, locais ou não roteáveis — por CIDR real. */
const BLOQUEADAS = new net.BlockList();
(function registrarFaixasBloqueadas() {
    const ipv4 = [
        ['0.0.0.0', 8],      // "este host" / não especificado
        ['10.0.0.0', 8],     // rede privada
        ['100.64.0.0', 10],  // carrier-grade NAT (IETF RFC 6598)
        ['127.0.0.0', 8],    // loopback
        ['169.254.0.0', 16], // link-local
        ['172.16.0.0', 12],  // rede privada
        ['192.0.0.0', 24],   // atribuições de protocolo IETF
        ['192.0.2.0', 24],   // TEST-NET-1 (documentação)
        ['192.88.99.0', 24], // relay 6to4 (deprecated)
        ['192.168.0.0', 16], // rede privada
        ['198.18.0.0', 15],  // benchmarking
        ['198.51.100.0', 24],// TEST-NET-2 (documentação)
        ['203.0.113.0', 24], // TEST-NET-3 (documentação)
        ['224.0.0.0', 4],    // multicast
        ['240.0.0.0', 4]     // reservada + broadcast (255.255.255.255)
    ];
    for (const [endereco, prefixo] of ipv4) BLOQUEADAS.addSubnet(endereco, prefixo, 'ipv4');

    const ipv6 = [
        ['::', 128],         // não especificado
        ['::1', 128],        // loopback
        ['64:ff9b::', 96],   // NAT64 (RFC 6052)
        ['100::', 64],       // descarte (RFC 6666)
        ['2001::', 23],      // atribuições de protocolo IETF
        ['2001:db8::', 32],  // documentação (RFC 3849) — não coberta por 2001::/23
        ['2002::', 16],      // 6to4
        ['fc00::', 7],       // ULA (unicast local privado)
        ['fe80::', 10],      // link-local
        ['fec0::', 10],      // site-local (obsoleto)
        ['ff00::', 8]        // multicast
    ];
    for (const [endereco, prefixo] of ipv6) BLOQUEADAS.addSubnet(endereco, prefixo, 'ipv6');
})();

function erroPublico(codigo, mensagem) {
    return Object.assign(new Error(mensagem), { code: codigo });
}

/** Normaliza hostname de URL: brackets de IPv6, ponto final e minúsculas. */
function limparHost(valor) {
    return String(valor || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

/** IPv4 ou IPv6 literal é público (fora de todas as faixas bloqueadas). */
function ipPublico(ip) {
    const familia = net.isIP(ip) === 6 ? 'ipv6' : 'ipv4';
    return !BLOQUEADAS.check(ip, familia);
}

/** Domínio sintaticamente permitido para ser resolvido por DNS. */
function dominioValido(host) {
    if (!host || host.length > 253 || !host.includes('.')) return false;
    if (/(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(host)) return false;
    if (/(?:^|\.)(?:example\.com|example\.net|example\.org)$/.test(host)) return false;
    const rotulos = host.split('.');
    const ultimoRotulo = rotulos.at(-1);
    return rotulos.every(rotulo => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(rotulo)) &&
        /^(?:xn--[a-z0-9-]+|[a-z]{2,})$/.test(ultimoRotulo);
}

/**
 * Classificação síncrona de host HTTPS :
 * IP literal público ou domínio com forma válida. Domínios ainda precisam da
 * resolução DNS, feita pela função assíncrona abaixo.
 */
function hostPublico(host) {
    const limpo = limparHost(host);
    const familia = net.isIP(limpo);
    if (familia === 4 || familia === 6) return ipPublico(limpo);
    return dominioValido(limpo);
}

/** Resolve todos os registros A e AAAA de um domínio. */
async function resolverTodosIPs(host) {
    const registros = await dns.promises.lookup(host, { all: true, family: 0, verbatim: true });
    return (Array.isArray(registros) ? registros : [registros]).map(registro => String(registro.address));
}

/**
 * Verifica um host para a rede: IP literal (direto) ou domínio cuja resolução
 * DNS devolva SOMENTE IPs públicos. Qualquer destino privado/local reprova o
 * conjunto (proteção SSRF).
 */
async function hostPublicoComResolucao(host, resolverIPs) {
    const limpo = limparHost(host);
    const familia = net.isIP(limpo);
    if (familia === 4 || familia === 6) return { ok: ipPublico(limpo), ips: [limpo], literal: true };
    if (!dominioValido(limpo)) return { ok: false, ips: [], literal: false };
    let ips;
    try {
        ips = await (resolverIPs || resolverTodosIPs)(limpo);
    } catch {
        return { ok: false, ips: [], literal: false };
    }
    const lista = Array.isArray(ips) ? ips.map(String).filter(Boolean) : [];
    if (!lista.length) return { ok: false, ips: lista, literal: false };
    return { ok: lista.every(ipPublico), ips: lista, literal: false };
}

/** Normaliza Content-Type: "image/png; charset=..." -> "image/png". */
function normalizarTipo(valor) {
    return String(valor || '').split(';')[0].trim().toLowerCase();
}

function parsearUrlSegura(valor) {
    let url;
    try { url = new URL(String(valor || '')); } catch { throw erroPublico('URL_INVALIDA', 'A URL informada é inválida.'); }
    if (url.protocol !== 'https:') throw erroPublico('URL_NAO_SEGURA', 'A URL de mídia precisa usar HTTPS.');
    if (url.username || url.password) throw erroPublico('URL_CREDENCIAIS', 'A URL não pode conter usuário ou senha embutidos.');
    if (url.hash) throw erroPublico('URL_INVALIDA', 'A URL não pode conter fragmento (#).');
    return url;
}

async function cancelarCorpo(resposta) {
    try { if (resposta.body && typeof resposta.body.cancel === 'function') await resposta.body.cancel(); } catch { /* corpo opcional */ }
}

/** Consulta uma URL com redirect manual. Nunca segue redirect sozinha. */
async function consultarURL(transporte, url, metodo, signal) {
    let resposta;
    try {
        resposta = await transporte(url.href, { method: metodo, redirect: 'manual', signal });
    } catch (erro) {
        if (erro?.name === 'AbortError' || erro?.code === 'ABORT_ERR') throw erroPublico('TEMPO_ESGOTADO', 'A verificação da URL pública excedeu o tempo de espera.');
        throw erroPublico('URL_INACESSIVEL', 'Não foi possível acessar a URL pela rede.');
    }
    if (!resposta || typeof resposta.status !== 'number') throw erroPublico('URL_INACESSIVEL', 'A URL pública respondeu de forma inválida.');
    const status = resposta.status;
    const location = typeof resposta.headers?.get === 'function' ? String(resposta.headers.get('location') || '').trim() : '';
    if ([301, 302, 303, 307, 308].includes(status) && location) {
        return { redireciona: true, location, status, metodo };
    }
    const contentType = normalizarTipo(resposta.headers?.get?.('content-type'));
    const okHttp = status >= 200 && status < 300;
    if (okHttp) await cancelarCorpo(resposta);
    return {
        redireciona: false,
        status,
        contentType,
        okHttp,
        deveUsarGet: metodo === 'HEAD' && (status === 405 || status === 501 || !contentType),
        metodo
    };
}

/** Constrói o destino absoluto e impõe HTTPS/sem credenciais antes de seguir. */
function redirecionarPara(atual, location) {
    let destino;
    try { destino = new URL(location, atual.href); } catch { throw erroPublico('REDIRECT_NAO_PERMITIDO', 'O redirecionamento é inválido.'); }
    if (destino.protocol !== 'https:' || destino.username || destino.password || destino.hash) {
        throw erroPublico('REDIRECT_NAO_PERMITIDO', 'O redirecionamento não é HTTPS público sem credenciais.');
    }
    return destino;
}

/**
 * Validação real e assíncrona de uma URL de mídia:
 * HTTPS -> host público (IP literal ou DNS completo) -> HEAD/GET seguro ->
 * HTTP válido -> Content-Type permitido. Redirecionamentos são revalidados.
 *
 * @param {string} valorUrl URL a validar.
 * @param {object} [opcoes]
 * @param {function} [opcoes.transporte] fetch injetável para testes.
 * @param {function} [opcoes.resolverIPs] resolução DNS injetável para testes.
 * @param {AbortSignal} [opcoes.signal] sinal de cancelamento.
 * @param {number} [opcoes.tempoMs] prazo padrão quando não há signal (20 s).
 * @param {string[]} [opcoes.tiposAceitos] Content-Type aceitos (padrão: JPEG/PNG/WebP).
 */
async function verificarUrlPublica(valorUrl, opcoes = {}) {
    const transporte = opcoes.transporte || globalThis.fetch;
    const resolverIPs = opcoes.resolverIPs;
    const signal = opcoes.signal || AbortSignal.timeout(opcoes.tempoMs || 20000);
    const tiposAceitos = (Array.isArray(opcoes.tiposAceitos) ? opcoes.tiposAceitos : TIPOS_MIDIA).map(normalizarTipo);

    let urlAtual = parsearUrlSegura(valorUrl);
    const resultado = { url: urlAtual.href, redirecionamentos: 0, urlsVisitadas: [urlAtual.href] };

    for (let passo = 0; passo <= MAXIMO_REDIRECIONAMENTOS; passo += 1) {
        const checagem = await hostPublicoComResolucao(urlAtual.hostname, resolverIPs);
        if (!checagem.ok) {
            throw erroPublico(
                passo === 0 ? 'HOST_NAO_PUBLICO' : 'REDIRECT_NAO_PERMITIDO',
                passo === 0
                    ? 'A URL precisa apontar para um host público (sem redes privadas, locais ou reservadas).'
                    : 'O redirecionamento aponta para uma rede privada ou endereço não público.'
            );
        }

        let tentativa = await consultarURL(transporte, urlAtual, 'HEAD', signal);
        if (tentativa.redireciona) {
            urlAtual = redirecionarPara(urlAtual, tentativa.location);
            resultado.redirecionamentos += 1;
            resultado.url = urlAtual.href;
            resultado.urlsVisitadas.push(urlAtual.href);
            continue;
        }
        if (tentativa.deveUsarGet) {
            tentativa = await consultarURL(transporte, urlAtual, 'GET', signal);
            if (tentativa.redireciona) {
                urlAtual = redirecionarPara(urlAtual, tentativa.location);
                resultado.redirecionamentos += 1;
                resultado.url = urlAtual.href;
                resultado.urlsVisitadas.push(urlAtual.href);
                continue;
            }
        }

        if (!tentativa.okHttp) {
            throw erroPublico('URL_INACESSIVEL', `A URL pública não respondeu com HTTP válido (status ${tentativa.status}).`);
        }
        if (!tiposAceitos.includes(tentativa.contentType)) {
            throw erroPublico(
                'TIPO_MIDIA_NAO_PERMITIDO',
                `A URL respondeu com ${tentativa.contentType || 'Content-Type ausente'}; aceite apenas ${tiposAceitos.join(', ')}.`
            );
        }
        return Object.assign(resultado, { metodo: tentativa.metodo, status: tentativa.status, contentType: tentativa.contentType });
    }
    throw erroPublico('REDIRECT_NAO_PERMITIDO', 'Número máximo de redirecionamentos excedido.');
}

module.exports = {
    TIPOS_MIDIA,
    MAXIMO_REDIRECIONAMENTOS,
    limparHost,
    ipPublico,
    dominioValido,
    hostPublico,
    resolverTodosIPs,
    hostPublicoComResolucao,
    normalizarTipo,
    verificarUrlPublica
};