'use strict';

/*
 * Regras puras do frontend e cliente do bridge local.
 *
 * - validação síncrona de URL HTTPS pública (mesmas regras de rede-publica.js);
 * - montagem do prompt e assinatura de conteúdo;
 * - validação de publicação do Instagram;
 * - cliente HTTP restrito às rotas do Astra.
 */

/** Converte IPv4 literal em inteiro de 32 bits (ou null se inválido). */
function ipv4ParaNumero(host) {
    const partes = host.split('.');
    if (partes.length !== 4) return null;
    let valor = 0;
    for (const parte of partes) {
        if (!/^\d{1,3}$/.test(parte) || (parte.length > 1 && parte.startsWith('0'))) return null;
        const octeto = Number(parte);
        if (Number.isNaN(octeto) || octeto > 255) return null;
        valor = (valor * 256) + octeto;
    }
    return valor >>> 0;
}

function faixaIpv4(ip, rede, prefixo) {
    const r = ipv4ParaNumero(rede);
    if (r === null) return false;
    const mascara = prefixo === 0 ? 0 : ((0xffffffff << (32 - prefixo)) >>> 0);
    return (ip & mascara) === (r & mascara);
}

function ipv4Publico(host) {
    const ip = ipv4ParaNumero(host);
    if (ip === null) return false;
    const faixas = [
        ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
        ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
        ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
        ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
    ];
    return !faixas.some(([rede, prefixo]) => faixaIpv4(ip, rede, prefixo));
}

function gruposParaBigInt(grupos) {
    let valor = 0n;
    for (const grupo of grupos) valor = (valor << 16n) | BigInt(grupo & 0xffff);
    return valor;
}

function ipv6ParaBigInt(host) {
    const endereco = String(host).replace(/%.*$/, '');
    const comIpv4 = /^(.*):(\d{1,3}(?:\.\d{1,3}){3})$/.exec(endereco);
    if (comIpv4) {
        const ipv4 = ipv4ParaNumero(comIpv4[2]);
        if (ipv4 === null) return null;
        const prefixo = ipv6ParaBigInt(comIpv4[1] || '::');
        if (prefixo === null) return null;
        return (prefixo << 32n) | BigInt(ipv4);
    }
    if (!/^[0-9a-f:]+$/i.test(endereco)) return null;
    const metades = endereco.split('::');
    if (metades.length > 2) return null;
    const expandir = parte => parte ? parte.split(':').map(h => { if (!/^[0-9a-f]{1,4}$/i.test(h)) throw 0; return parseInt(h, 16); }) : [];
    const grupos = [];
    try {
        if (metades.length === 2) {
            const esquerda = expandir(metades[0]); const direita = expandir(metades[1]);
            const vazios = 8 - esquerda.length - direita.length;
            if (vazios < 1) return null;
            grupos.push(...esquerda, ...Array(vazios).fill(0), ...direita);
        } else {
            const unico = expandir(metades[0]);
            if (unico.length !== 8) return null;
            grupos.push(...unico);
        }
    } catch { return null; }
    return gruposParaBigInt(grupos);
}

function mascaraIpv6(prefixo) {
    const tudo = (1n << 128n) - 1n;
    if (prefixo <= 0) return 0n;
    if (prefixo >= 128) return tudo;
    return tudo ^ ((1n << BigInt(128 - prefixo)) - 1n);
}

function ipv6EmFaixa(ip, rede, prefixo) {
    const r = ipv6ParaBigInt(rede);
    if (r === null) return false;
    const mascara = mascaraIpv6(prefixo);
    return (ip & mascara) === (r & mascara);
}

function ipv4DeNumero(numero) {
    const n = Number(numero) >>> 0;
    return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
}

function ipv6Publico(host) {
    const ip = ipv6ParaBigInt(host);
    if (ip === null) return false;
    const alto = ip >> 32n; const baixo = Number(ip & 0xffffffffn);
    if (alto === 0xffffn) return ipv4Publico(ipv4DeNumero(baixo));
    const faixas = [
        ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001::', 23],
        ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]
    ];
    return !faixas.some(([rede, prefixo]) => ipv6EmFaixa(ip, rede, prefixo));
}

function dominioPublicoValido(host) {
    if (!host || host.length > 253 || !host.includes('.')) return false;
    if (/(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(host)) return false;
    if (['example.com', 'example.net', 'example.org'].some(dominio => host === dominio || host.endsWith('.' + dominio))) return false;
    const rotulos = host.split('.');
    if (!rotulos.every(rotulo => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(rotulo))) return false;
    return /^(?:xn--[a-z0-9-]+|[a-z]{2,})$/.test(rotulos.at(-1));
}

/** Recusa caminhos locais, credenciais e redes privadas; aceita HTTPS público. */
function urlPublica(valor) {
    if (typeof valor !== 'string' || valor.length > 4096) return false;
    try {
        const url = new URL(valor);
        if (url.protocol !== 'https:' || url.username || url.password || url.hash) return false;
        const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
        if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) && ipv4ParaNumero(host) !== null) return ipv4Publico(host);
        if (host.includes(':')) return ipv6Publico(host);
        return dominioPublicoValido(host);
    } catch { return false; }
}

function urlPublicaHttps(valor) { return urlPublica(valor); }

/** Confirma o tipo de publicação aceito pelo fluxo. */
function tipoMidiaDefinido(publicacao) { return ['imagem', 'carrossel', 'reel'].includes(publicacao?.tipoMidia); }

/** Copia a URL individual para o campo compatível com o tipo selecionado. */
function sincronizarUrlsPublicas(publicacao) {
    if (!publicacao) return;
    const midias = Array.isArray(publicacao.imagens) ? publicacao.imagens : [];
    if (publicacao.tipoMidia === 'imagem') { const imagem = midias[0]; if (imagem) publicacao.imagemUrl = imagem.urlPublica || ''; }
    else if (publicacao.tipoMidia === 'reel') { const video = midias.find(item => item.tipo === 'video'); if (video) publicacao.videoUrl = video.urlPublica || ''; }
}

/** Exige a URL pública correspondente ao tipo de publicação selecionado. */
function midiasPublicasProntas(publicacao) {
    if (publicacao?.tipoMidia === 'imagem') return urlPublicaHttps(publicacao.imagemUrl);
    if (publicacao?.tipoMidia === 'reel') return urlPublicaHttps(publicacao.videoUrl);
    if (publicacao?.tipoMidia !== 'carrossel') return false;
    const midias = Array.isArray(publicacao.imagens) ? publicacao.imagens : [];
    return midias.length >= 2 && midias.every(item => urlPublicaHttps(item.urlPublica));
}

/** Monta a solicitação textual sem enviar imagens locais indevidamente. */
function montarPrompt(p, reescrever = false, comImagem = false) {
    const contexto = [p.objetivo, p.tema, p.fatos, p.fatosIa, p.textoMidia, p.contexto].filter(Boolean).join('\n');
    const base = reescrever ? (p.legenda || '').trim() : contexto.trim();
    if (!base) throw new Error(reescrever ? 'Escreva uma legenda antes de reescrever.' : 'Informe o tema e os fatos na etapa Informações.');
    return [
        `${reescrever ? 'Reescreva' : 'Crie'} uma legenda em português para Instagram. Retorne apenas a legenda para revisão humana.`,
        comImagem ? 'Use os fatos confirmados e os elementos visíveis na imagem, sem inventar informações.' : 'Use somente os fatos fornecidos. Não invente preços, promoções, endereços ou detalhes visuais. Você não recebeu imagens.',
        'Não acrescente hashtags, localização ou websites: o painel adiciona esses dados separadamente.',
        `Contexto e fatos confirmados:\n${contexto.trim() || 'Nenhum contexto adicional fornecido.'}`,
        reescrever ? `Legenda a reescrever:\n${base}` : '',
        (p.palavras || '').trim() ? `Dicas de tema para inspiração (não obrigatórias):\n${p.palavras}` : '',
        (p.ideias || '').trim() ? `Ideias obrigatórias, sem inventar fatos para atendê-las:\n${p.ideias}` : ''
    ].filter(Boolean).join('\n\n');
}

/** Captura o que precisa permanecer igual durante geração/confirmação. */
function assinaturaConteudo(p) {
    return JSON.stringify({
        legenda: p.legenda, templateTexto: p.templateTexto, tema: p.tema, fatos: p.fatos, fatosIa: p.fatosIa, textoMidia: p.textoMidia, contexto: p.contexto, objetivo: p.objetivo,
        hashtags: p.hashtags, palavras: p.palavras, ideias: p.ideias, revisoes: p.revisoes,
        incluir: p.incluir, local: p.local, maps: p.maps, site1: p.site1, site2: p.site2,
        tipoMidia: p.tipoMidia, imagemUrl: p.imagemUrl, videoUrl: p.videoUrl,
        imagens: (p.imagens || []).map(item => ({ id: item.id, urlPublica: item.urlPublica, tipo: item.tipo }))
    });
}

/** Valida exclusivamente a publicação imediata do Instagram. */
function validarInstagram(p, regras) {
    const itens = regras.validar(p, Date.now(), { exigirMidia: false, exigirAgenda: false });
    itens.push({ ok: tipoMidiaDefinido(p), texto: 'Tipo de publicação definido' });
    itens.push({ ok: midiasPublicasProntas(p), texto: 'URL HTTPS pública da mídia' });
    itens.push({ ok: !p.publicacaoReal, texto: 'Este conteúdo ainda não possui tentativa de publicação real' });
    return itens;
}

/** Cria um cliente restrito às rotas do Astra local. */
function criarCliente(base, transporte = globalThis.fetch) {
    const endereco = new URL(base);
    if (!['localhost', '127.0.0.1'].includes(endereco.hostname) || endereco.protocol !== 'http:' || endereco.username || endereco.password) throw new Error('O painel deve acessar somente o bridge local.');
    const ROTAS = [
        '/health', '/meta/me', '/media/upload/capabilities', '/media/upload',
        '/astra/models', '/astra/generate', '/instagram/publish',
        '/instagram/media', '/instagram/metrics/update', '/instagram/analysis',
        '/agenda/planos', '/agenda/executar', '/agenda/pausar', '/agenda/retomar', '/agenda/reagendar', '/agenda/cancelar',
        '/empresa/config', '/empresa/template', '/empresa/agenda', '/empresa/template-padrao', '/empresa/recorrentes',
        '/diagnostico/access', '/diagnostico/status', '/diagnostico/event', '/diagnostico/start', '/diagnostico/stop', '/diagnostico/mark', '/diagnostico/export'
    ];
    const mensagens = {
        INSTAGRAM_NAO_CONFIGURADO: 'Instagram não configurado no servidor.',
        INSTAGRAM_NAO_AUTENTICADO: 'Instagram não autenticado. Verifique a autorização no backend.',
        INSTAGRAM_TOKEN_INVALIDO: 'O token do Instagram expirou ou é inválido. Atualize INSTAGRAM_ACCESS_TOKEN no backend.',
        INSTAGRAM_MEDIA_INVALIDA: 'A mídia não é aceita pelo Instagram. Use JPEG, PNG ou WebP com URL HTTPS pública.',
        INSTAGRAM_URL_INACESSIVEL: 'A Meta não conseguiu baixar a mídia na URL pública informada.',
        INSTAGRAM_CONTAINER_FALHOU: 'O container da publicação não foi criado pela Meta. Veja a mensagem real e tente novamente.',
        INSTAGRAM_PUBLICACAO_FALHOU: 'A Meta criou o container, mas não confirmou a publicação. Confira o Instagram antes de tentar novamente.',
        ASTRA_NAO_CONFIGURADA: 'Astra não configurada no servidor.',
        ASTRA_AUTORIZACAO: 'Autorização recusada pelo OpenRouter.',
        ASTRA_SALDO: 'Crédito/saldo insuficiente no OpenRouter.',
        ASTRA_MODELO_INDISPONIVEL: 'Modelo indisponível. Atualize os modelos e escolha outra opção.',
        ASTRA_LIMITE: 'Limite temporário atingido. Aguarde antes de tentar novamente.',
        ASTRA_TEMPORARIA: 'Falha temporária no OpenRouter. Tente novamente mais tarde.',
        ASTRA_TIMEOUT: 'A geração excedeu o tempo de espera. Tente novamente mais tarde.',
        ASTRA_CONEXAO: 'Falha de conexão com o OpenRouter.',
        ASTRA_RESPOSTA_INVALIDA: 'Astra/OpenRouter retornou uma resposta inválida.',
        ASTRA_SEM_TEXTO: 'Astra não retornou uma legenda.',
        MODELO_NAO_PERMITIDO: 'Modelo indisponível na seleção atual. Atualize e escolha novamente.',
        CATALOGO_INDISPONIVEL: 'Não foi possível atualizar os modelos. Verifique a conexão.',
        CATALOGO_INVALIDO: 'O catálogo retornou um formato inesperado.',
        CATALOGO_VAZIO: 'Nenhum modelo compatível foi encontrado.',
        META_RECUSOU: 'A API Meta recusou a solicitação. Verifique permissões, formato e acesso público à mídia.',
        META_PERMISSAO: 'A Meta recusou a operação por falta de permissão.',
        META_LIMITE: 'A Meta limitou temporariamente as consultas. Aguarde e tente novamente.',
        META_CONEXAO: 'Falha de conexão com a Meta. Confira o Instagram antes de repetir um envio.',
        META_RESPOSTA_INVALIDA: 'A Meta retornou uma resposta inválida.',
        MIDIA_STORAGE_NAO_CONFIGURADO: 'O armazenamento público ainda não foi configurado no servidor.',
        MIDIA_FORMATO_INVALIDO: 'Use uma imagem JPEG, PNG ou WebP de até 5 MB.',
        MIDIA_PUBLICA_INACESSIVEL: 'A imagem foi salva, mas a URL HTTPS não pôde ser acessada externamente.',
        MIDIA_UPLOAD_FALHOU: 'Não foi possível enviar a imagem ao armazenamento público.',
        MIDIA_UPLOAD_RECUSADO: 'O servidor remoto recusou o arquivo.',
        MIDIA_UPLOAD_RESPOSTA_INVALIDA: 'O servidor remoto respondeu sem uma URL pública válida.',
        REEL_PROCESSAMENTO: 'Falha de processamento do vídeo. Verifique o formato e a disponibilidade.',
        REEL_TEMPO_ESGOTADO: 'O vídeo não terminou de processar no prazo.',
        PUBLICACAO_INDETERMINADA: 'A Meta não confirmou a publicação. Confira o Instagram antes de tentar novamente.',
        CARROSSEL_INVALIDO: 'Informe de 2 a 20 itens compatíveis, cada um com URL pública.',
        PLANO_NAO_ENCONTRADO: 'Plano ou item não encontrado no servidor.',
        PROMPT_INVALIDO: 'Informe um prompt textual válido.',
        METRICA_ID_INVALIDO: 'Informe um ID de mídia válido.',
        INSIGHTS_FALHA: 'Não foi possível consultar os insights desta mídia.',
        ORIGEM_RECUSADA: 'O servidor recusou a origem do painel. Abra pelo endereço local configurado.'
    };

    async function solicitar(rota, body, opcoes = {}) {
        if (!ROTAS.includes(rota)) throw new Error('Rota de integração não permitida.');
        const destino = new URL(rota, endereco);
        for (const [chave, valor] of Object.entries(opcoes.params || {})) if (valor !== undefined && valor !== null) destino.searchParams.set(chave, String(valor));
        if (rota === '/astra/models' && opcoes.atualizar) destino.searchParams.set('refresh', '1');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), opcoes.prazo || 10000);
        try {
            const resposta = await transporte(destino.href, {
                method: body === undefined ? 'GET' : 'POST', signal: controller.signal,
                headers: {
                    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                    ...(opcoes.id ? { 'X-Publicacao-Id': opcoes.id } : {}),
                    ...(opcoes.diagnosticoToken ? { 'X-Diagnostico-Token': opcoes.diagnosticoToken } : {})
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) })
            });
            let dados;
            try { dados = await resposta.json(); } catch { throw Object.assign(new Error('O servidor retornou uma resposta inválida.'), { codigo: 'RESPOSTA_INVALIDA' }); }
            if (!resposta.ok || dados.success === false) {
                const codigo = Object.hasOwn(mensagens, dados.code) ? dados.code : 'FALHA_SERVICO';
                const erroMidia = codigo.startsWith('MIDIA_') && typeof dados.error === 'string' ? dados.error.trim().slice(0, 400) : '';
                throw Object.assign(new Error(erroMidia || mensagens[codigo] || 'O serviço recusou a solicitação. Verifique o console do bridge.'), { codigo, status: resposta.status });
            }
            return dados;
        } catch (erro) {
            const seguro = erro.codigo ? erro : Object.assign(new Error(controller.signal.aborted ? 'Tempo de espera esgotado. Em publicações, confira o Instagram antes de repetir.' : 'Servidor local offline. Inicie o Astra Instagram para continuar.'), { codigo: controller.signal.aborted ? 'TEMPO_ESGOTADO' : 'OFFLINE' });
            console.warn('[Painel/Bridge]', { rota, codigo: seguro.codigo, status: seguro.status || 0 });
            throw seguro;
        } finally { clearTimeout(timer); }
    }
    return { solicitar };
}

const integracaoRegras = { urlPublica, urlPublicaHttps, tipoMidiaDefinido, sincronizarUrlsPublicas, midiasPublicasProntas, montarPrompt, assinaturaConteudo, validarInstagram, criarCliente };
if (typeof module !== 'undefined') module.exports = integracaoRegras;
else globalThis.IntegracaoRegras = integracaoRegras;
