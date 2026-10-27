'use strict';

/*
 * ASTRA ↔ INSTAGRAM — ROUTER HTTP
 *
 * Fino por design: valida origem, corpo e sessão, e delega tudo aos serviços.
 * Nenhuma regra de Instagram, IA, mídia ou agendamento vive aqui.
 *
 * Start: node --env-file=.env server.js
 */

const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { URL } = require('node:url');

const { servirPainel } = require('./painel-meta-prototipo/servidor');
const { erroSeguro, ocultarSegredos, autorizarOrigem, publicarUmaVez } = require('./bridge-seguranca');
const { instalarEncerramento } = require('./encerramento-servidor');
const diagnostico = require('./diagnostico');

const { config, capacidades, storeIntegracoes, recarregarIntegracoes } = require('./services/config');
const { criarFacebookService } = require('./services/facebook-service');
const { criarCofreLocal } = require('./services/cofre-local');
const { criarMetaConexaoService } = require('./services/meta-conexao-service');
const { criarSessoesLocais } = require('./services/sessao-local');
const { criarAIService } = require('./services/ai-service');
const { criarMediaService } = require('./services/media-service');
const { LIMITE_VIDEO } = require('./midia-publica');
const { criarInstagramService } = require('./services/instagram-service');
const { criarInsightsService } = require('./services/insights-service');
const { criarMotor, criarArmazenamentoArquivo, publicarItemNoInstagram } = require('./services/scheduler-service');
const { criarStoreEmpresa } = require('./services/empresa-store');
const { criarStorePublicacoesMeta } = require('./services/publicacao-meta-store');
const { criarStoreTemplates } = require('./services/templates-store');
const { criarStorePublicacoes } = require('./services/publicacoes-store');
const { criarStoreBibliotecaMidias, reconciliarMidias } = require('./services/biblioteca-midias-store');
const { criarLogsService } = require('./services/logs-service');

// Correlaciona operações disparadas por uma requisição sem gravar conteúdo.
const contextoOperacao = new AsyncLocalStorage();

// ============================================================
// SERVIÇOS
// ============================================================

const storeEmpresa = criarStoreEmpresa(config.arquivos.empresa);
const storePublicacoesMeta = criarStorePublicacoesMeta(config.arquivos.publicacoesMeta);
const storeTemplates = criarStoreTemplates(config.arquivos.templates);
const storePublicacoes = criarStorePublicacoes(config.arquivos.publicacoes);
const storeBibliotecaMidias = criarStoreBibliotecaMidias(config.arquivos.bibliotecaMidias);
const logs = criarLogsService({ diretorio: process.env.ASTRA_LOGS_DIR || path.join(path.dirname(config.arquivos.empresa), 'logs') });
/** Atalho de logging que nunca lança. */
const registrarLog = entrada => logs.registrar(entrada);

/** Recusa sucesso HTTP quando a gravação durável não pôde ser confirmada. */
function exigirPersistencia(resultado, nome) {
    if (resultado === null) throw erroSeguro('PERSISTENCIA_FALHOU', `Não foi possível salvar ${nome} no backend.`, 500);
    return resultado;
}

let aiService = criarAIService({
    ia: config.ia,
    registrar: (secao, evento, dados) => diagnostico.registrar(secao, evento, dados),
    contexto: () => contextoOperacao.getStore() || {}
});

const mediaService = criarMediaService({ midia: config.midia });

/** Instancia o InstagramService apenas quando há token; sem token, falha seguro. */
let instagramService = null;
if (config.instagram.token) {
    instagramService = criarInstagramService({
        token: config.instagram.token,
        accountId: config.instagram.accountId,
        baseUrl: config.instagram.baseUrl,
        versao: config.instagram.versao,
        registrar: (secao, evento, dados) => diagnostico.registrar(secao, evento, dados),
        contexto: () => contextoOperacao.getStore() || {}
    });
}

// InsightsService (publicações anteriores + métricas orgânicas) só existe com Instagram configurado.
let insightsService = instagramService
    ? criarInsightsService({ instagram: instagramService, caminhoCache: config.arquivos.metricas })
    : null;

// O scheduler reutiliza o adaptador único do SchedulerService, que chama
// InstagramService.publish() exatamente como a publicação imediata.
const publicadorAgenda = async (...args) => {
    if (args[0].destino === 'Facebook Page') {
        const { item } = args[0];
        if (!item.facebookPageId || item.facebookPageId !== config.facebook.pageId) throw erroSeguro('META_PAGINA_INVALIDA', 'A Página da agenda mudou. Revise e aprove novamente o plano.', 409);
        await metaConexao.verificar(); metaConexao.exigirPublicacao(config.facebook.pageId);
        const entrada = { formato: item.tipo === 'video' ? 'reel' : item.tipo === 'carrossel' ? 'carrossel' : 'imagem', itens: item.itens, mediaUrl: item.url, caption: item.legenda || '' };
        const resultado = await facebookService.publish(entrada, `agenda:${item.id}`);
        return { id: resultado.mediaId };
    }
    if (!instagramService) throw erroSeguro('INSTAGRAM_NAO_CONFIGURADO', 'Instagram não configurado no servidor.', 503);
    return publicarItemNoInstagram(instagramService, storePublicacoesMeta)(...args);
};
let facebookService = criarFacebookService({ ...config.facebook, store: storePublicacoesMeta });
const publicacoesEmAndamento = new Set();
const sessoesLocais = criarSessoesLocais();
const metaConexao = criarMetaConexaoService({
    cofre: criarCofreLocal(process.env.ASTRA_META_CONEXAO_ARQUIVO || path.join(__dirname, 'dados', 'meta-conexao.json')),
    configuracao: () => ({ appId: process.env.META_APP_ID || '', secret: process.env.META_APP_SECRET || '', configId: process.env.META_LOGIN_CONFIG_ID || '', redirect: process.env.META_REDIRECT_URI || '', versao: process.env.FACEBOOK_GRAPH_VERSION || '' }),
    aoSelecionar: (pagina, versao) => {
        exigirIntegracoesLivres();
        storeIntegracoes.salvar({ FACEBOOK_PAGE_ID: pagina.id, FACEBOOK_PAGE_ACCESS_TOKEN: pagina.access_token, FACEBOOK_GRAPH_VERSION: versao });
        atualizarIntegracoes();
    },
    aoDesconectar: () => { exigirIntegracoesLivres(); storeIntegracoes.limparFacebook(); atualizarIntegracoes(); },
    registrar: diagnostico.registrar
});

/** Não troca credenciais no meio de uma publicação ou ciclo da agenda. */
function exigirIntegracoesLivres() {
    if (publicacoesEmAndamento.size || schedulerService.listarPlanos().some(p => p.itens?.some(i => i.status === 'em andamento'))) throw erroSeguro('CONFIG_EM_USO', 'Aguarde o envio em andamento antes de alterar a conexão.', 409);
}

/** Recria clientes após salvar configurações, preservando o serviço de mídia. */
function atualizarIntegracoes() {
    recarregarIntegracoes();
    aiService = criarAIService({ ia: config.ia, registrar: diagnostico.registrar, contexto: () => contextoOperacao.getStore() || {} });
    instagramService = config.instagram.token ? criarInstagramService({ ...config.instagram, registrar: diagnostico.registrar, contexto: () => contextoOperacao.getStore() || {} }) : null;
    insightsService = instagramService ? criarInsightsService({ instagram: instagramService, caminhoCache: config.arquivos.metricas }) : null;
    facebookService = criarFacebookService({ ...config.facebook, store: storePublicacoesMeta });
}

const schedulerService = criarMotor({
    armazenamento: criarArmazenamentoArquivo(config.arquivos.agendador),
    publicador: publicadorAgenda,
    registrar: (secao, evento, dados) => diagnostico.registrar(secao, evento, dados)
});

// ============================================================
// HELPERS HTTP
// ============================================================

function sendJSON(res, statusCode, data) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data, (_chave, valor) => ocultarSegredos(valor), 2));
}

async function readJSONBody(req) {
    return new Promise((resolve, reject) => {
        const partes = [];
        let tamanho = 0;
        let excedido = false;
        req.on('data', chunk => {
            if (excedido) return;
            tamanho += chunk.length;
            const caminho = req.url?.split('?')[0];
            const limite = caminho === '/media/upload' ? Math.ceil(LIMITE_VIDEO / 3) * 4 + 65536 : caminho === '/astra/generate' ? 12_000_000 : 1_000_000;
            if (tamanho > limite) {
                excedido = true;
                const ctx = contextoOperacao.getStore() || {};
                diagnostico.registrar('BACKEND', 'payload_too_large', { rota: caminho, operationId: ctx.operationId || null, limitBytes: limite, result: 'falhou', errorCode: 'CORPO_EXCESSIVO' });
                reject(erroSeguro('CORPO_EXCESSIVO', 'Solicitação excede o limite permitido.', 413));
                req.destroy();
                return;
            }
            partes.push(chunk);
        });
        req.on('end', () => {
            if (excedido) return;
            const body = Buffer.concat(partes).toString('utf8');
            if (!body) { resolve({}); return; }
            try {
                const dados = JSON.parse(body);
                if (!dados || typeof dados !== 'object' || Array.isArray(dados)) throw new Error();
                resolve(dados);
            } catch { reject(erroSeguro('JSON_INVALIDO', 'Envie um objeto JSON válido.', 400)); }
        });
        req.on('error', reject);
    });
}

const limitesDiagnostico = new Map();
function limitarDiagnostico(req, maximo = 120, janelaMs = 60000) {
    const chave = req.socket?.remoteAddress || 'local';
    const agora = Date.now();
    const historico = (limitesDiagnostico.get(chave) || []).filter(instante => agora - instante < janelaMs);
    if (historico.length >= maximo) throw erroSeguro('DIAGNOSTICO_LIMITE', 'Muitos eventos de diagnóstico em pouco tempo. Aguarde antes de tentar novamente.', 429);
    historico.push(agora);
    limitesDiagnostico.set(chave, historico);
}

const CAMPOS_TEMPLATE = ['hashtags', 'palavras', 'ideias', 'local', 'maps', 'site1', 'site2'];

function sanitizarTemplateEmpresa(valor) {
    const bruto = valor && typeof valor === 'object' && !Array.isArray(valor) ? valor : {};
    const template = {};
    for (const campo of CAMPOS_TEMPLATE) template[campo] = typeof bruto[campo] === 'string' ? bruto[campo].slice(0, 5000) : '';
    const incluir = bruto.incluir && typeof bruto.incluir === 'object' && !Array.isArray(bruto.incluir) ? bruto.incluir : {};
    template.incluir = { local: incluir.local === true, maps: incluir.maps === true, site1: incluir.site1 === true, site2: incluir.site2 === true };
    return template;
}

function sanitizarAgendaEmpresa(valor) {
    const bruto = valor && typeof valor === 'object' && !Array.isArray(valor) ? valor : {};
    const agenda = {};
    for (const campo of ['data', 'hora', 'fuso', 'preferencia']) agenda[campo] = typeof bruto[campo] === 'string' ? bruto[campo].slice(0, 60) : '';
    if (bruto.republicacao && typeof bruto.republicacao === 'object' && !Array.isArray(bruto.republicacao)) agenda.republicacao = bruto.republicacao;
    return agenda;
}

/** Remove miniaturas e mídias embutidas antes de persistir um plano. */
function normalizarPlanoRecebido(plano = {}) {
    const limparUrl = valor => typeof valor === 'string' && /^https?:\/\//i.test(valor) ? valor : null;
    return {
        id: typeof plano.id === 'string' ? plano.id.slice(0, 100) : null,
        status: typeof plano.status === 'string' ? plano.status.slice(0, 40) : 'rascunho',
        aprovadoEm: typeof plano.aprovadoEm === 'string' ? plano.aprovadoEm : null,
        timezone: typeof plano.timezone === 'string' ? plano.timezone.slice(0, 60) : null,
        config: plano.config && typeof plano.config === 'object' ? { ...plano.config, miniatura: undefined } : null,
        itens: (Array.isArray(plano.itens) ? plano.itens : []).slice(0, 200).map(item => ({
            id: typeof item.id === 'string' ? item.id.slice(0, 160) : null,
            mediaId: typeof item.mediaId === 'string' ? item.mediaId.slice(0, 100) : null,
            tipo: ['imagem', 'video', 'carrossel'].includes(item.tipo) ? item.tipo : 'imagem',
            data: item.data, hora: item.hora,
            timezone: typeof item.timezone === 'string' ? item.timezone.slice(0, 60) : (typeof plano.timezone === 'string' ? plano.timezone.slice(0, 60) : null),
            destinos: Array.isArray(item.destinos) ? item.destinos.filter(d => ['Instagram', 'Instagram Feed', 'Instagram Story', 'Facebook Page'].includes(d)) : ['Instagram Feed'],
            facebookPageId: typeof item.facebookPageId === 'string' && /^\d+$/.test(item.facebookPageId) ? item.facebookPageId : null,
            legenda: typeof item.legenda === 'string' ? item.legenda.slice(0, 5000) : '',
            status: typeof item.status === 'string' ? item.status.slice(0, 40) : 'rascunho',
            approvalSignature: typeof item.approvalSignature === 'string' ? item.approvalSignature : null,
            atraso: item.atraso === 'publicar' ? 'publicar' : 'reagendar',
            toleranciaMinutos: Number.isFinite(Number(item.toleranciaMinutos)) ? Number(item.toleranciaMinutos) : 30,
            url: limparUrl(item.url),
            itens: (Array.isArray(item.itens) ? item.itens : []).slice(0, 20).map(entrada => ({ mediaId: entrada.mediaId, ordem: Number(entrada.ordem) || 0, tipo: entrada.tipo === 'video' ? 'video' : 'imagem', url: limparUrl(entrada.url) })),
            resultados: {}
        })).filter(item => item.id)
    };
}

/** Mantém apenas os dados recorrentes da empresa, sem inventar campos. */
function sanitizarRecorrentes(valor) {
    const bruto = valor && typeof valor === 'object' && !Array.isArray(valor) ? valor : {};
    const texto = campo => typeof bruto[campo] === 'string' ? bruto[campo].slice(0, 5000) : '';
    const hashtags = String(bruto.hashtagsPadrao || '').trim().split(/\s+/).filter(tag => /^#[\p{L}\p{N}_]+$/u.test(tag));
    return {
        site: texto('site'),
        maps: texto('maps'),
        linksAdicionais: texto('linksAdicionais'),
        hashtagsPadrao: hashtags.join(' '),
        informacoesAdicionais: texto('informacoesAdicionais'),
        chamadasFixas: texto('chamadasFixas'),
        templateTexto: texto('templateTexto')
    };
}

/** Normaliza um template nomeado sem aceitar campos arbitrários. */
function sanitizarTemplateBiblioteca(valor) {
    const bruto = valor && typeof valor === 'object' && !Array.isArray(valor) ? valor : {};
    const texto = (campo, limite = 10000) => typeof bruto[campo] === 'string' ? bruto[campo].slice(0, limite) : '';
    return {
        id: /^[A-Za-z0-9_.:-]{1,160}$/.test(String(bruto.id || '')) ? bruto.id : null,
        nome: texto('nome', 120).trim() || 'Template sem nome', texto: texto('texto'), hashtags: texto('hashtags', 5000),
        ...Object.fromEntries(['objetivo', 'tema', 'fatos', 'contexto', 'fatosIa', 'textoMidia', 'palavras', 'ideias', 'hashtagsPublicacao'].map(campo => [campo, texto(campo)])),
        local: texto('local', 1000), site1: texto('site1', 1000), site2: texto('site2', 1000),
        site: texto('site', 1000), maps: texto('maps', 1000), linksAdicionais: texto('linksAdicionais', 5000),
        informacoesAdicionais: texto('informacoesAdicionais', 5000), chamadasFixas: texto('chamadasFixas', 5000),
        incluir: Object.fromEntries(['local', 'maps', 'site1', 'site2', 'site'].map(campo => [campo, bruto.incluir?.[campo] === true])),
        aplicarAutomatico: bruto.aplicarAutomatico === true
    };
}

// ============================================================
// ROTEAMENTO
// ============================================================

async function tratarRequisicao(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    console.log(`[HTTP] ${req.method} ${url.pathname}`);
    res.on('finish', () => console.log(`[HTTP] ${url.pathname} status=${res.statusCode}`));
    try {
        autorizarOrigem(req, res);

        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
        if (req.method === 'GET' && url.pathname === '/meta/conexao') {
            const sessao = sessoesLocais.iniciar(req, res);
            sendJSON(res, 200, { success: true, csrf: sessao.csrf, conexao: metaConexao.status(`http://${req.headers.host}`), erroConexao: sessao.erroConexao || null }); return;
        }
        if (req.method === 'GET' && url.pathname === '/meta/oauth/retorno') {
            res.setHeader('Referrer-Policy', 'no-referrer');
            const sessao = sessoesLocais.obter(req);
            try {
                exigirIntegracoesLivres();
                if (!sessao) throw erroSeguro('SESSAO_INVALIDA', 'Sessão expirada. Reabra o Astra.', 403);
                await metaConexao.retorno(sessao.id, Object.fromEntries(url.searchParams), `http://${req.headers.host}`);
                sessoesLocais.falhar(req, null);
                res.writeHead(303, { Location: '/painel/?meta=conectado' }); res.end();
            } catch (erro) {
                // Retorno limpo: nunca inclui code, state, tokens ou mensagens da Meta na URL.
                diagnostico.registrar('META', 'oauth_failed', { errorCode: erro.codigo || 'FALHA_INTERNA', result: 'falhou' });
                sessoesLocais.falhar(req, erro.seguro ? erro.message : 'Não foi possível concluir a conexão. Verifique a configuração e tente novamente.');
                res.writeHead(303, { Location: '/painel/?meta=falhou' }); res.end();
            }
            return;
        }

        if (url.pathname === '/painel') { res.writeHead(302, { Location: '/painel/' }); res.end(); return; }
        if (url.pathname.startsWith('/painel/')) { servirPainel(req, res, url.pathname.slice('/painel'.length)); return; }
        if (req.method === 'POST' && !req.headers['content-type']?.toLowerCase().startsWith('application/json')) {
            throw erroSeguro('TIPO_INVALIDO', 'Envie a solicitação como application/json.', 415);
        }
        if (req.method === 'POST' && (url.pathname.startsWith('/meta/oauth/') || url.pathname === '/config/integracoes')) sessoesLocais.exigir(req);
        if (req.method === 'POST' && url.pathname.startsWith('/meta/oauth/')) {
            exigirIntegracoesLivres();
            const body = await readJSONBody(req);
            const sessao = sessoesLocais.obter(req);
            let resultado;
            if (url.pathname === '/meta/oauth/iniciar') resultado = metaConexao.iniciar(sessao.id, `http://${req.headers.host}`);
            else if (url.pathname === '/meta/oauth/verificar') resultado = { conexao: await metaConexao.verificar() };
            else if (url.pathname === '/meta/oauth/selecionar') resultado = { conexao: await metaConexao.selecionar(body.pageId) };
            else if (url.pathname === '/meta/oauth/desconectar') resultado = { conexao: await metaConexao.desconectar(body.revogar === true) };
            else throw erroSeguro('ROTA_INVALIDA', 'Operação de conexão inexistente.', 404);
            sendJSON(res, 200, { success: true, ...resultado }); return;
        }

        // ------------------------------------------------
        // RAIZ / HEALTH
        // ------------------------------------------------

        if (req.method === 'GET' && url.pathname === '/') {
            sendJSON(res, 200, {
                name: 'Astra Instagram',
                status: 'online',
                endpoints: {
                    health: 'GET /health',
                    instagramProfile: 'GET /meta/me',
                    mediaCapabilities: 'GET /media/upload/capabilities',
                    mediaUpload: 'POST /media/upload',
                    aiModels: 'GET /astra/models',
                    aiGenerate: 'POST /astra/generate',
                    publish: 'POST /instagram/publish',
                    schedulerPlans: 'GET/POST /agenda/planos',
                    schedulerRun: 'POST /agenda/executar',
                    schedulerPause: 'POST /agenda/pausar',
                    schedulerResume: 'POST /agenda/retomar',
                    schedulerReschedule: 'POST /agenda/reagendar',
                    schedulerCancel: 'POST /agenda/cancelar',
                    companyConfig: 'GET /empresa/config',
                    companyTemplate: 'POST /empresa/template',
                    companyAgenda: 'POST /empresa/agenda',
                    companyTemplatePadrao: 'GET/POST /empresa/template-padrao',
                    companyRecorrentes: 'GET/POST /empresa/recorrentes',
                    instagramPreviousMedia: 'GET /instagram/media',
                    instagramMetricsUpdate: 'POST /instagram/metrics/update',
                    instagramAnalysis: 'GET /instagram/analysis',
                    diagnostics: 'GET /diagnostico/status',
                    logs: 'GET /logs · GET /logs/resumo · POST /logs/event'
                }
            });
            return;
        }

        if (req.method === 'GET' && url.pathname === '/health') {
            const c = capacidades();
            sendJSON(res, 200, {
                status: 'ok',
                server: 'Astra Instagram',
                node: process.version,
                buildId: config.build,
                timezone: config.timezone,
                model: config.ia.modelo,
                instagramConfigured: c.instagram,
                aiConfigured: c.ia,
                mediaStorageConfigured: c.midia,
                timestamp: new Date().toISOString()
            });
            return;
        }

        // ------------------------------------------------
        // INSTAGRAM
        // ------------------------------------------------

        if (url.pathname === '/config/integracoes' && ['GET', 'POST'].includes(req.method)) {
            if (req.method === 'POST') {
                exigirIntegracoesLivres();
                storeIntegracoes.salvar(await readJSONBody(req));
                atualizarIntegracoes();
            }
            sendJSON(res, 200, { success: true, configuracoes: storeIntegracoes.publico() });
            return;
        }
        if (req.method === 'GET' && url.pathname === '/facebook/me') {
            sendJSON(res, 200, { success: true, profile: await metaConexao.testarPagina() });
            return;
        }

        // ------------------------------------------------
        // LOGS (atividade e erros persistentes)
        // ------------------------------------------------

        if (req.method === 'GET' && url.pathname === '/logs/resumo') {
            if (!sessoesLocais.obter(req)) throw erroSeguro('SESSAO_INVALIDA', 'Reabra o painel para acessar os logs.', 403);
            sendJSON(res, 200, { success: true, ...logs.resumo() });
            return;
        }

        if (req.method === 'GET' && url.pathname === '/logs') {
            if (!sessoesLocais.obter(req)) throw erroSeguro('SESSAO_INVALIDA', 'Reabra o painel para acessar os logs.', 403);
            const filtros = {
                desde: url.searchParams.get('desde') || undefined,
                ate: url.searchParams.get('ate') || undefined,
                nivel: url.searchParams.get('nivel') || undefined,
                modulo: url.searchParams.get('modulo') || undefined,
                plataforma: url.searchParams.get('plataforma') || undefined,
                status: url.searchParams.get('status') || undefined,
                operationId: url.searchParams.get('operationId') || undefined,
                busca: url.searchParams.get('busca') || undefined,
                pagina: url.searchParams.get('pagina') || undefined,
                limite: url.searchParams.get('limite') || undefined
            };
            sendJSON(res, 200, { success: true, ...logs.consultar(filtros), filtrosDisponiveis: { modulos: logs.valoresUnicos('modulo'), plataformas: logs.valoresUnicos('plataforma'), status: logs.valoresUnicos('status'), niveis: logs.NIVEIS } });
            return;
        }

        if (req.method === 'POST' && url.pathname === '/logs/event') {
            sessoesLocais.exigir(req);
            const body = await readJSONBody(req);
            const eventos = Array.isArray(body.eventos) ? body.eventos.slice(0, 50) : [body];
            for (const item of eventos) {
                if (!item || typeof item !== 'object') continue;
                logs.registrar({
                    nivel: item.nivel, modulo: item.modulo, acao: item.acao, status: item.status,
                    operationId: item.operationId, plataforma: item.plataforma, superficie: item.superficie,
                    mensagem: item.mensagem, codigo: item.codigo, httpStatus: item.httpStatus,
                    contexto: item.contexto, timezone: item.timezone, stack: item.stack, ator: item.ator
                });
            }
            sendJSON(res, 200, { success: true, registrados: eventos.length });
            return;
        }
        if (req.method === 'GET' && url.pathname === '/meta/me') {
            if (!instagramService) throw erroSeguro('INSTAGRAM_NAO_CONFIGURADO', 'Instagram não configurado no servidor.', 503);
            const profile = await instagramService.perfil();
            sendJSON(res, 200, {
                success: true,
                profile: Object.fromEntries(['id', 'username', 'account_type', 'media_count'].filter(campo => profile[campo] !== undefined).map(campo => [campo, profile[campo]])),
                publishingAccountId: config.instagram.accountId || profile.id
            });
            return;
        }

        if (req.method === 'POST' && url.pathname === '/instagram/publish') {
            const body = await readJSONBody(req);
            const { instagram: enviarInstagram, facebook: enviarFacebook, instagramStory: enviarStoryInstagram, facebookStory: enviarStoryFacebook } = require('./painel-meta-prototipo/integracao-regras').destinosPublicacao(body);
            const ctxPublish = contextoOperacao.getStore() || {};
            const destinosSolicitados = [enviarInstagram && 'instagram:feed', enviarStoryInstagram && 'instagram:story', enviarFacebook && 'facebook:feed', enviarStoryFacebook && 'facebook:story'].filter(Boolean);
            registrarLog({ nivel: 'INFO', modulo: 'PUBLISH', acao: 'publicar_agora_clique', status: 'iniciado', operationId: body.publicationId || ctxPublish.operationId, plataforma: 'multiplataforma', contexto: { destinos: destinosSolicitados, formato: body.formato || 'imagem' } });
            if (!enviarInstagram && !enviarFacebook && !enviarStoryInstagram && !enviarStoryFacebook) { registrarLog({ nivel: 'WARNING', modulo: 'PUBLISH', acao: 'publicar_agora_bloqueado', status: 'sem_destino', operationId: body.publicationId || ctxPublish.operationId, mensagem: 'Nenhum destino selecionado.' }); throw erroSeguro('DESTINO_OBRIGATORIO', 'Selecione ao menos um Feed ou Story.', 400); }
            if ((enviarInstagram || enviarStoryInstagram) && !instagramService) throw erroSeguro('INSTAGRAM_NAO_CONFIGURADO', 'Instagram não configurado no servidor.', 503);
            const formato = body.formato === 'reel' ? 'reel' : body.formato === 'carrossel' ? 'carrossel' : body.formato === 'story' ? 'story' : 'imagem';
            if (body.caption !== undefined && typeof body.caption !== 'string') throw erroSeguro('LEGENDA_INVALIDA', 'A legenda deve ser um texto.', 400);
            const entrada = formato === 'carrossel'
                ? { formato, itens: (Array.isArray(body.itens) ? body.itens : []).slice(0, 20), caption: body.caption || '' }
                : { formato, mediaUrl: body.mediaUrl, imageUrl: body.imageUrl, videoUrl: body.videoUrl, caption: body.caption || '', ...(formato === 'story' ? { storyTipo: body.storyTipo === 'video' ? 'video' : 'imagem' } : {}) };
            if ((enviarStoryInstagram || enviarStoryFacebook) && formato === 'carrossel') throw erroSeguro('STORY_CARROSSEL_NAO_SUPORTADO', 'Stories exigem uma única imagem ou vídeo.', 400);
            if (enviarStoryInstagram) {
                const perfilStory = await instagramService.perfil();
                if (String(perfilStory.account_type || '').toUpperCase() !== 'BUSINESS') throw erroSeguro('STORY_REQUER_BUSINESS', 'Story Instagram exige uma conta Business.', 403);
            }
            if (enviarStoryFacebook) { await metaConexao.verificar(); metaConexao.exigirPublicacao(config.facebook.pageId); facebookService.validarStory(entrada); }
            if (enviarFacebook) { await metaConexao.verificar(); metaConexao.exigirPublicacao(config.facebook.pageId); facebookService.validar(entrada); }
            if ((enviarFacebook || enviarStoryFacebook) && body.facebookPageId && body.facebookPageId !== config.facebook.pageId) throw erroSeguro('META_PAGINA_INVALIDA', 'A Página mudou após a confirmação. Revise o destino novamente.', 409);
            const publicacaoId = typeof body.publicationId === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(body.publicationId) ? body.publicationId : null;
            if ((enviarFacebook || enviarStoryFacebook) && !publicacaoId) throw erroSeguro('IDENTIFICADOR_INVALIDO', 'Salve a publicação antes de enviar ao Facebook.', 400);
            const resultado = await publicarUmaVez(req, body, async () => {
                const trava = publicacaoId || 'sem-id';
                if (publicacoesEmAndamento.has(trava)) throw erroSeguro('PUBLICACAO_EM_ANDAMENTO', 'Esta publicação já está em andamento.', 409);
                publicacoesEmAndamento.add(trava);
                try {
                const resultadosPublicacao = {};
                /** Publica um destino usando estado persistido próprio para retry. */
                async function publicarDestino(destino, dados, containerInformado = null) {
                    const chave = publicacaoId ? `${publicacaoId}:${destino}` : null;
                    const assinatura = crypto.createHash('sha256').update(JSON.stringify(dados)).digest('hex');
                    const salvo = chave ? (storePublicacoesMeta.obter(chave) || (destino === 'feed' ? storePublicacoesMeta.obter(publicacaoId) : null)) : null;
                    if (salvo?.assinatura && salvo.assinatura !== assinatura && !['ERROR', 'EXPIRED'].includes(salvo.estadoContainer)) throw erroSeguro('PUBLICACAO_DIVERGENTE', `O conteúdo do destino ${destino} mudou enquanto existe um contêiner Meta pendente.`, 409);
                    const [rede, superficie] = destino.split(':');
                    registrarLog({ nivel: 'INFO', modulo: 'PUBLISH', acao: 'tentativa_inicio', status: 'enviando', operationId: chave || publicacaoId, plataforma: rede, superficie: superficie || (destino === 'story' ? 'story' : 'feed'), contexto: { formato: dados.formato } });
                    const publicado = await instagramService.publish({
                        ...dados, publicacaoId: chave || publicacaoId,
                        containerId: salvo?.assinatura === assinatura ? salvo.containerId : containerInformado,
                        mediaIdConhecido: salvo?.assinatura === assinatura ? salvo.mediaId : null,
                        aoEstado: estado => { if (chave) storePublicacoesMeta.salvar(chave, { assinatura, formato: dados.formato, ...estado }); }
                    });
                    resultadosPublicacao[destino] = { estado: 'confirmada', idPublicado: publicado.mediaId, containerId: publicado.containerId };
                    registrarLog({ nivel: 'INFO', modulo: 'PUBLISH', acao: 'tentativa_sucesso', status: 'publicado', operationId: chave || publicacaoId, plataforma: rede, superficie: superficie || (destino === 'story' ? 'story' : 'feed'), contexto: { mediaId: publicado.mediaId } });
                    return publicado;
                }

                const containerFeed = typeof body.containerId === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(body.containerId) ? body.containerId : null;
                let publicacao = enviarInstagram ? await publicarDestino(formato === 'story' ? 'story' : 'feed', entrada, containerFeed) : null;
                if (enviarStoryInstagram && !(enviarInstagram && formato === 'story')) {
                    if (formato === 'carrossel') throw erroSeguro('STORY_CARROSSEL_NAO_SUPORTADO', 'Carrossel não é convertido automaticamente em Stories.', 400);
                    const story = formato === 'reel'
                        ? { formato: 'story', videoUrl: body.videoUrl || body.mediaUrl, storyTipo: 'video' }
                        : { formato: 'story', imageUrl: body.imageUrl || body.mediaUrl, storyTipo: 'imagem' };
                    try { const publicada = await publicarDestino('story', story, body.storyContainerId); if (!publicacao) publicacao = publicada; }
                    catch (erro) { erro.resultadosPublicacao = resultadosPublicacao; erro.destinoPublicacao = 'story'; registrarLog({ nivel: 'ERROR', modulo: 'PUBLISH', acao: 'tentativa_falha', status: 'falhou', operationId: publicacaoId, plataforma: 'instagram', superficie: 'story', codigo: erro.codigo, httpStatus: erro.status, mensagem: erro.message }); throw erro; }
                }
                let publicacaoFacebook;
                if (enviarFacebook) {
                    try {
                        publicacaoFacebook = await facebookService.publish(entrada, publicacaoId);
                        resultadosPublicacao.facebook = { estado: 'confirmada', idPublicado: publicacaoFacebook.mediaId };
                    } catch (erro) { erro.resultadosPublicacao = resultadosPublicacao; erro.destinoPublicacao = 'facebook'; registrarLog({ nivel: 'ERROR', modulo: 'PUBLISH', acao: 'tentativa_falha', status: 'falhou', operationId: publicacaoId, plataforma: 'facebook', superficie: 'feed', codigo: erro.codigo, httpStatus: erro.status, mensagem: erro.message }); throw erro; }
                }
                if (enviarStoryFacebook) {
                    try {
                        const storyFacebook = await facebookService.publicarStory(entrada, publicacaoId);
                        resultadosPublicacao.facebookStory = { estado: 'confirmada', idPublicado: storyFacebook.mediaId };
                        if (!publicacaoFacebook) publicacaoFacebook = storyFacebook;
                    } catch (erro) { erro.resultadosPublicacao = resultadosPublicacao; erro.destinoPublicacao = 'facebookStory'; registrarLog({ nivel: 'ERROR', modulo: 'PUBLISH', acao: 'tentativa_falha', status: 'falhou', operationId: publicacaoId, plataforma: 'facebook', superficie: 'story', codigo: erro.codigo, httpStatus: erro.status, mensagem: erro.message }); throw erro; }
                }
                if (!publicacao) { registrarLog({ nivel: 'INFO', modulo: 'PUBLISH', acao: 'tentativa_concluida', status: Object.keys(resultadosPublicacao).length > 1 ? 'sucesso_parcial' : 'publicado', operationId: publicacaoId, contexto: { resultados: resultadosPublicacao } }); return { success: true, published: { id: publicacaoFacebook.mediaId }, media_id: publicacaoFacebook.mediaId, published_at: publicacaoFacebook.publicadoEm, formato, resultadosPublicacao }; }
                let permalink = null; let publicadoEm = publicacao.publicadoEm;
                try {
                    const detalhe = await instagramService.detalheMidia(publicacao.mediaId);
                    permalink = detalhe.permalink; publicadoEm = detalhe.publicadoEm || publicadoEm;
                } catch { /* permalink é opcional; o sucesso já foi confirmado pelo media_id */ }
                if (insightsService) {
                    insightsService.registrarPublicacaoMidia({ id: publicacao.mediaId, formato: publicacao.formato, publicadoEm, permalink });
                }
                console.log(`[HTTP] /instagram/publish media_id=${publicacao.mediaId}`);
                registrarLog({ nivel: 'INFO', modulo: 'PUBLISH', acao: 'tentativa_concluida', status: Object.keys(resultadosPublicacao).length > 1 || Object.keys(resultadosPublicacao).some(d => resultadosPublicacao[d].estado !== 'confirmada') ? 'sucesso_parcial' : 'publicado', operationId: publicacaoId, contexto: { resultados: resultadosPublicacao } });
                return { success: true, containerId: publicacao.containerId, published: { id: publicacao.mediaId }, media_id: publicacao.mediaId, permalink, published_at: publicadoEm, formato: publicacao.formato, resultadosPublicacao };
                } finally { publicacoesEmAndamento.delete(trava); }
            });
            sendJSON(res, 200, resultado);
            return;
        }

        // ------------------------------------------------
        // PUBLICAÇÕES ANTERIORES / MÉTRICAS ORGÂNICAS / ANÁLISE
        // ------------------------------------------------

        if (req.method === 'GET' && url.pathname === '/instagram/media') {
            if (!insightsService) throw erroSeguro('INSTAGRAM_NAO_CONFIGURADO', 'Instagram não configurado no servidor.', 503);
            const pagina = await insightsService.listarMidias({ limite: url.searchParams.get('limite'), cursor: url.searchParams.get('cursor') });
            sendJSON(res, 200, { success: true, ...pagina });
            return;
        }

        if (req.method === 'POST' && url.pathname === '/instagram/metrics/update') {
            if (!insightsService) throw erroSeguro('INSTAGRAM_NAO_CONFIGURADO', 'Instagram não configurado no servidor.', 503);
            const body = await readJSONBody(req);
            const itens = (Array.isArray(body.itens) ? body.itens : [])
                .filter(item => item && /^[A-Za-z0-9_.-]{1,200}$/.test(String(item.id || '')))
                .slice(0, 100)
                .map(item => ({ id: String(item.id), formato: typeof item.formato === 'string' ? item.formato.slice(0, 20) : null, publicadoEm: typeof item.publicadoEm === 'string' ? item.publicadoEm : null, permalink: typeof item.permalink === 'string' ? item.permalink.slice(0, 500) : '' }));
            const resultado = await insightsService.atualizarMetricas(itens, { forcar: body.forcar === true });
            sendJSON(res, 200, { success: true, ...resultado, total: insightsService.metricas().length });
            return;
        }

        if (req.method === 'GET' && url.pathname === '/instagram/analysis') {
            if (!insightsService) throw erroSeguro('INSTAGRAM_NAO_CONFIGURADO', 'Instagram não configurado no servidor.', 503);
            const timezone = url.searchParams.get('timezone') || config.timezone;
            sendJSON(res, 200, { success: true, ...insightsService.analisar({ timezone }) });
            return;
        }

        // ------------------------------------------------
        // MÍDIA
        // ------------------------------------------------

        if (req.method === 'GET' && url.pathname === '/media/upload/capabilities') {
            sendJSON(res, 200, { success: true, ...mediaService.capacidades() });
            return;
        }

        if (req.method === 'POST' && url.pathname === '/media/upload') {
            const body = await readJSONBody(req);
            try {
                const midia = await mediaService.enviar({ dados: body.dados, mime: body.mime, nome: body.nome });
                sendJSON(res, 201, { success: true, id: body.id || null, public_url: midia.url, media_type: midia.mime === 'video/mp4' ? 'video' : 'image', filename: midia.arquivo, mime: midia.mime, bytes: midia.bytes, sha256: midia.sha256, verified_at: midia.verificadaEm });
            } catch (erro) {
                throw erroSeguro(erro.code || 'MIDIA_UPLOAD_FALHOU', erro.message || 'Não foi possível armazenar a imagem.', erro.status || 500);
            }
            return;
        }

        if (req.method === 'GET' && url.pathname === '/media/biblioteca') {
            sendJSON(res, 200, { success: true, midias: storeBibliotecaMidias.listar() });
            return;
        }

        if (req.method === 'POST' && url.pathname === '/media/biblioteca') {
            const body = await readJSONBody(req);
            sendJSON(res, 200, { success: true, midias: storeBibliotecaMidias.salvar(body.midias) });
            return;
        }

        if (req.method === 'POST' && url.pathname === '/media/sincronizar') {
            const remotas = await mediaService.listarInventario();
            const existentes = storeBibliotecaMidias.listar();
            const midias = storeBibliotecaMidias.salvar(reconciliarMidias(existentes, remotas));
            sendJSON(res, 200, { success: true, midias, totalRemoto: remotas.length, total: midias.length });
            return;
        }

        // ------------------------------------------------
        // IA
        // ------------------------------------------------

        if (req.method === 'GET' && url.pathname === '/astra/models') {
            const catalogo = await aiService.modelos(url.searchParams.get('refresh') === '1');
            sendJSON(res, 200, { success: true, ...catalogo });
            return;
        }

        if (req.method === 'POST' && url.pathname === '/astra/generate') {
            const body = await readJSONBody(req);
            const prompt = body.prompt || body.tema || '';
            if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 20000) throw erroSeguro('PROMPT_INVALIDO', 'Informe um prompt textual de até 20.000 caracteres.', 400);
            const result = await aiService.gerar({ prompt, model: body.model, imagem: body.imagem });
            sendJSON(res, 200, { success: true, astra: result });
            return;
        }

        // ------------------------------------------------
        // AGENDAMENTO
        // ------------------------------------------------

        if (req.method === 'GET' && url.pathname === '/agenda/planos') {
            sendJSON(res, 200, { success: true, planos: schedulerService.listarPlanos() });
            return;
        }

        if (req.method === 'POST' && url.pathname === '/agenda/planos') {
            const body = await readJSONBody(req);
            const planos = (Array.isArray(body.planos) ? body.planos : []).slice(0, 50).map(normalizarPlanoRecebido).filter(plano => plano.id);
            sendJSON(res, 200, { success: true, planos: schedulerService.sincronizarPlanos(planos) });
            return;
        }

        if (req.method === 'POST' && url.pathname === '/agenda/executar') {
            const resumo = await schedulerService.executarCiclo();
            sendJSON(res, 200, { success: true, ...resumo });
            return;
        }

        if (req.method === 'POST' && ['/agenda/pausar', '/agenda/retomar', '/agenda/reagendar', '/agenda/cancelar'].includes(url.pathname)) {
            const body = await readJSONBody(req);
            if (typeof body.planoId !== 'string' || !body.planoId) throw erroSeguro('PLANO_ID_INVALIDO', 'Informe o identificador do plano.', 400);
            let plano;
            if (url.pathname === '/agenda/pausar') plano = schedulerService.pausarPlano(body.planoId);
            else if (url.pathname === '/agenda/retomar') plano = schedulerService.retomarPlano(body.planoId);
            else {
                if (typeof body.itemId !== 'string' || !body.itemId) throw erroSeguro('PLANO_ID_INVALIDO', 'Informe o plano e o item.', 400);
                plano = url.pathname === '/agenda/cancelar'
                    ? schedulerService.cancelarItem(body.planoId, body.itemId)
                    : schedulerService.reagendarItem(body.planoId, body.itemId);
            }
            if (!plano) throw erroSeguro('PLANO_NAO_ENCONTRADO', 'Plano ou item não encontrado no servidor.', 404);
            sendJSON(res, 200, { success: true, plano });
            return;
        }

        // ------------------------------------------------
        // EMPRESA (template fixo / agenda padrão)
        // ------------------------------------------------

        if (req.method === 'GET' && url.pathname === '/empresa/config') {
            sendJSON(res, 200, { success: true, template: storeEmpresa.lerTemplate(), agenda: storeEmpresa.lerAgenda() });
            return;
        }
        if (req.method === 'POST' && url.pathname === '/empresa/template') {
            const body = await readJSONBody(req);
            const template = sanitizarTemplateEmpresa(body.template ?? body);
            exigirPersistencia(storeEmpresa.salvarTemplate(template), 'o template da empresa');
            sendJSON(res, 200, { success: true, template });
            return;
        }
        if (req.method === 'POST' && url.pathname === '/empresa/agenda') {
            const body = await readJSONBody(req);
            const agenda = sanitizarAgendaEmpresa(body.agenda ?? body);
            exigirPersistencia(storeEmpresa.salvarAgenda(agenda), 'a agenda da empresa');
            sendJSON(res, 200, { success: true, agenda });
            return;
        }

        if (req.method === 'GET' && url.pathname === '/empresa/template-padrao') {
            const salvo = storeEmpresa.lerTemplatePadrao() || {};
            sendJSON(res, 200, { success: true, templatePadrao: { texto: typeof salvo.texto === 'string' ? salvo.texto : '', aplicarAutomatico: salvo.aplicarAutomatico === true } });
            return;
        }

        if (req.method === 'POST' && url.pathname === '/empresa/template-padrao') {
            const body = await readJSONBody(req);
            const bruto = body.templatePadrao ?? body;
            const templatePadrao = {
                texto: typeof bruto.texto === 'string' ? bruto.texto.slice(0, 10000) : '',
                aplicarAutomatico: bruto.aplicarAutomatico === true
            };
            exigirPersistencia(storeEmpresa.salvarTemplatePadrao(templatePadrao), 'o template padrão');
            sendJSON(res, 200, { success: true, templatePadrao });
            return;
        }

        if (req.method === 'GET' && url.pathname === '/empresa/recorrentes') {
            const salvo = storeEmpresa.lerRecorrentes() || {};
            sendJSON(res, 200, { success: true, recorrentes: sanitizarRecorrentes(salvo) });
            return;
        }

        if (req.method === 'POST' && url.pathname === '/empresa/recorrentes') {
            const body = await readJSONBody(req);
            const recorrentes = sanitizarRecorrentes(body.recorrentes ?? body);
            exigirPersistencia(storeEmpresa.salvarRecorrentes(recorrentes), 'os dados recorrentes');
            sendJSON(res, 200, { success: true, recorrentes });
            return;
        }

        if (req.method === 'GET' && url.pathname === '/empresa/templates') {
            const templates = storeTemplates.migrar(storeEmpresa.lerTemplatePadrao(), storeEmpresa.lerRecorrentes());
            sendJSON(res, 200, { success: true, templates });
            return;
        }
        if (req.method === 'POST' && url.pathname === '/empresa/templates') {
            const body = await readJSONBody(req);
            const template = sanitizarTemplateBiblioteca(body.template ?? body);
            const salvo = storeTemplates.salvar(template, { novo: body.novo === true });
            if (!salvo) throw erroSeguro('TEMPLATE_NAO_ENCONTRADO', 'O template selecionado não existe mais. Recarregue a lista.', 404);
            sendJSON(res, body.novo === true ? 201 : 200, { success: true, template: salvo, templates: storeTemplates.listar() });
            return;
        }

        if (req.method === 'GET' && url.pathname === '/publicacoes') {
            sendJSON(res, 200, { success: true, publicacoes: storePublicacoes.listar() });
            return;
        }
        const rotaPublicacao = /^\/publicacoes\/([A-Za-z0-9_.:-]{1,160})$/.exec(url.pathname);
        if (req.method === 'GET' && rotaPublicacao) {
            const publicacao = storePublicacoes.obter(rotaPublicacao[1]);
            if (!publicacao) throw erroSeguro('PUBLICACAO_NAO_ENCONTRADA', 'Publicação não encontrada no servidor.', 404);
            sendJSON(res, 200, { success: true, publicacao });
            return;
        }
        if (req.method === 'POST' && url.pathname === '/publicacoes') {
            const body = await readJSONBody(req);
            const publicacao = body.publicacao;
            if (!publicacao || typeof publicacao !== 'object' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(String(publicacao.id || ''))) throw erroSeguro('PUBLICACAO_INVALIDA', 'Informe uma publicação com ID válido.', 400);
            const resultado = storePublicacoes.salvar(publicacao);
            if (resultado.conflito) {
                sendJSON(res, 409, { success: false, code: 'PUBLICACAO_CONFLITO', error: 'Existe uma versão mais nova no servidor.', publicacao: resultado.publicacao });
                return;
            }
            sendJSON(res, 200, { success: true, publicacao: resultado.publicacao });
            return;
        }

        // ------------------------------------------------
        // DIAGNÓSTICO
        // ------------------------------------------------

        if (req.method === 'GET' && url.pathname === '/diagnostico/access') {
            sendJSON(res, 200, { success: true, accessToken: diagnostico.tokenAcesso });
            return;
        }
        if (url.pathname.startsWith('/diagnostico/') && !diagnostico.autorizar(req)) {
            throw erroSeguro('DIAGNOSTICO_NAO_AUTORIZADO', 'Acesso ao diagnóstico não autorizado.', 401);
        }
        if (req.method === 'GET' && url.pathname === '/diagnostico/status') {
            sendJSON(res, 200, { success: true, ...diagnostico.obterStatus() });
            return;
        }
        if (req.method === 'POST' && url.pathname === '/diagnostico/event') {
            limitarDiagnostico(req);
            const body = await readJSONBody(req);
            if (diagnostico.habilitado && typeof body.section === 'string' && typeof body.event === 'string') {
                diagnostico.registrar(body.section.slice(0, 40), body.event.slice(0, 80), body.data && typeof body.data === 'object' ? body.data : {});
            }
            sendJSON(res, 200, { success: true, enabled: diagnostico.habilitado });
            return;
        }
        if (req.method === 'POST' && url.pathname === '/diagnostico/start') {
            const body = await readJSONBody(req);
            sendJSON(res, 200, { success: true, ...diagnostico.iniciarSessao({ horas: body.hours, timezone: body.timezone }) });
            return;
        }
        if (req.method === 'POST' && url.pathname === '/diagnostico/stop') {
            sendJSON(res, 200, { success: true, ...diagnostico.encerrarSessao() });
            return;
        }
        if (req.method === 'POST' && url.pathname === '/diagnostico/mark') {
            limitarDiagnostico(req, 30);
            const body = await readJSONBody(req);
            if (typeof body.note !== 'string' || !body.note.trim() || body.note.length > 240) throw erroSeguro('OBSERVACAO_INVALIDA', 'Informe uma observação de até 240 caracteres.', 400);
            diagnostico.registrar('USER_MARK', 'problem_marked', { note: body.note, screen: body.screen, operationId: body.operationId, timezone: body.timezone, result: 'marcado pelo usuário' });
            sendJSON(res, 200, { success: true });
            return;
        }
        if (req.method === 'POST' && url.pathname === '/diagnostico/export') {
            limitarDiagnostico(req, 10);
            sendJSON(res, 200, { success: true, ...diagnostico.exportar() });
            return;
        }

        sendJSON(res, 404, { error: 'Rota não encontrada.' });
    } catch (error) {
        const erro = error.seguro ? error : erroSeguro('FALHA_CONEXAO', 'Falha de conexão ou resposta inesperada do serviço. Verifique o status do servidor.');
        const ctx = contextoOperacao.getStore() || {};
        diagnostico.registrar('BACKEND', 'request_failed', { requestId: ctx.requestId || null, operationId: ctx.operationId || null, code: erro.codigo, httpStatus: erro.status, result: 'falhou' });
        registrarLog({ nivel: erro.status >= 500 ? 'ERROR' : 'WARNING', modulo: 'BACKEND', acao: 'requisicao_falhou', status: 'falhou', operationId: ctx.operationId, codigo: erro.codigo, httpStatus: erro.status, mensagem: erro.message, stack: error.stack, contexto: { rota: req.url?.split('?')[0], destino: erro.destinoPublicacao || null, resultados: erro.resultadosPublicacao || null } });
        if (res.destroyed || res.headersSent) return;
        const detalhesPublicacao = {};
        if (/^[A-Za-z0-9_.:-]{1,200}$/.test(String(erro.containerId || ''))) detalhesPublicacao.containerId = erro.containerId;
        if (typeof erro.estadoContainer === 'string') detalhesPublicacao.containerStatus = erro.estadoContainer;
        if (erro.resultadosPublicacao && typeof erro.resultadosPublicacao === 'object') detalhesPublicacao.resultadosPublicacao = erro.resultadosPublicacao;
        if (['feed', 'story', 'facebook'].includes(erro.destinoPublicacao)) detalhesPublicacao.destinoPublicacao = erro.destinoPublicacao;
        sendJSON(res, erro.status, { success: false, code: erro.codigo, error: erro.message, ...detalhesPublicacao });
    }
}

const server = http.createServer((req, res) => {
    contextoOperacao.run({ requestId: crypto.randomUUID(), operationId: crypto.randomUUID() }, () => tratarRequisicao(req, res));
});
// Permite receber arquivos grandes em conexões lentas antes de processar o upload.
server.requestTimeout = 600000;

// ============================================================
// START
// ============================================================

if (require.main === module) {
    instalarEncerramento(server, 'Astra Instagram');
    diagnostico.iniciar(config.porta);
    const relogioAgenda = setInterval(() => {
        schedulerService.executarCiclo().catch(erro => {
            // Nunca registra mensagens externas, URLs, conteúdo ou credenciais.
            const code = erro.codigo === 'AGENDA_PERSISTENCIA' ? 'AGENDA_PERSISTENCIA' : 'AGENDA_CICLO_FALHOU';
            diagnostico.registrar('SCHEDULING', 'cycle_failed', { code, result: 'ciclo interrompido' });
            console.error(`[SCHEDULING] ${code}: ciclo interrompido; verifique o armazenamento e o diagnóstico.`);
        });
    }, 30000);
    relogioAgenda.unref();
    server.on('error', erro => {
        diagnostico.registrar('INITIALIZATION', 'server_failed', { code: erro.code, message: erro.message, port: config.porta });
        console.error(`Não foi possível iniciar: ${erro.message}`);
        process.exitCode = 1;
    });
    server.listen(config.porta, '127.0.0.1', () => {
        diagnostico.registrar('INITIALIZATION', 'server_started', { port: config.porta });
        console.log('');
        console.log('==========================================');
        console.log('        ASTRA INSTAGRAM ONLINE');
        console.log('==========================================');
        console.log(`Local server: http://localhost:${config.porta}`);
        console.log(`Health:       http://localhost:${config.porta}/health`);
        console.log(`Painel:       http://localhost:${config.porta}/painel/`);
        console.log('==========================================');
        console.log('');
        console.log('Press CTRL+C to stop the server.');
    });
}

module.exports = { server, schedulerService };
