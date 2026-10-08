'use strict';

/*
 * Editor principal do Astra (somente Instagram).
 *
 * Abas: Mídia · Informações · IA · Revisão · Agendamento · Desempenho.
 * Barra lateral: publicações anteriores reais do Instagram.
 * A UI coordena; a IA prepara; os serviços publicam/agendam.
 */

const R = globalThis.Regras;
const IR = globalThis.IntegracaoRegras;
const PS = globalThis.PlanejamentoSemanal;
const $ = id => document.getElementById(id);
const cliente = IR.criarCliente(location.pathname.startsWith('/painel/') ? location.origin : 'http://127.0.0.1:8080');

let conteudos = [R.criarConteudo()];
let atual = conteudos[0];
let banco;
let bibliotecaMidias = [];
let modelosDisponiveis = [];
let carregandoModelos = false;
let enviandoPublicacao = false;
let confirmacaoAtual;
let temporizador;
let perfilInstagram;
let servidorOnline = false;
let templateRequisitosFixo;
let agendaEmpresa;
let temporizadorEmpresa;
let templatePadrao = { texto: '', aplicarAutomatico: false };
let anteriores = [];
let anterioresCursor = null;
let anteriorSelecionada = null;
let analiseAtual = null;
let planoPeriodo = null;
let selecionadosPeriodo = new Set();

function aplicarMarca() { document.title = 'Astra Instagram · Estúdio de publicações'; document.documentElement.dataset.aplicativo = 'Astra Instagram'; }
function elemento(tag, texto, classe) { const el = document.createElement(tag); if (texto !== undefined) el.textContent = texto; if (classe) el.className = classe; return el; }
function avisar(texto) { const alvo = $('mensagem'); if (!alvo) return; alvo.textContent = texto; clearTimeout(temporizador); temporizador = setTimeout(() => { alvo.textContent = ''; }, 8000); }
function formatarBytes(bytes) { const v = Number(bytes) || 0; if (v < 1024) return `${v} B`; if (v < 1048576) return `${(v / 1024).toFixed(1)} KB`; return `${(v / 1048576).toFixed(1)} MB`; }
function registrar(evento, dados = {}) { window.registrarDiagnostico?.('EDITOR', evento, dados); }
function urlPublicaDaMidia(midia) { return IR.urlPublicaHttps(midia?.urlPublica) ? midia.urlPublica : ''; }

// ============================================================
// PERSISTÊNCIA
// ============================================================

function lerArmazenamento(chave) {
    return new Promise((resolve, reject) => {
        if (!banco) { resolve(null); return; }
        const leitura = banco.transaction('conteudos').objectStore('conteudos').get(chave);
        leitura.onsuccess = () => resolve(leitura.result);
        leitura.onerror = () => reject(leitura.error);
    });
}

function salvarArmazenamento(chave, valor) {
    return new Promise((resolve, reject) => {
        if (!banco) { reject(new Error('Armazenamento indisponível.')); return; }
        const transacao = banco.transaction('conteudos', 'readwrite');
        transacao.objectStore('conteudos').put(valor, chave);
        transacao.oncomplete = resolve;
        transacao.onerror = () => reject(transacao.error);
        transacao.onabort = () => reject(transacao.error);
    });
}

async function salvar(silencioso = false) {
    if (!banco) { if (!silencioso) avisar('Armazenamento local indisponível.'); return false; }
    try {
        await salvarArmazenamento('conteudos', conteudos);
        try { await salvarArmazenamento('biblioteca-midias', bibliotecaMidias); } catch { /* melhor esforço */ }
        $('salvamento').textContent = 'Salvo neste navegador · ' + new Date().toLocaleTimeString('pt-BR');
        if (!silencioso) avisar('✓ Salvo');
        return true;
    } catch { if (!silencioso) avisar('Não foi possível salvar.'); return false; }
}
function marcarAlterado() { $('salvamento').textContent = 'Alterações ainda não salvas'; }

// ============================================================
// ABAS / CONTEÚDOS
// ============================================================

const ORDEM_ABAS = Publicacoes.ETAPAS;

function abaAtual() {
    const tab = document.querySelector('[role=tab][data-aba][aria-selected=true]');
    return tab?.dataset.aba || 'midia';
}

/**
 * Função central: valida a etapa, persiste e avança para a próxima aba.
 * Se houver erro impeditivo, mostra exatamente o campo e NÃO avança.
 */
async function salvarEAvancar(etapa) {
    const etapaAtual = etapa || abaAtual();
    const erros = Publicacoes.validarEtapa(etapaAtual, atual, {
        midiaPublicaPronta: IR.midiasPublicasProntas(atual),
        errosDeConteudo: R.validar(atual, Date.now(), { exigirMidia: false }).filter(i => !i.ok).map(i => i.texto)
    });
    await salvar(true);
    if (erros.length) {
        avisar(`Salvo, mas há pendências nesta etapa: ${erros.map(e => `${e.campo} — ${e.mensagem}`).join(' · ')}. Não avançando.`);
        registrar('salvar_bloqueado', { etapa: etapaAtual, campos: erros.map(e => e.campo) });
        renderizarRevisao();
        return false;
    }
    const proxima = Publicacoes.proximaEtapa(etapaAtual);
    if (proxima) abrirAba(proxima);
    avisar('Salvo');
    registrar('salvar_avancou', { etapa: etapaAtual, proxima });
    return true;
}

function abrirAba(nome, foco = false) {
    document.querySelectorAll('[role=tab][data-aba]').forEach(tab => {
        const ativo = tab.dataset.aba === nome;
        tab.setAttribute('aria-selected', String(ativo));
        tab.tabIndex = ativo ? 0 : -1;
        const painel = $(tab.getAttribute('aria-controls'));
        if (painel) painel.hidden = !ativo;
        if (ativo && foco) tab.focus();
    });
    if (nome === 'revisao') renderizarRevisao();
    if (nome === 'agendamento') renderizarStatusPublicacao();
    if (nome === 'desempenho') renderizarDesempenho();
    registrar('tab_change', { tab: nome });
}

function novaPublicacao() {
    const novo = aplicarRecorrentesEm(R.criarConteudo());
    if (templatePadrao.aplicarAutomatico) novo.templateTexto = templatePadrao.texto;
    Empresa.aplicarAgendaEmpresa(novo, agendaEmpresa);
    conteudos.push(novo); atual = novo;
    marcarAlterado(); sincronizarCampos(); renderizarMidias(); renderizarRevisao(); atualizarSeletorConteudos(); abrirAba('midia');
}

function atualizarSeletorConteudos() {
    const seletor = $('conteudo-atual');
    if (!seletor) return;
    seletor.replaceChildren();
    conteudos.forEach((c, indice) => { const o = elemento('option', c.titulo || `Publicação ${indice + 1}`); o.value = c.id; seletor.append(o); });
    seletor.value = atual.id;
}

function trocarConteudo(id) {
    const encontrado = conteudos.find(c => c.id === id);
    if (!encontrado) return;
    atual = encontrado;
    sincronizarCampos(); renderizarMidias(); renderizarRevisao(); atualizarSeletorConteudos();
}

// ============================================================
// MÍDIA
// ============================================================

async function lerArquivo(arquivo) {
    const imagem = ['image/jpeg', 'image/png', 'image/webp'].includes(arquivo.type);
    const video = arquivo.type === 'video/mp4';
    if (!imagem && !video) throw new Error(`${arquivo.name}: use JPEG, PNG, WebP ou MP4.`);
    if (arquivo.size > (video ? 50 : 5) * 1024 * 1024) throw new Error(`${arquivo.name}: excede o tamanho permitido.`);
    const dados = await new Promise((resolve, reject) => {
        const leitor = new FileReader();
        leitor.onload = () => resolve(leitor.result);
        leitor.onerror = () => reject(new Error(`${arquivo.name}: não foi possível ler o arquivo.`));
        leitor.readAsDataURL(arquivo);
    });
    let duracao = null;
    if (imagem) { const visual = new Image(); visual.src = dados; await visual.decode(); }
    else duracao = await new Promise((resolve, reject) => {
        const visual = document.createElement('video'); visual.preload = 'metadata';
        visual.onloadedmetadata = () => resolve(Number.isFinite(visual.duration) ? visual.duration : null);
        visual.onerror = () => reject(new Error(`${arquivo.name}: vídeo inválido.`));
        visual.src = dados;
    });
    return { id: crypto.randomUUID(), nome: arquivo.name, dados, miniatura: dados, tipo: video ? 'video' : 'imagem', mime: arquivo.type, tamanho: arquivo.size, duracao, status: 'disponível', statusProcessamento: 'concluído', urlPublica: '', statusUpload: 'pendente', tags: [] };
}

function renderizarMidias() {
    const galeria = $('galeria');
    galeria.replaceChildren();
    atual.imagens.forEach((foto, indice) => {
        const figura = elemento('figure', undefined, 'foto');
        const imagem = elemento(foto.tipo === 'video' ? 'video' : 'img');
        imagem.src = foto.miniatura || foto.dados; imagem.alt = foto.nome;
        if (foto.tipo === 'video') { imagem.controls = true; imagem.preload = 'metadata'; }
        const duracao = Number.isFinite(foto.duracao) ? ` · ${Math.round(foto.duracao)} s` : '';
        const url = urlPublicaDaMidia(foto);
        const legenda = elemento('figcaption', `${indice + 1}. ${foto.nome} · ${foto.tipo}${duracao} · ${url ? '✓ Enviada' : (foto.statusUpload === 'enviando' ? 'enviando…' : 'sem URL pública')} · ${formatarBytes(foto.tamanho)}`);
        const controles = elemento('div');
        for (const [texto, deslocamento] of [['←', -1], ['→', 1], ['Remover', 0]]) {
            const botao = elemento('button', texto); botao.type = 'button';
            botao.disabled = deslocamento !== 0 && (indice + deslocamento < 0 || indice + deslocamento >= atual.imagens.length);
            botao.onclick = () => {
                if (!deslocamento) atual.imagens.splice(indice, 1);
                else [atual.imagens[indice], atual.imagens[indice + deslocamento]] = [atual.imagens[indice + deslocamento], atual.imagens[indice]];
                IR.sincronizarUrlsPublicas(atual); marcarAlterado(); renderizarMidias(); renderizarRevisao();
            };
            controles.append(botao);
        }
        if (!url) { const enviar = elemento('button', 'Enviar mídia'); enviar.type = 'button'; enviar.onclick = () => enviarMidia(foto, enviar); controles.append(enviar); }
        figura.append(imagem, legenda);
        if (url) { const link = elemento('a', `✓ Enviada · ${url}`, 'nota'); link.href = url; link.target = '_blank'; link.rel = 'noopener'; figura.append(link); }
        figura.append(controles);
        galeria.append(figura);
    });
}

/** Envia uma mídia, sincroniza estado e campo visual (re-localiza pelo ID). */
async function enviarMidia(midia, botao) {
    if (midia.tipo !== 'imagem') { avisar('Somente imagens JPEG/PNG/WebP usam o upload público.'); return; }
    const conteudo = atual;
    const original = botao?.textContent;
    if (botao) { botao.disabled = true; botao.textContent = 'Enviando…'; }
    midia.statusUpload = 'enviando'; renderizarMidias();
    try {
        const resposta = await cliente.solicitar('/media/upload', { id: midia.id, dados: midia.dados, mime: midia.mime, nome: midia.nome }, { prazo: 60000 });
        if (typeof resposta?.public_url !== 'string' || !resposta.public_url) throw Object.assign(new Error('O servidor não retornou public_url.'), { codigo: 'MIDIA_UPLOAD_RESPOSTA_INVALIDA' });
        const atualizada = Publicacoes.registrarUrlPublica(conteudo, midia.id, resposta.public_url, resposta);
        if (!atualizada) throw Object.assign(new Error('A mídia enviada não foi encontrada no conteúdo atual.'), { codigo: 'MIDIA_NAO_ENCONTRADA' });
        registrar('media_uploaded', { mediaId: midia.id, bytes: atualizada.tamanho });
        marcarAlterado();
        if (conteudo === atual) { sincronizarCampos(); renderizarMidias(); renderizarRevisao(); }
        await salvar(true);
        avisar('✓ Imagem enviada. URL pública preenchida.');
    } catch (erro) {
        midia.statusUpload = 'pendente'; renderizarMidias();
        registrar('media_upload_failed', { mediaId: midia.id, code: erro.codigo, message: erro.message });
        avisar(`Upload: ${erro.message}`);
    } finally { if (botao) { botao.disabled = false; botao.textContent = original; } }
}

async function processarArquivos(arquivos) {
    const acao = $('acao-upload').value;
    const progresso = $('progresso-upload'); progresso.replaceChildren();
    const lidas = []; const falhas = [];
    for (const arquivo of arquivos) {
        const linha = elemento('div', `… ${arquivo.name}`, 'nota'); progresso.append(linha);
        try { const midia = await lerArquivo(arquivo); lidas.push(midia); linha.textContent = `✓ ${arquivo.name} · ${midia.tipo} · ${formatarBytes(midia.tamanho)}`; registrar('media_read', { file: arquivo.name, result: 'sucesso' }); }
        catch (erro) { falhas.push(arquivo.name); linha.textContent = `✗ ${arquivo.name} · ${erro.message}`; registrar('media_read', { file: arquivo.name, result: 'falhou' }); }
    }
    if (!lidas.length) { avisar(falhas.length ? 'Nenhum arquivo válido foi adicionado.' : 'Nenhum arquivo selecionado.'); return; }
    bibliotecaMidias.push(...lidas); bibliotecaMidias = bibliotecaMidias.slice(-200);
    if (acao === 'carrossel') {
        atual.tipoMidia = 'carrossel'; atual.imagens = [...lidas];
    } else if (acao === 'distribuir') {
        for (const midia of lidas) {
            const novo = R.criarConteudo();
            novo.titulo = midia.nome; novo.imagens = [midia]; novo.tipoMidia = midia.tipo === 'video' ? 'reel' : 'imagem';
            if (templatePadrao.aplicarAutomatico) novo.templateTexto = templatePadrao.texto;
            Empresa.aplicarAgendaEmpresa(novo, agendaEmpresa);
            conteudos.push(novo);
        }
        atual = conteudos[conteudos.length - 1];
        avisar(`${lidas.length} conteúdo(s) criado(s).`);
    } else {
        for (const midia of lidas) { if (atual.imagens.length >= 10) { avisar('Limite local de 10 mídias por conteúdo.'); break; } atual.imagens.push(midia); }
    }
    IR.sincronizarUrlsPublicas(atual); atual.estado = 'rascunho';
    marcarAlterado(); sincronizarCampos(); renderizarMidias(); renderizarRevisao(); atualizarSeletorConteudos();
    if (falhas.length) avisar(`${lidas.length} adicionada(s); ${falhas.length} arquivo(s) falharam sem apagar os demais.`);
}

// ============================================================
// CAMPOS / TEMPLATE
// ============================================================

function sincronizarCampos() {
    $('tipoMidia').value = atual.tipoMidia;
    for (const campo of ['objetivo', 'tema', 'fatos', 'contexto', 'fatosIa', 'textoMidia', 'hashtags', 'palavras', 'ideias', 'imagemUrl', 'videoUrl', 'legenda']) if ($(campo)) $(campo).value = atual[campo] || '';
    if ($('titulo')) $('titulo').value = atual.titulo || '';
    if ($('template-texto')) $('template-texto').value = atual.templateTexto || templatePadrao.texto || '';
    if ($('template-auto')) $('template-auto').checked = templatePadrao.aplicarAutomatico === true;
    if ($('imagemUrl')) Publicacoes.sincronizarUrlPublicaNoCampo($('imagemUrl'), atual);
    $('campo-imagem-url').hidden = atual.tipoMidia === 'reel';
    $('campo-video-url').hidden = atual.tipoMidia !== 'reel';
    $('usar-visao').checked = atual.usarVisao !== false;
    if ($('estado')) $('estado').textContent = Publicacoes.estadoPublicacao(atual);
    atualizarCampoConteudo();
}

function atualizarCampoConteudo() { if ($('conteudo-atual')) $('conteudo-atual').value = atual.id; }

function carregarTemplateNoCampo() { if ($('template-texto')) $('template-texto').value = atual.templateTexto || templatePadrao.texto || ''; if ($('template-status')) $('template-status').textContent = templatePadrao.texto ? 'Template salvo no backend.' : 'Nenhum template salvo.'; }

// ============================================================
// DADOS RECORRENTES DA EMPRESA
// ============================================================

let recorrentes = { site: '', maps: '', linksAdicionais: '', hashtagsPadrao: '', informacoesAdicionais: '', chamadasFixas: '', templateTexto: '' };

async function carregarRecorrentes() {
    try {
        const resposta = await cliente.solicitar('/empresa/recorrentes', undefined, { prazo: 10000 });
        recorrentes = { ...recorrentes, ...(resposta.recorrentes || {}) };
        $('recorrentes-status').textContent = 'Dados recorrentes carregados do backend.';
    } catch { $('recorrentes-status').textContent = 'Dados recorrentes disponíveis apenas nesta aba (servidor offline).'; }
    preencherCamposRecorrentes();
}

function preencherCamposRecorrentes() {
    for (const campo of ['site', 'maps', 'links-adicionais', 'hashtags-padrao', 'informacoes-fixas', 'chamadas-fixas']) {
        const el = $(campo);
        if (!el) continue;
        const chave = campo.replace(/-([a-z])/g, (_, letra) => letra.toUpperCase());
        el.value = atual[chave] || recorrentes[chave] || '';
    }
    $('recorrentes-status').textContent = `Dados recorrentes salvos no backend${recorrentes.hashtagsPadrao ? ' (hashtags incluídas)' : ''}.`;
}

/** Aplica os dados recorrentes a uma publicação nova, sem hardcode no JS. */
function aplicarRecorrentesEm(publicacao) {
    if (!publicacao) return publicacao;
    const fonte = ch => atual[ch] || recorrentes[ch] || '';
    publicacao.site = fonte('site'); publicacao.maps = fonte('maps'); publicacao.linksAdicionais = fonte('linksAdicionais');
    if (!publicacao.hashtags) publicacao.hashtags = fonte('hashtagsPadrao');
    publicacao.informacoesAdicionais = fonte('informacoesAdicionais');
    publicacao.chamadasFixas = fonte('chamadasFixas');
    if (recorrentes.templateTexto && !publicacao.templateTexto) publicacao.templateTexto = recorrentes.templateTexto;
    publicacao.incluir = { ...publicacao.incluir, site: Boolean(fonte('site')), maps: Boolean(fonte('maps')) };
    return publicacao;
}

async function salvarRecorrentesEmpresa() {
    const ler = id => ($(id)?.value || '').trim();
    recorrentes = {
        site: ler('site'), maps: ler('maps'), linksAdicionais: ler('links-adicionais'),
        hashtagsPadrao: ler('hashtags-padrao'), informacoesAdicionais: ler('informacoes-fixas'),
        chamadasFixas: ler('chamadas-fixas'), templateTexto: recorrentes.templateTexto || ''
    };
    // Reflete imediatamente na publicação atual.
    atual.site = recorrentes.site; atual.maps = recorrentes.maps; atual.linksAdicionais = recorrentes.linksAdicionais;
    atual.informacoesAdicionais = recorrentes.informacoesAdicionais; atual.chamadasFixas = recorrentes.chamadasFixas;
    if (recorrentes.hashtagsPadrao && !atual.hashtags) atual.hashtags = recorrentes.hashtagsPadrao;
    marcarAlterado();
    try { await cliente.solicitar('/empresa/recorrentes', { recorrentes }, { prazo: 15000 }); $('recorrentes-status').textContent = 'Dados recorrentes salvos no backend.'; avisar('Dados recorrentes salvos.'); }
    catch (erro) { $('recorrentes-status').textContent = `Salvo localmente; o servidor não confirmou: ${erro.message}`; }
    renderizarRevisao();
}

async function salvarTemplatePadrao() {
    templatePadrao = { texto: $('template-texto').value || '', aplicarAutomatico: $('template-auto').checked === true };
    atual.templateTexto = templatePadrao.texto; atual.templateAplicarAutomatico = templatePadrao.aplicarAutomatico;
    try { await cliente.solicitar('/empresa/template-padrao', { templatePadrao }, { prazo: 15000 }); avisar('Template salvo.'); }
    catch (erro) { avisar(`Template mantido localmente; o servidor não confirmou: ${erro.message}`); }
    marcarAlterado(); renderizarRevisao(); carregarTemplateNoCampo();
}

function aplicarTemplateAtual() {
    atual.templateTexto = $('template-texto').value || '';
    marcarAlterado(); renderizarRevisao(); avisar('Template aplicado à publicação atual.');
}

// ============================================================
// REVISÃO
// ============================================================

function renderizarRevisao() {
    const previas = $('previas');
    previas.replaceChildren();
    const cartao = elemento('div', undefined, 'previa');
    cartao.append(elemento('strong', 'Instagram'), elemento('p', 'Prévia local · apresentação aproximada', 'nota'));
    if (atual.imagens[0]) { const img = elemento('img'); img.src = atual.imagens[0].miniatura || atual.imagens[0].dados; img.alt = atual.imagens[0].nome; cartao.append(img); }
    else if (urlPublicaDaMidia({ urlPublica: atual.imagemUrl })) { const img = elemento('img'); img.src = atual.imagemUrl; img.alt = 'Imagem por URL'; cartao.append(img); }
    cartao.append(elemento('p', R.compor(atual) || 'Sua legenda aparecerá aqui.', 'texto-final'));
    previas.append(cartao);

    // Revisão humana por ideia, independente das demais pendências.
    const revisaoIdeias = $('revisao-ideias');
    revisaoIdeias.replaceChildren();
    const ideias = R.linhas(atual.ideias);
    if (!ideias.length) revisaoIdeias.append(elemento('p', 'Nenhuma ideia obrigatória cadastrada.', 'nota'));
    for (const ideia of ideias) {
        const label = elemento('label', undefined, 'check');
        const check = document.createElement('input'); check.type = 'checkbox'; check.checked = (atual.revisoes || []).includes(ideia);
        check.onchange = () => {
            atual.revisoes = check.checked ? [...new Set([...(atual.revisoes || []), ideia])] : (atual.revisoes || []).filter(i => i !== ideia);
            marcarAlterado(); atualizarChecklist(); salvar(true);
        };
        label.append(check, document.createTextNode(`Revisão humana — ${ideia}`));
        revisaoIdeias.append(label);
    }

    const validacoes = R.validar(atual, Date.now(), { exigirMidia: false });
    validacoes.push({ ok: IR.midiasPublicasProntas(atual), texto: 'URL HTTPS pública da mídia pronta para publicação' });
    $('validacoes').replaceChildren(...validacoes.map(item => elemento('li', `${item.ok ? '✓' : '○'} ${item.texto}`, item.ok ? 'ok' : 'pendente')));
    const pronto = validacoes.every(item => item.ok);
    $('aprovar').disabled = !pronto || atual.estado === 'confirmado';
    renderizarValidacoesPublicacao(pronto);
}

function atualizarChecklist() {
    const validacoes = R.validar(atual, Date.now(), { exigirMidia: false });
    validacoes.push({ ok: IR.midiasPublicasProntas(atual), texto: 'URL HTTPS pública da mídia pronta para publicação' });
    $('validacoes').replaceChildren(...validacoes.map(item => elemento('li', `${item.ok ? '✓' : '○'} ${item.texto}`, item.ok ? 'ok' : 'pendente')));
    $('aprovar').disabled = !validacoes.every(item => item.ok) || atual.estado === 'confirmado';
}

/** Marca a revisão humana de todas as ideias sem exigir o restante do checklist. */
function marcarRevisaoHumana() {
    const ideias = R.linhas(atual.ideias);
    atual.revisoes = [...new Set([...(atual.revisoes || []), ...ideias])];
    marcarAlterado(); renderizarRevisao(); salvar(true);
    avisar(ideias.length ? 'Revisão humana marcada.' : 'Nenhuma ideia obrigatória para revisar.');
}

function renderizarValidacoesPublicacao(prontoConteudo) {
    const itens = IR.validarInstagram(atual, R);
    $('validacoes-publicacao').replaceChildren(...itens.map(item => elemento('li', `${item.ok ? '✓' : '○'} ${item.texto}`, item.ok ? 'ok' : 'pendente')));
    const pode = prontoConteudo && itens.every(item => item.ok) && Boolean(perfilInstagram) && atual.estado === 'confirmado';
    $('preparar-publicacao').disabled = enviandoPublicacao || !pode;
    $('resultado-publicacao').textContent = atual.publicacaoReal ? (atual.publicacaoReal.estado === 'publicado' ? `Publicada · ID ${atual.publicacaoReal.idPublicado}` : `${atual.publicacaoReal.mensagem || 'Resultado não confirmado.'}`) : (perfilInstagram ? 'Conexão verificada. Confirme o conteúdo para publicar.' : 'Use "Testar Instagram" antes de publicar.');
}

// ============================================================
// IA
// ============================================================

function mostrarModeloSelecionado() {
    const modelo = modelosDisponiveis.find(item => item.id === $('modelo-astra').value);
    if (!modelo) { $('detalhes-modelo').textContent = 'Carregue a lista para escolher um modelo.'; return; }
    const moeda = valor => typeof valor === 'number' && Number.isFinite(valor) ? new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(valor) : 'Preço não informado';
    $('detalhes-modelo').textContent = `${modelo.id} · ${modelo.family} · ${modelo.vision ? '👁 Visão' : 'Texto'} · ${modelo.contextLength ? modelo.contextLength.toLocaleString('pt-BR') + ' tokens' : 'contexto n/i'} · Entrada ${moeda(modelo.pricing.inputPerMillion)} · Saída ${moeda(modelo.pricing.outputPerMillion)}`;
    $('aviso-visao').textContent = (atual.imagens.length || atual.imagemUrl) && modelo.vision === false ? 'O modelo selecionado não analisa imagens.' : 'Visão opcional quando habilitada e compatível.';
}

async function carregarModelos(atualizar = false) {
    if (carregandoModelos) return;
    carregandoModelos = true; $('atualizar-modelos').disabled = true; $('modelo-astra').disabled = true;
    $('status-modelos').textContent = 'Atualizando modelos…';
    try {
        const anterior = atual.modeloAstra || $('modelo-astra').value;
        const dados = await cliente.solicitar('/astra/models', undefined, { prazo: 20000, atualizar });
        if (!Array.isArray(dados.models) || !dados.models.length) throw new Error('O servidor não retornou modelos válidos.');
        modelosDisponiveis = dados.models;
        $('modelo-astra').replaceChildren();
        for (const categoria of ['Econômico', 'Equilibrado', 'Maior capacidade']) {
            const grupo = elemento('optgroup'); grupo.label = categoria;
            modelosDisponiveis.filter(m => m.category === categoria).forEach(m => { const o = elemento('option', `${m.vision ? '👁 · ' : ''}${m.name}`); o.value = m.id; grupo.append(o); });
            if (grupo.children.length) $('modelo-astra').append(grupo);
        }
        $('modelo-astra').value = modelosDisponiveis.some(m => m.id === anterior) ? anterior : dados.defaultModel;
        $('status-modelos').textContent = `${modelosDisponiveis.length} modelos`;
        mostrarModeloSelecionado();
    } catch (erro) { $('status-modelos').textContent = `${erro.message} A edição manual continua disponível.`; }
    finally { carregandoModelos = false; $('atualizar-modelos').disabled = false; $('modelo-astra').disabled = !modelosDisponiveis.length; }
}

async function gerarLegenda(reescrever) {
    const modelo = modelosDisponiveis.find(m => m.id === $('modelo-astra').value);
    if (!modelo) { avisar('Selecione um modelo válido.'); return; }
    let prompt;
    try { prompt = IR.montarPrompt(atual, reescrever, Boolean(modelo.vision)); } catch (erro) { avisar(erro.message); return; }
    const disponivel = atual.imagens[0]?.dados || (atual.tipoMidia !== 'reel' ? atual.imagemUrl : '');
    const imagem = atual.usarVisao !== false && modelo.vision ? disponivel : undefined;
    atual.modeloAstra = modelo.id;
    const botao = reescrever ? $('reescrever-legenda') : $('gerar-legenda');
    const original = botao.textContent; botao.disabled = true; botao.textContent = 'Astra escrevendo…';
    try {
        const resposta = await cliente.solicitar('/astra/generate', { prompt, model: modelo.id, ...(imagem ? { imagem } : {}) }, { prazo: 120000 });
        const texto = resposta.astra?.text;
        if (typeof texto !== 'string' || !texto.trim()) throw new Error('Astra não retornou texto.');
        atual.legenda = texto; atual.estado = 'rascunho'; $('legenda').value = texto;
        marcarAlterado(); renderizarRevisao(); avisar('Legenda recebida. O template não foi alterado.');
    } catch (erro) { avisar(`IA: ${erro.message} Você pode escrever manualmente.`); }
    finally { botao.disabled = false; botao.textContent = original; }
}

async function analisarMidia() {
    const modelo = modelosDisponiveis.find(m => m.id === $('modelo-astra').value);
    const imagem = atual.imagens[0]?.dados || (atual.tipoMidia !== 'reel' ? atual.imagemUrl : '');
    if (!imagem || !modelo?.vision) { avisar('Selecione uma imagem e um modelo com visão.'); return; }
    const botao = $('analisar-midia'); botao.disabled = true; botao.textContent = 'Analisando…';
    try {
        const resposta = await cliente.solicitar('/astra/generate', { model: modelo.id, imagem, prompt: 'Analise a mídia e retorne SOMENTE JSON {"fatos":["..."],"texto":["..."]}. Separe fatos de OCR. Não invente dados.' }, { prazo: 120000 });
        const bruto = resposta.astra?.text?.match(/\{[\s\S]*\}/)?.[0];
        const dados = bruto ? JSON.parse(bruto) : null;
        if (!dados || !Array.isArray(dados.fatos) || !Array.isArray(dados.texto)) throw new Error('Formato inesperado.');
        atual.fatosIa = dados.fatos.filter(i => typeof i === 'string').join('\n');
        atual.textoMidia = dados.texto.filter(i => typeof i === 'string').join('\n');
        $('fatosIa').value = atual.fatosIa; $('textoMidia').value = atual.textoMidia;
        marcarAlterado(); renderizarRevisao(); avisar('Análise concluída.');
    } catch (erro) { avisar(`Não foi possível analisar: ${erro.message}`); }
    finally { botao.disabled = false; botao.textContent = 'Analisar mídia com IA'; }
}

// ============================================================
// PUBLICAÇÃO IMEDIATA
// ============================================================

async function verificarServidor() {
    $('atualizar-conexao').disabled = true; $('status-servidor').textContent = 'Verificando servidor…';
    try {
        const dados = await cliente.solicitar('/health');
        if (dados.status !== 'ok') throw new Error('O servidor não confirmou seu estado.');
        servidorOnline = true;
        $('status-servidor').textContent = 'Servidor online';
        $('detalhes-servidor').textContent = `Instagram: ${dados.instagramConfigured ? 'configurado' : 'não configurado'} · IA: ${dados.aiConfigured ? 'configurada' : 'não'} · Mídia: ${dados.mediaStorageConfigured ? 'pronta' : 'não'} · ${dados.timezone}`;
    } catch (erro) {
        servidorOnline = false; perfilInstagram = undefined;
        $('status-servidor').textContent = erro.codigo === 'OFFLINE' ? 'Servidor local offline.' : erro.message;
        $('status-instagram').textContent = 'Instagram ainda não verificado.';
    } finally { $('atualizar-conexao').disabled = false; renderizarRevisao(); }
}

async function verificarInstagram() {
    $('testar-instagram').disabled = true; perfilInstagram = undefined;
    $('status-instagram').textContent = 'Verificando Instagram…';
    try {
        const dados = await cliente.solicitar('/meta/me', undefined, { prazo: 20000 });
        if (dados.success !== true || !dados.profile?.id) throw new Error('O servidor não confirmou o perfil.');
        perfilInstagram = { ...dados.profile, destinoId: dados.publishingAccountId || dados.profile.id };
        $('status-instagram').textContent = `Instagram conectado${perfilInstagram.username ? ' · @' + perfilInstagram.username : ''} · ID ${perfilInstagram.id}`;
    } catch (erro) { $('status-instagram').textContent = erro.message; }
    finally { $('testar-instagram').disabled = false; renderizarRevisao(); }
}

function montarEntradaPublicacao() {
    if (atual.tipoMidia === 'carrossel') return { formato: 'carrossel', itens: atual.imagens.map(item => ({ tipo: item.tipo, url: urlPublicaDaMidia(item) })), caption: R.compor(atual) };
    if (atual.tipoMidia === 'reel') return { formato: 'reel', videoUrl: atual.videoUrl.trim(), caption: R.compor(atual) };
    return { formato: 'imagem', imageUrl: atual.imagemUrl.trim(), caption: R.compor(atual) };
}

function renderizarStatusPublicacao() {
    const alvo = $('status-publicacao');
    if (!alvo) return;
    const estado = Publicacoes.statusPublicacaoVisual(atual);
    alvo.className = estado.classe;
    alvo.textContent = `STATUS DA PUBLICAÇÃO: ${estado.texto}`;
    if (atual.permalink) {
        const link = elemento('a', 'Abrir no Instagram', 'nota');
        link.href = atual.permalink; link.target = '_blank'; link.rel = 'noopener';
        alvo.append(document.createElement('br'), link);
    }
}

function prepararPublicacao() {
    if (atual.statusPublicacao === 'publicado') { avisar('Esta publicação já foi enviada ao Instagram.'); return; }
    if (atual.estado !== 'confirmado' || IR.validarInstagram(atual, R).some(i => !i.ok)) { avisar('Confirme o conteúdo na Revisão antes de publicar.'); return; }
    const entrada = montarEntradaPublicacao();
    confirmacaoAtual = { id: atual.id, assinatura: IR.assinaturaConteudo(atual), entrada, conta: perfilInstagram?.destinoId || null };
    $('conta-confirmacao').textContent = perfilInstagram
        ? `Perfil: ${perfilInstagram.username ? '@' + perfilInstagram.username : perfilInstagram.id}.`
        : 'Perfil não verificado nesta sessão; o backend usará a conta configurada.';
    $('midia-confirmacao').textContent = entrada.formato === 'carrossel' ? `${entrada.itens.length} itens` : (entrada.videoUrl || entrada.imageUrl);
    $('legenda-confirmacao').textContent = entrada.caption;
    $('autorizo-publicacao').checked = false; $('confirmar-publicacao').disabled = true;
    $('confirmar-publicacao').textContent = 'Publicar agora';
    $('confirmacao-publicacao').showModal();
}

async function confirmarPublicacao() {
    const confirmacao = confirmacaoAtual;
    if (!confirmacao || enviandoPublicacao || !$('autorizo-publicacao').checked) return;
    if (atual.id !== confirmacao.id || IR.assinaturaConteudo(atual) !== confirmacao.assinatura) { $('confirmacao-publicacao').close(); confirmacaoAtual = undefined; avisar('O conteúdo mudou. Revise novamente.'); return; }
    enviandoPublicacao = true;
    atual.statusPublicacao = 'publicando';
    $('confirmar-publicacao').disabled = true; $('confirmar-publicacao').textContent = 'Publicando…'; $('cancelar-publicacao').disabled = true;
    const tentativa = { estado: 'enviando', tentativaId: crypto.randomUUID(), iniciadoEm: new Date().toISOString() };
    atual.publicacaoReal = tentativa; marcarAlterado(); renderizarStatusPublicacao();
    if (!await salvar(true)) {
        delete atual.publicacaoReal; atual.statusPublicacao = 'nao_publicada';
        enviandoPublicacao = false; $('cancelar-publicacao').disabled = false; $('confirmar-publicacao').disabled = false; $('confirmar-publicacao').textContent = 'Publicar agora';
        $('confirmacao-publicacao').close(); confirmacaoAtual = undefined; renderizarStatusPublicacao(); avisar('Envio cancelado.');
        return;
    }
    $('confirmacao-publicacao').close(); confirmacaoAtual = undefined;
    try {
        const resposta = await cliente.solicitar('/instagram/publish', { ...confirmacao.entrada, publicationId: atual.id }, { prazo: 270000, id: tentativa.tentativaId });
        if (resposta.success !== true || !resposta.published?.id) throw new Error(resposta.error || 'O servidor não confirmou a publicação.');
        tentativa.estado = 'publicado'; tentativa.idPublicado = resposta.published.id; tentativa.finalizadoEm = new Date().toISOString();
        Publicacoes.registrarPublicacao(atual, { mediaId: resposta.media_id || resposta.published.id, permalink: resposta.permalink, publicadoEm: resposta.published_at });
        avisar('✓ Publicado no Instagram. Publicação concluída com sucesso. Métricas ainda não disponíveis.');
        renderizarMetricasResumo();
    } catch (erro) {
        tentativa.estado = 'incerto'; tentativa.mensagem = erro.message;
        Publicacoes.registrarPublicacao(atual, { erro: erro.message });
        avisar(`✗ Não foi possível publicar no Instagram: ${erro.message}`);
    }
    finally {
        enviandoPublicacao = false; $('cancelar-publicacao').disabled = false;
        $('confirmar-publicacao').disabled = false; $('confirmar-publicacao').textContent = 'Publicar agora';
        renderizarRevisao(); renderizarStatusPublicacao(); await salvar(true);
    }
}

// ============================================================
// PUBLICAÇÕES ANTERIORES
// ============================================================

function trecho(texto, tamanho = 90) { const limpo = String(texto || '').replace(/\s+/g, ' ').trim(); return limpo.length > tamanho ? limpo.slice(0, tamanho) + '…' : limpo; }

async function carregarAnteriores(reset = false) {
    const lista = $('anteriores-lista');
    if (reset) { anteriores = []; anterioresCursor = null; lista.replaceChildren(); }
    $('anteriores-status').textContent = 'Carregando publicações anteriores…';
    try {
        const resposta = await cliente.solicitar('/instagram/media', undefined, { prazo: 30000, params: { limite: 25, ...(anterioresCursor ? { cursor: anterioresCursor } : {}) } });
        anteriores = [...anteriores, ...(resposta.itens || [])];
        anterioresCursor = resposta.proximoCursor || null;
        renderizarAnteriores();
        $('anteriores-total').textContent = `${anteriores.length}`;
        $('anteriores-status').textContent = anteriores.length ? 'Selecione uma publicação para usar como base.' : 'Nenhuma publicação encontrada.';
        $('anteriores-mais').hidden = !anterioresCursor;
    } catch (erro) {
        $('anteriores-status').textContent = erro.codigo === 'INSTAGRAM_NAO_CONFIGURADO' ? 'Instagram não configurado no servidor.' : erro.message;
        $('anteriores-mais').hidden = true;
    }
}

function renderizarAnteriores() {
    const lista = $('anteriores-lista');
    lista.replaceChildren();
    anteriores.forEach(item => {
        const cartao = elemento('button', undefined, 'cartao-anterior');
        cartao.type = 'button';
        if (item.miniatura) { const img = elemento('img'); img.src = item.miniatura; img.alt = 'Miniatura'; img.loading = 'lazy'; cartao.append(img); }
        const info = elemento('div');
        info.append(elemento('strong', `${item.formato || 'publicação'}`), elemento('small', item.publicadoEm ? new Date(item.publicadoEm).toLocaleString('pt-BR') : 'data n/i'));
        info.append(elemento('p', trecho(item.legenda) || '(sem legenda)', 'nota'));
        cartao.append(info);
        cartao.onclick = () => selecionarAnterior(item);
        lista.append(cartao);
    });
}

function selecionarAnterior(item) {
    anteriorSelecionada = item;
    const detalhe = $('anterior-detalhe');
    detalhe.replaceChildren();
    const bloco = elemento('div', undefined, 'cartao');
    bloco.append(elemento('strong', `${item.formato || 'publicação'} · ${item.publicadoEm ? new Date(item.publicadoEm).toLocaleString('pt-BR') : 'data n/i'}`));
    if (item.permalink) { const link = elemento('a', 'Abrir no Instagram', 'nota'); link.href = item.permalink; link.target = '_blank'; link.rel = 'noopener'; bloco.append(link); }
    bloco.append(elemento('p', trecho(item.legenda, 400) || '(sem legenda)', 'texto-final'));
    const acoes = elemento('div', undefined, 'acoes');
    const base = elemento('button', 'Usar como base'); base.type = 'button'; base.onclick = usarComoBase;
    const copiar = elemento('button', 'Copiar legenda'); copiar.type = 'button'; copiar.onclick = () => { atual.legenda = item.legenda || ''; if ($('legenda')) $('legenda').value = atual.legenda; marcarAlterado(); renderizarRevisao(); avisar('Legenda copiada para a publicação atual.'); };
    const metricas = elemento('button', 'Atualizar métricas'); metricas.type = 'button'; metricas.onclick = () => atualizarMetricas([item]);
    acoes.append(base, copiar, metricas);
    bloco.append(acoes);
    detalhe.replaceChildren(bloco);
}

/** Cria uma nova publicação local a partir de uma anterior; nunca altera o original. */
function usarComoBase() {
    if (!anteriorSelecionada) return;
    const nova = aplicarRecorrentesEm(R.criarConteudo());
    nova.titulo = `Base: ${trecho(anteriorSelecionada.legenda, 40) || anteriorSelecionada.id}`;
    nova.legenda = anteriorSelecionada.legenda || '';
    nova.tipoMidia = anteriorSelecionada.formato === 'reel' ? 'reel' : anteriorSelecionada.formato === 'carrossel' ? 'carrossel' : 'imagem';
    if (templatePadrao.aplicarAutomatico && !nova.templateTexto) nova.templateTexto = templatePadrao.texto;
    nova.referenciaImportada = anteriorSelecionada.id;
    conteudos.push(nova); atual = nova;
    marcarAlterado(); sincronizarCampos(); renderizarMidias(); renderizarRevisao(); atualizarSeletorConteudos(); abrirAba('midia');
    avisar('Nova publicação criada a partir da anterior. O post original não foi alterado.');
}

// ============================================================
// MÉTRICAS / ANÁLISE / DESEMPENHO
// ============================================================

async function atualizarMetricas(itens) {
    const alvos = itens && itens.length ? itens : anteriores;
    if (!alvos.length) { $('metricas-resumo').textContent = 'Nenhuma publicação anterior carregada.'; return; }
    $('metricas-atualizar').disabled = true; $('metricas-resumo').textContent = 'Consultando métricas orgânicas…';
    try {
        const resposta = await cliente.solicitar('/instagram/metrics/update', { itens: alvos.map(i => ({ id: i.id, formato: i.formato, publicadoEm: i.publicadoEm, permalink: i.permalink })) }, { prazo: 120000 });
        $('metricas-resumo').textContent = `Métricas: ${resposta.atualizadas} atualizada(s), ${resposta.ignoradas} em cache, ${(resposta.falhas || []).length} falha(s). Total em cache: ${resposta.total}.`;
        await analisarHorarios();
        renderizarMetricas();
    } catch (erro) { $('metricas-resumo').textContent = `Não foi possível atualizar: ${erro.message}`; }
    finally { $('metricas-atualizar').disabled = false; }
}

async function analisarHorarios() {
    try {
        const resposta = await cliente.solicitar('/instagram/analysis', undefined, { prazo: 20000, params: { timezone: $('periodo-timezone')?.value || 'Asia/Tokyo' } });
        analiseAtual = resposta;
        renderizarAnalise();
        return resposta;
    } catch (erro) { $('analise-resumo').textContent = `Não foi possível analisar: ${erro.message}`; return null; }
}

function renderizarAnalise() {
    const resumo = $('analise-resumo'); const lista = $('analise-lista');
    lista.replaceChildren();
    if (!analiseAtual) { resumo.textContent = 'Execute "Analisar melhores horários".'; return; }
    resumo.textContent = analiseAtual.mensagem;
    if (!analiseAtual.suficiente) { lista.append(elemento('p', 'Dados insuficientes para recomendação forte.', 'pendente')); }
    for (const h of analiseAtual.melhoresHorarios || []) lista.append(elemento('div', `${h.hora} — score ${h.score} (${h.amostras} amostra(s))`, 'agenda-item'));
}

function renderizarMetricas() {
    const tabela = $('metricas-tabela');
    tabela.replaceChildren();
    // A tabela usa o cache conhecido exibido em analiseAtual (postsAnalisados) e no detalhe.
    if (analiseAtual) tabela.append(elemento('p', `Posts analisados: ${analiseAtual.postsAnalisados} · Score médio: ${analiseAtual.scoreMedio}`, 'nota'));
}

function renderizarDesempenho() {
    const resumo = $('desempenho-resumo');
    resumo.replaceChildren();
    if (!analiseAtual) { resumo.append(elemento('p', 'Atualize as métricas e analise os melhores horários.', 'nota')); return; }
    const disponiveis = analiseAtual.metricasDisponiveis || {};
    const linhas = [
        ['Melhor dia observado', analiseAtual.melhorDia ? `${analiseAtual.melhorDia.dia} (score ${analiseAtual.melhorDia.score})` : 'não informado'],
        ['Melhor faixa horária', analiseAtual.melhorFaixa ? `${analiseAtual.melhorFaixa.hora} (score ${analiseAtual.melhorFaixa.score})` : 'não informada'],
        ['Posts analisados', String(analiseAtual.postsAnalisados)],
        ['Score médio', String(analiseAtual.scoreMedio)],
        ['Curtidas (total)', analiseAtual.totais?.curtidas ? String(analiseAtual.totais.curtidas) : 'não informado'],
        ['Comentários (total)', analiseAtual.totais?.comentarios ? String(analiseAtual.totais.comentarios) : 'não informado'],
        ['Alcance', disponiveis.alcance ? String(analiseAtual.totais.alcance || '') : 'não disponível nesta conta'],
        ['Confiança', analiseAtual.confianca || 'Baixa'],
        ['Última atualização', analiseAtual.ultimaAtualizacao ? new Date(analiseAtual.ultimaAtualizacao).toLocaleString('pt-BR') : 'não informada']
    ];
    for (const [rotulo, valor] of linhas) resumo.append(elemento('div', `${rotulo}: ${valor}`, 'agenda-item'));
}

/** Explica de onde saiu a recomendação automática de horários. */
function renderizarBaseAnalise() {
    const container = $('base-analise');
    if (!container) return;
    container.replaceChildren();
    if (!analiseAtual) { container.append(elemento('p', 'Nenhuma análise executada ainda. Use "Analisar melhores horários" na aba Desempenho.', 'nota')); return; }
    const d = analiseAtual.metricasDisponiveis || {};
    const lista = [['Curtidas', d.curtidas], ['Comentários', d.comentarios], ['Alcance', d.alcance], ['Impressões', d.impressoes], ['Salvamentos', d.salvamentos], ['Compartilhamentos', d.compartilhamentos]];
    for (const [nome, ok] of lista) container.append(elemento('div', `${ok ? '✓' : '○'} ${ok ? nome : nome + ' indisponível'}`, ok ? 'ok' : 'nota'));
    const periodos = analiseAtual.periodo ? `${new Date(analiseAtual.periodo.inicio).toLocaleDateString('pt-BR')} a ${new Date(analiseAtual.periodo.fim).toLocaleDateString('pt-BR')}` : 'não informado';
    container.append(elemento('div', `Posts analisados: ${analiseAtual.postsAnalisados}`, 'agenda-item'));
    container.append(elemento('div', `Período analisado: ${periodos}`, 'agenda-item'));
    container.append(elemento('div', `Última atualização: ${analiseAtual.ultimaAtualizacao ? new Date(analiseAtual.ultimaAtualizacao).toLocaleString('pt-BR') : 'não informada'}`, 'agenda-item'));
    container.append(elemento('div', `Confiança: ${analiseAtual.confianca || 'Baixa'}`, 'agenda-item'));
    container.append(elemento('p', analiseAtual.mensagem, analiseAtual.suficiente ? 'nota' : 'pendente'));
    const ranking = elemento('ol');
    for (const item of analiseAtual.melhoresHorarios || []) ranking.append(elemento('li', `${item.hora} — score ${item.score} (${item.amostras} amostra(s))`));
    container.append(elemento('p', 'Melhores horários encontrados:', 'nota'), ranking);
}

/** Nota de disponibilidade de métricas após publicar. */
function renderizarMetricasResumo() {
    const alvo = $('metricas-resumo');
    if (alvo) alvo.textContent = 'Publicação concluída. Métricas ainda não disponíveis. Use "Atualizar métricas" mais tarde.';
}

async function reotimizar() {
    if (!planoPeriodo || !planoPeriodo.itens.length) { avisar('Gere um plano por período antes de reotimizar.'); return; }
    if (!analiseAtual || !analiseAtual.melhoresHorarios?.length) { avisar('Sem análise disponível. Atualize as métricas e analise os horários.'); return; }
    const horarios = analiseAtual.melhoresHorarios.map(h => h.hora);
    const agora = Date.now();
    const preview = $('reotimizar-preview'); preview.replaceChildren();
    const previsoes = [];
    let indice = 0;
    for (const item of planoPeriodo.itens) {
        if (['confirmada', 'publicado', 'cancelado', 'em andamento'].includes(item.status)) continue;
        const instante = Date.parse(item.scheduledAt || `${item.data}T${item.hora}:00Z`);
        if (Number.isFinite(instante) && instante <= agora) continue;
        const horaNova = horarios[indice % horarios.length]; indice += 1;
        if (horaNova === item.hora) continue;
        previsoes.push({ id: item.id, data: item.data, horaAnterior: item.hora, horaNova });
    }
    if (!previsoes.length) { preview.append(elemento('p', 'Nenhum item futuro a reotimizar.', 'nota')); return; }
    for (const p of previsoes) preview.append(elemento('div', `${p.data}: ${p.horaAnterior} → ${p.horaNova}`, 'agenda-item'));
    const aplicar = elemento('button', 'Aplicar reotimização'); aplicar.type = 'button';
    aplicar.onclick = async () => {
        for (const p of previsoes) {
            const item = planoPeriodo.itens.find(i => i.id === p.id);
            if (item) { item.hora = p.horaNova; item.status = 'rascunho'; item.approvalSignature = null; }
        }
        planoPeriodo = PS.aprovar(planoPeriodo);
        try { await cliente.solicitar('/agenda/planos', { planos: [planoPeriodo] }, { prazo: 15000 }); avisar('Horários pendentes reotimizados.'); }
        catch (erro) { avisar(`Reotimização local; o servidor não confirmou: ${erro.message}`); }
        renderizarPeriodoPrevia(); preview.replaceChildren();
    };
    preview.append(aplicar);
}

// ============================================================
// AGENDAMENTO POR PERÍODO
// ============================================================

function lerConfigPeriodo() {
    const varMode = document.querySelector('input[name=periodo-var]:checked')?.value || 'nao';
    const modo = $('periodo-modo').value;
    return {
        id: planoPeriodo?.id || `periodo-${crypto.randomUUID()}`,
        nome: `Plano ${$('periodo-inicio').value}–${$('periodo-fim').value}`,
        inicio: $('periodo-inicio').value,
        fim: $('periodo-fim').value,
        timezone: $('periodo-timezone').value || 'Asia/Tokyo',
        quantidade: modo === 'total' ? Number($('periodo-quantidade').value) : 0,
        porDia: modo === 'porDia' ? Number($('periodo-por-dia').value) : 0,
        intervaloMinimoHoras: Number($('periodo-intervalo-min').value) || 0,
        intervaloMaximoHoras: $('periodo-intervalo-max').value ? Number($('periodo-intervalo-max').value) : null,
        estrategiaHorario: $('periodo-horario-modo').value,
        horarios: String($('periodo-horarios').value || '').split(',').map(s => s.trim()).filter(Boolean),
        diasPermitidos: [...document.querySelectorAll('.periodo-dia')].filter(i => i.checked).map(i => Number(i.value)),
        variarTexto: varMode === 'ia',
        nivelVariacao: $('periodo-nivel').value,
        permitirReutilizacao: $('periodo-reutilizar').checked === true,
        tipos: ['imagem', 'video', 'carrossel'],
        destinos: ['Instagram'],
        atraso: 'reagendar', toleranciaMinutos: 30
    };
}

async function gerarPeriodo() {
    const config = lerConfigPeriodo();
    const melhoresHorarios = (analiseAtual?.melhoresHorarios || []).length ? analiseAtual.melhoresHorarios : (await analisarHorarios())?.melhoresHorarios || [];
    const plano = PS.planejarPeriodo(config, ctxMidias(), { melhoresHorarios });
    planoPeriodo = plano;
    selecionadosPeriodo = new Set(plano.itens.map(i => i.id));
    renderizarPeriodoPrevia();
    $('periodo-confirmar').disabled = !plano.itens.length;
    $('periodo-status').textContent = plano.erros.length ? plano.erros.join(' ') : `Prévia com ${plano.itens.length} publicação(ões). Confirme para agendar.`;
    $('periodo-status').className = plano.erros.length ? 'pendente' : 'ok';
}

function ctxMidias() { return globalThis.AstraContexto?.obterMidias?.() || bibliotecaMidias; }

function renderizarPeriodoPrevia() {
    const container = $('periodo-previa'); container.replaceChildren();
    if (!planoPeriodo) return;
    for (const item of planoPeriodo.itens) {
        const linha = elemento('div', undefined, 'agenda-item');
        linha.append(elemento('div', `${item.data} ${item.hora} · ${item.tipo} · ${item.status} · v${item.versao}${item.variarTexto ? ' · variação ' + item.nivelVariacao : ''}`));
        linha.append(elemento('p', trecho(item.legenda) || '(legenda vazia)', 'nota'));
        container.append(linha);
    }
}

/** Opcionalmente varia apenas a parte principal, preservando template/links/hashtags. */
async function aplicarVariacoes(plano) {
    if (!plano?.itens?.some(i => i.variarTexto)) return plano;
    for (const item of plano.itens) {
        if (!item.variarTexto || !item.legenda) continue;
        try {
            const modelo = modelosDisponiveis.find(m => m.id === $('modelo-astra').value);
            if (!modelo) break;
            const protegidas = R.partesProtegidas(atual);
            const resposta = await cliente.solicitar('/astra/generate', { prompt: `Reescreva levemente (nível ${item.nivelVariacao}) mantendo TODAS estas partes exatamente: ${protegidas.join(' | ')}. Retorne só a legenda.\n\nLegenda:\n${item.legenda}`, model: modelo.id }, { prazo: 90000 });
            const variacao = resposta.astra?.text?.trim();
            const validacao = R.validarVariacao(item.legenda, variacao, protegidas);
            if (validacao.valido) { item.legenda = variacao; item.versao = (item.versao || 1) + 1; }
        } catch { /* mantém o texto original se a IA falhar */ }
    }
    return plano;
}

async function confirmarPeriodo() {
    if (!planoPeriodo || !planoPeriodo.itens.length) { avisar('Gere o agendamento antes de confirmar.'); return; }
    $('periodo-confirmar').disabled = true;
    await aplicarVariacoes(planoPeriodo);
    planoPeriodo = PS.aprovar(planoPeriodo);
    let sincronizado = null;
    try { sincronizado = await cliente.solicitar('/agenda/planos', { planos: [planoPeriodo] }, { prazo: 15000 }); }
    catch (erro) { avisar(`Plano aprovado localmente; servidor não confirmou: ${erro.message}`); }
    renderizarPeriodoPrevia();
    $('periodo-status').textContent = sincronizado
        ? `Plano confirmado: ${planoPeriodo.itens.length} publicação(ões) agendada(s).`
        : 'Plano aprovado localmente; o servidor de execução não confirmou.';
    $('periodo-status').className = sincronizado ? 'ok' : 'pendente';
    registrar('periodo_confirmado', { itens: planoPeriodo.itens.length });
}

// ============================================================
// INICIALIZAÇÃO
// ============================================================

function conectarCampos() {
    for (const campo of ['objetivo', 'tema', 'fatos', 'contexto', 'fatosIa', 'textoMidia', 'hashtags', 'palavras', 'ideias', 'imagemUrl', 'videoUrl', 'legenda', 'titulo']) {
        if (!$(campo)) continue;
        $(campo).oninput = () => { if (campo === 'titulo') atual.titulo = $(campo).value; else atual[campo] = $(campo).value; atual.estado = 'rascunho'; marcarAlterado(); renderizarRevisao(); atualizarSeletorConteudos(); };
    }
    $('tipoMidia').onchange = () => { atual.tipoMidia = $('tipoMidia').value; IR.sincronizarUrlsPublicas(atual); atual.estado = 'rascunho'; marcarAlterado(); sincronizarCampos(); renderizarRevisao(); };
    $('usar-visao').onchange = () => { atual.usarVisao = $('usar-visao').checked; marcarAlterado(); };
    $('arquivos').onchange = async event => { const arquivos = [...event.target.files]; event.target.value = ''; event.target.disabled = true; try { await processarArquivos(arquivos); } finally { event.target.disabled = false; } };
    $('gerar-legenda').onclick = () => gerarLegenda(false);
    $('reescrever-legenda').onclick = () => gerarLegenda(true);
    $('analisar-midia').onclick = analisarMidia;
    $('atualizar-modelos').onclick = () => carregarModelos(true);
    $('modelo-astra').onchange = () => { atual.modeloAstra = $('modelo-astra').value; marcarAlterado(); mostrarModeloSelecionado(); };
    $('revisar').onclick = marcarRevisaoHumana;
    $('aprovar').onclick = async () => {
        if (!IR.midiasPublicasProntas(atual) || R.validar(atual, Date.now(), { exigirMidia: false }).some(i => !i.ok)) { renderizarRevisao(); avisar('Ainda há pendências.'); return; }
        atual.estado = 'confirmado'; marcarAlterado(); renderizarRevisao();
        const salvo = await salvar(true);
        avisar('Conteúdo confirmado');
        if (salvo) abrirAba('agendamento');
    };
    $('salvar').onclick = () => salvarEAvancar();
    $('salvar-recorrentes').onclick = salvarRecorrentesEmpresa;
    $('preparar-publicacao').onclick = prepararPublicacao;
    $('cancelar-publicacao').onclick = () => { confirmacaoAtual = undefined; $('confirmacao-publicacao').close(); };
    $('autorizo-publicacao').onchange = () => { $('confirmar-publicacao').disabled = !$('autorizo-publicacao').checked || enviandoPublicacao; };
    $('confirmar-publicacao').onclick = confirmarPublicacao;
    $('confirmacao-publicacao').oncancel = event => { if (enviandoPublicacao) event.preventDefault(); else confirmacaoAtual = undefined; };
    $('atualizar-conexao').onclick = verificarServidor;
    $('testar-instagram').onclick = verificarInstagram;
    $('salvar').onclick = () => salvar(false);
    $('nova').onclick = novaPublicacao;
    $('conteudo-atual').onchange = () => trocarConteudo($('conteudo-atual').value);
    $('template-salvar').onclick = salvarTemplatePadrao;
    $('template-aplicar').onclick = aplicarTemplateAtual;
    $('template-auto').onchange = () => { templatePadrao.aplicarAutomatico = $('template-auto').checked; };
    $('anteriores-mais').onclick = () => carregarAnteriores(false);
    $('metricas-atualizar').onclick = () => atualizarMetricas();
    $('analise-atualizar').onclick = analisarHorarios;
    $('reotimizar').onclick = reotimizar;
    $('periodo-gerar').onclick = gerarPeriodo;
    $('periodo-confirmar').onclick = confirmarPeriodo;
    document.querySelectorAll('[role=tab][data-aba]').forEach((tab, indice, abas) => {
        tab.onclick = () => abrirAba(tab.dataset.aba);
        tab.onkeydown = event => { const passo = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0; if (!passo) return; event.preventDefault(); const destino = (indice + passo + abas.length) % abas.length; abrirAba(abas[destino].dataset.aba, true); };
    });
    const fuso = $('periodo-timezone');
    if (fuso && !fuso.value) fuso.value = 'Asia/Tokyo';
}

function restaurarDatasPeriodo() {
    if ($('periodo-inicio') && !$('periodo-inicio').value) $('periodo-inicio').value = new Date().toISOString().slice(0, 10);
    if ($('periodo-fim') && !$('periodo-fim').value) { const fim = new Date(`${$('periodo-inicio').value}T12:00:00Z`); fim.setUTCDate(fim.getUTCDate() + 5); $('periodo-fim').value = fim.toISOString().slice(0, 10); }
}

async function iniciar() {
    aplicarMarca(); conectarCampos();
    try {
        banco = await new Promise((resolve, reject) => {
            const abertura = indexedDB.open('astra-instagram', 2);
            abertura.onupgradeneeded = () => { if (!abertura.result.objectStoreNames.contains('conteudos')) abertura.result.createObjectStore('conteudos'); };
            abertura.onsuccess = () => resolve(abertura.result);
            abertura.onerror = () => reject(abertura.error);
        });
        templateRequisitosFixo = await lerArmazenamento('template-requisitos-fixo');
        agendaEmpresa = await lerArmazenamento('agenda-empresa');
        const midiasSalvas = await lerArmazenamento('biblioteca-midias');
        if (Array.isArray(midiasSalvas)) bibliotecaMidias = midiasSalvas;
        const salvos = await lerArmazenamento('conteudos');
        if (Array.isArray(salvos) && salvos.length) { conteudos = salvos.map(p => Publicacoes.migrarPublicacao(p)); atual = conteudos[0]; $('salvamento').textContent = 'Conteúdos restaurados deste navegador'; }
        try { const config = await cliente.solicitar('/empresa/template-padrao', undefined, { prazo: 10000 }); if (config?.templatePadrao) templatePadrao = config.templatePadrao; } catch { /* offline */ }
    } catch { avisar('Armazenamento local indisponível.'); }
    if (!atual.templateTexto && templatePadrao.texto) atual.templateTexto = templatePadrao.texto;
    IR.sincronizarUrlsPublicas(atual);
    sincronizarCampos(); carregarTemplateNoCampo(); atualizarSeletorConteudos(); preencherCamposRecorrentes();
    renderizarMidias(); renderizarRevisao(); renderizarPeriodoPrevia(); renderizarAnalise(); renderizarDesempenho(); renderizarBaseAnalise(); renderizarStatusPublicacao();
    restaurarDatasPeriodo();
    window.iniciarDiagnostico?.((rota, corpo, opcoes) => cliente.solicitar(rota, corpo, opcoes));
    verificarServidor(); carregarModelos(); carregarAnteriores(true); carregarRecorrentes();
    globalThis.AstraContexto = {
        avisar,
        cliente: (rota, corpo, opcoes) => cliente.solicitar(rota, corpo, opcoes),
        ler: lerArmazenamento,
        gravar: salvarArmazenamento,
        obterMidias: () => bibliotecaMidias,
        registrarDiagnostico: (secao, evento, dados) => registrar(evento, dados)
    };
    window.AstraContexto = globalThis.AstraContexto;
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
else iniciar();
