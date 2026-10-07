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
const { AsyncLocalStorage } = require('node:async_hooks');
const { URL } = require('node:url');

const { servirPainel } = require('./painel-meta-prototipo/servidor');
const { erroSeguro, ocultarSegredos, autorizarOrigem, publicarUmaVez } = require('./bridge-seguranca');
const { instalarEncerramento } = require('./encerramento-servidor');
const diagnostico = require('./diagnostico');

const { config, capacidades } = require('./services/config');
const { criarAIService } = require('./services/ai-service');
const { criarMediaService } = require('./services/media-service');
const { criarInstagramService } = require('./services/instagram-service');
const { criarMotor, criarArmazenamentoArquivo, publicarItemNoInstagram } = require('./services/scheduler-service');
const { criarStoreEmpresa } = require('./services/empresa-store');

// Correlaciona operações disparadas por uma requisição sem gravar conteúdo.
const contextoOperacao = new AsyncLocalStorage();

// ============================================================
// SERVIÇOS
// ============================================================

const storeEmpresa = criarStoreEmpresa(config.arquivos.empresa);

const aiService = criarAIService({
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

// O scheduler reutiliza o adaptador único do SchedulerService, que chama
// InstagramService.publish() exatamente como a publicação imediata.
const publicadorAgenda = instagramService
    ? publicarItemNoInstagram(instagramService)
    : async () => { throw erroSeguro('INSTAGRAM_NAO_CONFIGURADO', 'Instagram não configurado no servidor.', 503); };

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
        let body = '';
        req.on('data', chunk => {
            body += chunk;
            const caminho = req.url?.split('?')[0];
            const limite = ['/astra/generate', '/media/upload'].includes(caminho) ? 12_000_000 : 1_000_000;
            if (Buffer.byteLength(body) > limite) {
                const ctx = contextoOperacao.getStore() || {};
                diagnostico.registrar('BACKEND', 'payload_too_large', { rota: caminho, operationId: ctx.operationId || null, limitBytes: limite, result: 'falhou', errorCode: 'CORPO_EXCESSIVO' });
                reject(erroSeguro('CORPO_EXCESSIVO', 'Solicitação excede o limite permitido.', 413));
                req.destroy();
            }
        });
        req.on('end', () => {
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
            timezone: typeof item.timezone === 'string' ? item.timezone.slice(0, 60) : config.timezone,
            destinos: Array.isArray(item.destinos) ? item.destinos.filter(d => d === 'Instagram') : ['Instagram'],
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

// ============================================================
// ROTEAMENTO
// ============================================================

async function tratarRequisicao(req, res) {
    try {
        autorizarOrigem(req, res);
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

        if (url.pathname === '/painel') { res.writeHead(302, { Location: '/painel/' }); res.end(); return; }
        if (url.pathname.startsWith('/painel/')) { servirPainel(req, res, url.pathname.slice('/painel'.length)); return; }
        if (req.method === 'POST' && !req.headers['content-type']?.toLowerCase().startsWith('application/json')) {
            throw erroSeguro('TIPO_INVALIDO', 'Envie a solicitação como application/json.', 415);
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
                    diagnostics: 'GET /diagnostico/status'
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
            if (!instagramService) throw erroSeguro('INSTAGRAM_NAO_CONFIGURADO', 'Instagram não configurado no servidor.', 503);
            const body = await readJSONBody(req);
            const formato = body.formato === 'reel' ? 'reel' : body.formato === 'carrossel' ? 'carrossel' : body.formato === 'story' ? 'story' : 'imagem';
            if (body.caption !== undefined && typeof body.caption !== 'string') throw erroSeguro('LEGENDA_INVALIDA', 'A legenda deve ser um texto.', 400);
            const entrada = formato === 'carrossel'
                ? { formato, itens: (Array.isArray(body.itens) ? body.itens : []).slice(0, 20), caption: body.caption || '' }
                : { formato, mediaUrl: body.mediaUrl, imageUrl: body.imageUrl, videoUrl: body.videoUrl, caption: body.caption || '' };
            const resultado = await publicarUmaVez(req, body, async () => {
                const publicacao = await instagramService.publish(entrada);
                return { success: true, containerId: publicacao.containerId, published: { id: publicacao.mediaId }, formato: publicacao.formato };
            });
            sendJSON(res, 200, resultado);
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
                sendJSON(res, 201, { success: true, id: body.id || null, public_url: midia.url, media_type: 'image', filename: midia.arquivo, mime: midia.mime, bytes: midia.bytes, sha256: midia.sha256, verified_at: midia.verificadaEm });
            } catch (erro) {
                throw erroSeguro(erro.code || 'MIDIA_UPLOAD_FALHOU', erro.message || 'Não foi possível armazenar a imagem.', erro.status || 500);
            }
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
            storeEmpresa.salvarTemplate(template);
            sendJSON(res, 200, { success: true, template });
            return;
        }
        if (req.method === 'POST' && url.pathname === '/empresa/agenda') {
            const body = await readJSONBody(req);
            const agenda = sanitizarAgendaEmpresa(body.agenda ?? body);
            storeEmpresa.salvarAgenda(agenda);
            sendJSON(res, 200, { success: true, agenda });
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
        if (res.destroyed || res.headersSent) return;
        sendJSON(res, erro.status, { success: false, code: erro.codigo, error: erro.message });
    }
}

const server = http.createServer((req, res) => {
    contextoOperacao.run({ requestId: crypto.randomUUID(), operationId: crypto.randomUUID() }, () => tratarRequisicao(req, res));
});

// ============================================================
// START
// ============================================================

if (require.main === module) {
    instalarEncerramento(server, 'Astra Instagram');
    diagnostico.iniciar(config.porta);
    const relogioAgenda = setInterval(() => { schedulerService.executarCiclo().catch(() => {}); }, 30000);
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
