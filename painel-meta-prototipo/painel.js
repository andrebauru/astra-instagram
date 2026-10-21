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
const Fluxo = globalThis.FluxoEditorial;
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
let perfilFacebook;
let integracoesCarregadas = {};
const camposIntegracoes = ['META_APP_ID', 'META_APP_SECRET', 'META_LOGIN_CONFIG_ID', 'META_REDIRECT_URI', 'FACEBOOK_GRAPH_VERSION', 'INSTAGRAM_ACCOUNT_ID', 'INSTAGRAM_ACCESS_TOKEN', 'FACEBOOK_PAGE_ID', 'FACEBOOK_PAGE_ACCESS_TOKEN', 'OPENROUTER_API_KEY', 'META_GRAPH_VERSION'];

/** Mostra IDs e apenas a presença dos segredos armazenados no backend. */
async function carregarIntegracoes() {
    try {
        const resposta = await cliente.solicitar('/config/integracoes');
        integracoesCarregadas = resposta.configuracoes;
        for (const campo of camposIntegracoes) {
            const input = $('config-' + campo);
            if (input.type === 'password') { input.value = ''; input.placeholder = resposta.configuracoes[campo] ? 'Configurado · deixe vazio para manter' : 'Não configurado'; }
            else input.value = resposta.configuracoes[campo] || '';
        }
    } catch (erro) { $('status-integracoes').textContent = erro.message; }
}

/** Salva credenciais sem persistir segredos no estado editorial ou no navegador. */
async function salvarIntegracoes(evento) {
    evento.preventDefault();
    $('salvar-integracoes').disabled = true;
    try {
        const entrada = Object.fromEntries(camposIntegracoes.filter(campo => {
            const input = $('config-' + campo);
            return input.type === 'password' ? Boolean(input.value.trim()) : input.value !== (integracoesCarregadas[campo] || '');
        }).map(campo => [campo, $('config-' + campo).value]));
        await cliente.solicitar('/config/integracoes', entrada);
        if (['INSTAGRAM_ACCOUNT_ID', 'INSTAGRAM_ACCESS_TOKEN', 'META_GRAPH_VERSION'].some(campo => Object.hasOwn(entrada, campo))) {
            perfilInstagram = undefined;
            $('status-instagram').textContent = 'Configuração alterada. Teste novamente o Instagram.';
        }
        perfilFacebook = undefined;
        $('status-facebook').textContent = 'Configuração alterada. Teste novamente a Página.';
        $('status-integracoes').textContent = 'Configurações salvas no backend. O .env não foi alterado.';
        await carregarIntegracoes(); atualizarControlesStory(); renderizarRevisao();
        await window.MetaConexao?.carregar();
    } catch (erro) { $('status-integracoes').textContent = erro.message; }
    finally { for (const campo of camposIntegracoes) if ($('config-' + campo).type === 'password') $('config-' + campo).value = ''; $('salvar-integracoes').disabled = false; }
}

/** Verifica a Página sem criar qualquer publicação. */
async function testarFacebook() {
    $('testar-facebook').disabled = true; perfilFacebook = undefined;
    try {
        const resposta = await cliente.solicitar('/facebook/me');
        if (!resposta.profile?.id) throw new Error('A Página não retornou um ID válido.');
        perfilFacebook = resposta.profile;
        $('status-facebook').textContent = `Página: ${perfilFacebook.name || ''} · ID ${perfilFacebook.id}`;
    } catch (erro) { $('status-facebook').textContent = erro.message; }
    finally { $('testar-facebook').disabled = false; renderizarRevisao(); }
}

/**
 * Restaura o estado das conexões a partir do backend (fonte de verdade) para
 * que o botão "Publicar agora" não dependa de cliques manuais nem de reload.
 * Somente leituras: Instagram (/meta/me) e estado do assistente (/meta/conexao).
 */
async function restaurarConexoes() {
    try { await verificarInstagram(); } catch { /* Instagram indisponível; mantém o estado atual. */ }
    try {
        const resposta = await cliente.solicitar('/meta/conexao', undefined, { prazo: 8000 });
        const pagina = resposta?.conexao?.pagina;
        if (resposta?.conexao?.estado === 'conectado' && pagina?.id) {
            perfilFacebook = { id: pagina.id, name: pagina.nome };
            $('status-facebook').textContent = `Página conectada: ${pagina.nome} · ID ${pagina.id}`;
        }
    } catch { /* Sem conexão Facebook; o destino Facebook permanece opcional. */ }
    renderizarRevisao();
}

/** Exige conexão verificada somente para os destinos escolhidos (regra central). */
function destinosVerificados() {
    const alvo = new Set(['Ao menos um destino selecionado', 'Instagram verificado', 'Página Facebook verificada', 'Story Instagram requer conta Business verificada']);
    return elegibilidadePublicacaoAtual().itens.filter(item => alvo.has(item.texto)).every(item => item.ok);
}
let servidorOnline = false;
let templateRequisitosFixo;
let agendaEmpresa;
let temporizadorEmpresa;
let templatePadrao = { texto: '', aplicarAutomatico: false };
let templatesBiblioteca = [];
let templateSelecionadoId = '';
let anteriores = [];
let anterioresCursor = null;
let anteriorSelecionada = null;
let analiseAtual = null;
let planoPeriodo = null;
let selecionadosPeriodo = new Set();
let ultimoSalvamentoServidor = false;

function aplicarMarca() { document.title = 'Astra Instagram · Estúdio de publicações'; document.documentElement.dataset.aplicativo = 'Astra Instagram'; }
function elemento(tag, texto, classe) { const el = document.createElement(tag); if (texto !== undefined) el.textContent = texto; if (classe) el.className = classe; return el; }
function avisar(texto) { const alvo = $('mensagem'); if (!alvo) return; alvo.textContent = texto; clearTimeout(temporizador); temporizador = setTimeout(() => { alvo.textContent = ''; }, 8000); }
function formatarBytes(bytes) { const v = Number(bytes) || 0; if (v < 1024) return `${v} B`; if (v < 1048576) return `${(v / 1024).toFixed(1)} KB`; return `${(v / 1048576).toFixed(1)} MB`; }
function registrar(evento, dados = {}) { window.registrarDiagnostico?.('EDITOR', evento, dados); window.AstraLogs?.registrar({ modulo: 'EDITOR', acao: evento, ...dados }); }
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
        const sincronizado = await sincronizarPublicacaoBackend(atual);
        ultimoSalvamentoServidor = sincronizado;
        let cacheLocalSalvo = true;
        try {
            await salvarArmazenamento('conteudos', conteudos);
            try { await salvarArmazenamento('biblioteca-midias', bibliotecaMidias); } catch { /* melhor esforço */ }
        } catch (erro) {
            cacheLocalSalvo = false;
            if (!sincronizado) throw erro;
        }
        $('salvamento').textContent = sincronizado
            ? cacheLocalSalvo ? 'Rascunho salvo no servidor · ' + new Date().toLocaleTimeString('pt-BR') : 'Rascunho salvo no servidor · cache local indisponível'
            : 'Somente neste navegador · sincronização pendente';
        if (!silencioso) avisar('✓ Salvo');
        registrar('rascunho_salvo', { status: sincronizado ? 'servidor' : 'local', operationId: atual.id });
        return true;
    } catch { if (!silencioso) avisar('Não foi possível salvar.'); registrar('rascunho_salvar_falhou', { nivel: 'ERROR', status: 'falhou', operationId: atual.id }); return false; }
}
function marcarAlterado() { if (atual) atual.atualizadoEm = new Date().toISOString(); $('salvamento').textContent = 'Alterações ainda não salvas'; }

/** Remove arquivos locais antes de enviar o rascunho ao backend. */
function publicacaoParaBackend(publicacao) {
    const copia = structuredClone(publicacao);
    copia.atualizadoEm ||= new Date().toISOString();
    copia.imagens = (copia.imagens || []).map(({ dados, miniatura, ...midia }) => midia);
    return copia;
}

/** Sincroniza um rascunho e mantém o IndexedDB apenas como cache/fallback. */
async function sincronizarPublicacaoBackend(publicacao) {
    if (!servidorOnline || !publicacao?.id) return false;
    try {
        const resposta = await cliente.solicitar('/publicacoes', { publicacao: publicacaoParaBackend(publicacao) }, { prazo: 15000 });
        publicacao.atualizadoEm = resposta.publicacao?.atualizadoEm || publicacao.atualizadoEm;
        publicacao.persistencia = 'servidor';
        return true;
    } catch (erro) {
        if (erro.codigo === 'PUBLICACAO_CONFLITO' && erro.publicacao) {
            publicacao.persistencia = 'conflito';
            avisar('Existe uma versão mais nova deste rascunho no servidor. Ela não foi sobrescrita.');
        } else publicacao.persistencia = 'navegador';
        return false;
    }
}

/** Mescla cache local e backend por ID, sem substituir silenciosamente a versão mais nova. */
async function carregarRascunhosBackend() {
    try {
        const resposta = await cliente.solicitar('/publicacoes', undefined, { prazo: 15000 });
        const locais = new Map(conteudos.map(item => [item.id, item]));
        const mesclados = [];
        for (const remotoBruto of resposta.publicacoes || []) {
            const remoto = Publicacoes.migrarPublicacao(remotoBruto);
            const local = locais.get(remoto.id);
            if (!local) { remoto.persistencia = 'servidor'; mesclados.push(remoto); continue; }
            locais.delete(remoto.id);
            const localMaisNovo = Date.parse(local.atualizadoEm || local.criadaEm || 0) > Date.parse(remoto.atualizadoEm || remoto.criadaEm || 0);
            if (localMaisNovo) {
                mesclados.push(local);
                await sincronizarPublicacaoBackend(local);
            } else {
                const arquivosLocais = new Map((local.imagens || []).map(midia => [midia.id, midia]));
                remoto.imagens = (remoto.imagens || []).map(midia => ({ ...midia, dados: arquivosLocais.get(midia.id)?.dados || null, miniatura: arquivosLocais.get(midia.id)?.miniatura || null }));
                remoto.persistencia = 'servidor'; mesclados.push(remoto);
            }
        }
        for (const local of locais.values()) { mesclados.push(local); await sincronizarPublicacaoBackend(local); }
        if (mesclados.length) {
            const idAtual = atual?.id;
            conteudos = mesclados;
            atual = conteudos.find(item => item.id === idAtual) || conteudos[0];
            await salvarArmazenamento('conteudos', conteudos);
        }
        return true;
    } catch { for (const item of conteudos) item.persistencia = 'navegador'; return false; }
}

/** Captura os campos da etapa antes de persistir, inclusive dados recorrentes. */
function sincronizarFormularioNoEstado() {
    for (const campo of ['objetivo', 'tema', 'fatos', 'contexto', 'fatosIa', 'textoMidia', 'hashtags', 'palavras', 'ideias', 'imagemUrl', 'videoUrl', 'legenda', 'titulo']) if ($(campo)) atual[campo] = $(campo).value;
    for (const [id, campo] of [['local', 'local'], ['site', 'site'], ['site1', 'site1'], ['site2', 'site2'], ['maps', 'maps'], ['links-adicionais', 'linksAdicionais'], ['informacoes-fixas', 'informacoesAdicionais'], ['chamadas-fixas', 'chamadasFixas']]) if ($(id)) atual[campo] = $(id).value;
    if ($('hashtags-padrao')?.value.trim()) atual.hashtags = $('hashtags-padrao').value.trim();
    atual.publicarStory = $('publicar-story')?.checked === true;
    atual.publicarFacebookStory = $('publicar-facebook-story')?.checked === true;
    atual.publicarInstagram = $('publicar-instagram')?.checked !== false;
    atual.publicarFacebook = $('publicar-facebook')?.checked === true;
    if ($('template-texto')) atual.templateTexto = $('template-texto').value;
    atual.templateAplicarAutomatico = $('template-auto')?.checked === true;
}

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
    sincronizarFormularioNoEstado();
    const erros = Publicacoes.validarEtapa(etapaAtual, atual, {
        midiaPublicaPronta: IR.midiasPublicasProntas(atual),
        errosDeConteudo: R.validar(atual, Date.now(), { exigirMidia: false }).filter(i => !i.ok).map(i => i.texto)
    });
    const salvo = await salvar(true);
    if (!salvo) { avisar('Não foi possível salvar esta etapa. Os dados permanecem na tela e o avanço foi cancelado.'); return false; }
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
    atualizarRodapeEtapa(nome);
    registrar('tab_change', { tab: nome });
}

/** Mantém o botão de persistência associado visualmente à etapa aberta. */
function atualizarRodapeEtapa(nome = abaAtual()) {
    const rotulos = { midia: 'Mídia', informacoes: 'Informações', ia: 'IA', revisao: 'Revisão', agendamento: 'Agendamento', desempenho: 'Desempenho' };
    const proxima = Publicacoes.proximaEtapa(nome);
    $('etapa-salvar').textContent = `Etapa ${rotulos[nome] || nome}`;
    $('salvar').textContent = proxima ? `Salvar e continuar para ${rotulos[proxima]}` : 'Salvar alterações';
}

/** Separa a republicação do histórico original antes de editar seus campos. */
function prepararReutilizacao() {
    if (atual.statusPublicacao !== 'publicado') return false;
    atual = Publicacoes.reutilizarPublicacao(atual);
    conteudos.push(atual);
    confirmacaoAtual = undefined;
    atualizarSeletorConteudos();
    avisar('Nova cópia para republicação. Original preservado; confira os destinos antes de publicar.');
    return true;
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

/** Lê imagens e MP4 locais, normalizando MIME genérico antes do envio validado. */
async function lerArquivo(arquivo) {
    const imagem = ['image/jpeg', 'image/png', 'image/webp'].includes(arquivo.type);
    const video = /\.mp4$/i.test(arquivo.name) && ['video/mp4', '', 'application/octet-stream'].includes(arquivo.type);
    if ((/\.mp4$/i.test(arquivo.name) || String(arquivo.type).startsWith('video/')) && !video) throw new Error(`${arquivo.name}: Reels exigem MIME video/mp4 e extensão .mp4.`);
    if (!imagem && !video) throw new Error(`${arquivo.name}: use JPEG, PNG, WebP ou MP4.`);
    if (video && !/\.mp4$/i.test(arquivo.name)) throw new Error(`${arquivo.name}: Reels exigem extensão .mp4 e MIME video/mp4.`);
    if (arquivo.size > 256 * 1024 * 1024) throw new Error(`${arquivo.name}: excede o limite de 256 MB.`);
    const dados = await new Promise((resolve, reject) => {
        const leitor = new FileReader();
        leitor.onload = () => resolve(video ? String(leitor.result).replace(/^data:[^,]*,/, 'data:video/mp4;base64,') : leitor.result);
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
    return { id: crypto.randomUUID(), nome: arquivo.name, dados, miniatura: dados, tipo: video ? 'video' : 'imagem', mime: video ? 'video/mp4' : arquivo.type, tamanho: arquivo.size, duracao, status: 'disponível', statusProcessamento: 'concluído', urlPublica: '', statusUpload: 'pendente', tags: [] };
}

function renderizarMidias() {
    const urls = $('urls-publicas-midias'); urls.replaceChildren();
    for (const midia of atual.imagens) {
        const item = elemento('li', `${midia.nome}: `);
        const url = urlPublicaDaMidia(midia);
        if (url) { const link = elemento('a', url); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; item.append(link); }
        else item.append(document.createTextNode(midia.statusUpload === 'enviando' ? 'Enviando…' : 'Aguardando envio'));
        urls.append(item);
    }
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
                prepararReutilizacao();
                atual.estado = 'rascunho';
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
    if (midia.tipo === 'video' && !IR.arquivoReelMp4(midia)) { avisar('Reels exigem arquivo .mp4 com MIME video/mp4.'); return; }
    const conteudo = atual;
    const original = botao?.textContent;
    if (botao) { botao.disabled = true; botao.textContent = 'Enviando…'; }
    midia.statusUpload = 'enviando'; renderizarMidias();
    try {
        const resposta = await cliente.solicitar('/media/upload', { id: midia.id, dados: midia.dados, mime: midia.mime, nome: midia.nome }, { prazo: 660000 });
        if (typeof resposta?.public_url !== 'string' || !resposta.public_url) throw Object.assign(new Error('O servidor não retornou public_url.'), { codigo: 'MIDIA_UPLOAD_RESPOSTA_INVALIDA' });
        const atualizada = Publicacoes.registrarUrlPublica(conteudo, midia.id, resposta.public_url, resposta);
        if (!atualizada) throw Object.assign(new Error('A mídia enviada não foi encontrada no conteúdo atual.'), { codigo: 'MIDIA_NAO_ENCONTRADA' });
        registrar('media_uploaded', { mediaId: midia.id, bytes: atualizada.tamanho });
        marcarAlterado();
        if (conteudo === atual) { sincronizarCampos(); renderizarMidias(); renderizarRevisao(); }
        await salvar(true);
        avisar(`✓ ${midia.tipo === 'video' ? 'Vídeo MP4' : 'Imagem'} enviado. URL pública preenchida.`);
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
    if (acao !== 'distribuir') prepararReutilizacao();
    bibliotecaMidias.push(...lidas); bibliotecaMidias = bibliotecaMidias.slice(-200);
    if (acao === 'carrossel') {
        atual.tipoMidia = 'carrossel'; atual.imagens = [...atual.imagens, ...lidas];
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
        if (lidas.length === 1 && lidas[0].tipo === 'video') atual.tipoMidia = 'reel';
        else if (atual.imagens.length > 1 && atual.imagens.every(midia => midia.tipo === 'imagem')) atual.tipoMidia = 'carrossel';
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
    for (const [id, campo] of [['local', 'local'], ['site', 'site'], ['site1', 'site1'], ['site2', 'site2'], ['maps', 'maps'], ['links-adicionais', 'linksAdicionais'], ['hashtags-padrao', 'hashtags'], ['informacoes-fixas', 'informacoesAdicionais'], ['chamadas-fixas', 'chamadasFixas']]) if ($(id)) $(id).value = atual[campo] || '';
    if ($('titulo')) $('titulo').value = atual.titulo || '';
    if ($('template-texto')) $('template-texto').value = templatePadrao.texto || '';
    if ($('template-auto')) $('template-auto').checked = templatePadrao.aplicarAutomatico === true;
    if ($('publicar-story')) $('publicar-story').checked = atual.publicarStory === true;
    $('publicar-facebook-story').checked = atual.publicarFacebookStory === true;
    if ($('publicar-instagram')) $('publicar-instagram').checked = atual.publicarInstagram !== false;
    if ($('publicar-facebook')) $('publicar-facebook').checked = atual.publicarFacebook === true;
    if ($('imagemUrl')) Publicacoes.sincronizarUrlPublicaNoCampo($('imagemUrl'), atual);
    $('campo-imagem-url').hidden = atual.tipoMidia === 'reel';
    $('campo-video-url').hidden = atual.tipoMidia !== 'reel';
    $('usar-visao').checked = atual.usarVisao !== false;
    if ($('estado')) $('estado').textContent = Publicacoes.estadoPublicacao(atual);
    atualizarCampoConteudo();
    atualizarControlesStory();
}

/**
 * Habilita Stories apenas para conta Business e mídia individual.
 * Usa optional chaining para que um elemento ausente nunca aborte a
 * renderização e deixe o botão de publicar preso no estado anterior.
 */
function atualizarControlesStory() {
    const business = String(perfilInstagram?.account_type || '').toUpperCase() === 'BUSINESS';
    const carrossel = atual.tipoMidia === 'carrossel';
    const habilitado = business && !carrossel;
    if ($('publicar-story')) $('publicar-story').disabled = !habilitado;
    if ($('periodo-story')) $('periodo-story').disabled = !business;
    // Story do Facebook é independente do Story do Instagram e do Feed.
    if ($('publicar-facebook-story')) $('publicar-facebook-story').disabled = !perfilFacebook || carrossel;
    if ($('facebook-story-explicacao')) $('facebook-story-explicacao').textContent = carrossel ? 'Story Facebook exige uma única imagem ou vídeo.' : perfilFacebook ? 'Destino independente do Feed Facebook e do Instagram.' : 'Conecte e verifique a Página Facebook para selecionar Stories.';
    if ($('story-explicacao')) $('story-explicacao').textContent = carrossel ? 'Carrossel não é convertido silenciosamente em Stories. Use outro fluxo para vários Stories.' : business ? 'O Story será publicado como destino separado, sem legenda.' : 'Stories exigem uma conta Instagram Business verificada.';
    if ($('periodo-story-explicacao')) $('periodo-story-explicacao').textContent = business ? 'Cada item terá resultados separados para Feed/Reel e Story.' : 'Stories exigem uma conta Instagram Business verificada.';
}

function atualizarCampoConteudo() { if ($('conteudo-atual')) $('conteudo-atual').value = atual.id; }

function carregarTemplateNoCampo() { if ($('template-texto')) $('template-texto').value = templatePadrao.texto || ''; if ($('template-status')) $('template-status').textContent = templatePadrao.texto ? 'Template salvo no backend.' : 'Nenhum template salvo.'; }

/** Atualiza o seletor da biblioteca sem aplicar conteúdo automaticamente. */
function renderizarTemplates() {
    const seletor = $('template-seletor');
    seletor.replaceChildren(new Option('Selecione…', ''));
    for (const template of templatesBiblioteca) seletor.append(new Option(template.nome, template.id));
    seletor.value = templatesBiblioteca.some(item => item.id === templateSelecionadoId) ? templateSelecionadoId : '';
    $('template-atualizar').disabled = !seletor.value;
}

function preencherFormularioTemplate(template) {
    if (!template) return;
    templateSelecionadoId = template.id;
    $('template-nome').value = template.nome || '';
    $('template-texto').value = template.texto || '';
    $('template-auto').checked = template.aplicarAutomatico === true;
    for (const campo of ['objetivo', 'tema', 'fatos', 'contexto', 'fatosIa', 'textoMidia', 'palavras', 'ideias']) $(campo).value = template[campo] || '';
    $('hashtags').value = template.hashtagsPublicacao || '';
    for (const [id, campo] of [['local', 'local'], ['site', 'site'], ['site1', 'site1'], ['site2', 'site2'], ['maps', 'maps'], ['links-adicionais', 'linksAdicionais'], ['hashtags-padrao', 'hashtags'], ['informacoes-fixas', 'informacoesAdicionais'], ['chamadas-fixas', 'chamadasFixas']]) $(id).value = template[campo] || '';
    renderizarTemplates();
}

function templateDoFormulario() {
    const ler = id => ($(id)?.value || '').trim();
    return {
        id: templateSelecionadoId || null, nome: ler('template-nome') || 'Template sem nome', texto: $('template-texto').value || '',
        ...Object.fromEntries(['objetivo', 'tema', 'fatos', 'contexto', 'fatosIa', 'textoMidia', 'palavras', 'ideias'].map(campo => [campo, $(campo).value || ''])),
        hashtagsPublicacao: $('hashtags').value || '',
        hashtags: ler('hashtags-padrao'), local: ler('local'), site: ler('site'), site1: ler('site1'), site2: ler('site2'), maps: ler('maps'), linksAdicionais: ler('links-adicionais'),
        informacoesAdicionais: ler('informacoes-fixas'), chamadasFixas: ler('chamadas-fixas'), aplicarAutomatico: $('template-auto').checked === true
    };
}

async function carregarBibliotecaTemplates() {
    try {
        const resposta = await cliente.solicitar('/empresa/templates', undefined, { prazo: 10000 });
        templatesBiblioteca = resposta.templates || [];
        const automatico = templatesBiblioteca.find(item => item.aplicarAutomatico);
        if (automatico) templatePadrao = { texto: automatico.texto || '', aplicarAutomatico: true };
        renderizarTemplates();
    } catch { $('template-status').textContent = 'Biblioteca de templates indisponível; campos atuais preservados.'; }
}

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
        el.value = recorrentes[chave] || '';
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
    const template = templateDoFormulario();
    try {
        const resposta = await cliente.solicitar('/empresa/templates', { novo: true, template: { ...template, id: null } }, { prazo: 15000 });
        templatesBiblioteca = resposta.templates || [];
        preencherFormularioTemplate(resposta.template);
        avisar('Template salvo como novo no backend.');
    } catch (erro) { avisar(`O servidor não confirmou o template: ${erro.message}`); }
}

async function atualizarTemplateSelecionado() {
    if (!templateSelecionadoId) { avisar('Selecione um template para atualizar.'); return; }
    try {
        const resposta = await cliente.solicitar('/empresa/templates', { novo: false, template: templateDoFormulario() }, { prazo: 15000 });
        templatesBiblioteca = resposta.templates || [];
        preencherFormularioTemplate(resposta.template);
        avisar('Template selecionado atualizado no backend.');
    } catch (erro) { avisar(`Não foi possível atualizar: ${erro.message}`); }
}

function aplicarTemplateAtual() {
    const template = templateDoFormulario();
    preencherFormularioTemplate(template);
    sincronizarFormularioNoEstado();
    atual.templateTexto = template.texto && !atual.legenda.includes(template.texto.trim()) ? template.texto : '';
    const hashtagsPresentes = new Set(R.hashtags(atual.legenda).map(tag => tag.toLowerCase()));
    atual.hashtags = [...new Set(`${template.hashtagsPublicacao || ''} ${template.hashtags || ''}`.split(/\s+/).filter(tag => tag && !hashtagsPresentes.has(tag.toLowerCase())))].join(' ');
    atual.local = template.local; atual.site = template.site; atual.site1 = template.site1; atual.site2 = template.site2;
    atual.maps = template.maps; atual.linksAdicionais = template.linksAdicionais;
    atual.informacoesAdicionais = template.informacoesAdicionais; atual.chamadasFixas = template.chamadasFixas;
    marcarAlterado(); renderizarRevisao(); avisar('Template aplicado à publicação atual.');
}

// ============================================================
// REVISÃO
// ============================================================

function renderizarRevisao() {
    atualizarControlesStory();
    $('conexoes-rodape').textContent = `Servidor: ${servidorOnline ? 'online' : 'indisponível'} · Instagram: ${perfilInstagram ? 'verificado' : 'não verificado'} · Facebook: ${perfilFacebook ? 'Página verificada' : 'não conectado'}`;
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

    atualizarChecklist();
}

/** Atualiza checklist e ações juntos, inclusive após marcar uma revisão individual. */
function atualizarChecklist() {
    const validacoes = validacoesDaRevisao();
    $('validacoes').replaceChildren(...validacoes.map(item => elemento('li', `${item.ok ? '✓' : '○'} ${item.texto}`, item.ok ? 'ok' : 'pendente')));
    $('aprovar').disabled = !validacoes.every(item => item.ok) || atual.estado === 'confirmado';
    $('aprovar').textContent = atual.estado === 'confirmado' ? 'Conteúdo já confirmado' : 'Confirmar conteúdo';
    $('decisao-publicacao').hidden = atual.estado !== 'confirmado';
    renderizarValidacoesPublicacao();
}

/** Reúne as validações visíveis que bloqueiam a aprovação editorial. */
function validacoesDaRevisao() {
    return IR.validarInstagram(atual, R);
}

/** Marca a revisão humana de todas as ideias sem exigir o restante do checklist. */
function marcarRevisaoHumana() {
    const ideias = R.linhas(atual.ideias);
    atual.revisoes = [...new Set([...(atual.revisoes || []), ...ideias])];
    marcarAlterado(); renderizarRevisao(); salvar(true);
    registrar('revisao_humana_marcada', { ideias: ideias.length, operationId: atual.id });
    avisar(ideias.length ? 'Revisão humana marcada.' : 'Nenhuma ideia obrigatória para revisar.');
}

/** Usa a mesma decisão no checklist, nos botões e na abertura da confirmação. */
function elegibilidadePublicacaoAtual() {
    return IR.avaliarPublicacaoImediata(atual, R, { servidorOnline, instagramVerificado: Boolean(perfilInstagram), facebookVerificado: Boolean(perfilFacebook), contaInstagram: perfilInstagram?.account_type, enviando: enviandoPublicacao });
}

function renderizarValidacoesPublicacao() {
    const avaliacao = elegibilidadePublicacaoAtual();
    const itens = avaliacao.itens;
    $('validacoes-publicacao').replaceChildren(...itens.map(item => elemento('li', `${item.ok ? '✓' : '○'} ${item.texto}`, item.ok ? 'ok' : 'pendente')));
    $('preparar-publicacao').disabled = !avaliacao.podePublicar;
    $('publicar-agora-revisao').disabled = !avaliacao.podePublicar;
    $('titulo-decisao-publicacao').textContent = atual.statusPublicacao === 'publicado' ? 'Este registro já foi marcado como publicado. Novo envio está bloqueado para evitar duplicação.' : atual.statusPublicacao === 'publicando' ? 'Existe uma tentativa de publicação em andamento.' : 'Conteúdo confirmado. Escolha o próximo passo:';
    $('motivo-publicacao-revisao').textContent = avaliacao.podePublicar ? 'Pronto para abrir a confirmação dos destinos. Nenhuma publicação foi iniciada.' : avaliacao.motivos.join(' · ');
    if (!avaliacao.podePublicar) { $('resultado-publicacao').textContent = avaliacao.motivos.join(' · '); return; }
    $('resultado-publicacao').textContent = atual.statusPublicacao === 'falhou'
        ? `${atual.erroPublicacao || 'A tentativa falhou.'} Você pode corrigir o conteúdo e tentar novamente.`
        : atual.publicacaoReal?.estado === 'publicado'
            ? `Publicada · ID ${atual.publicacaoReal.idPublicado}`
            : destinosVerificados() ? 'Destinos verificados. A publicação só começa após sua confirmação.' : 'Teste a conexão dos destinos selecionados: Instagram e/ou Página do Facebook.';
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

/** Prepara uma imagem ou seis quadros do MP4 para o modelo de visão. */
async function prepararMidiaParaVisao(conteudo) {
    const midia = conteudo.imagens[0];
    const video = midia?.tipo === 'video' || conteudo.tipoMidia === 'reel';
    const origem = midia?.dados || (video ? conteudo.videoUrl : conteudo.imagemUrl);
    if (!video || !origem) return { imagem: origem || undefined, contexto: '' };
    const visual = document.createElement('video');
    visual.muted = true; visual.preload = 'auto'; visual.crossOrigin = 'anonymous';
    /** Aguarda a decodificação com prazo e remove os eventos ao terminar. */
    function aguardar(evento, iniciar) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => terminar(new Error('O vídeo demorou demais para decodificar. Tente um MP4 compatível com o navegador.')), 20000);
            const sucesso = () => terminar();
            const falha = () => terminar(new Error('Não foi possível ler os quadros do MP4. Selecione o arquivo local; URLs externas precisam permitir acesso pelo navegador.'));
            function terminar(erro) {
                clearTimeout(timer); visual.removeEventListener(evento, sucesso); visual.removeEventListener('error', falha);
                if (erro) reject(erro); else resolve();
            }
            visual.addEventListener(evento, sucesso); visual.addEventListener('error', falha);
            try { iniciar(); } catch (erro) { terminar(erro); }
        });
    }
    try {
        await aguardar('loadeddata', () => { visual.src = origem; });
        if (!Number.isFinite(visual.duration) || visual.duration <= 0 || !visual.videoWidth || !visual.videoHeight) throw new Error('O MP4 não possui duração ou quadros válidos.');
        const tela = document.createElement('canvas'); tela.width = 1440; tela.height = 600;
        const desenho = tela.getContext('2d');
        if (!desenho) throw new Error('O navegador não conseguiu preparar os quadros do vídeo.');
        desenho.fillStyle = '#000'; desenho.fillRect(0, 0, tela.width, tela.height);
        const tempos = [];
        for (let i = 0; i < 6; i++) {
            const tempo = visual.duration * (i + 0.5) / 6;
            await aguardar('seeked', () => { visual.currentTime = tempo; });
            const escala = Math.min(480 / visual.videoWidth, 270 / visual.videoHeight);
            const largura = visual.videoWidth * escala, altura = visual.videoHeight * escala;
            const x = (i % 3) * 480, y = Math.floor(i / 3) * 300;
            desenho.drawImage(visual, x + (480 - largura) / 2, y + (270 - altura) / 2, largura, altura);
            desenho.fillStyle = '#fff'; desenho.font = '18px sans-serif'; desenho.fillText(`${tempo.toFixed(1)} s`, x + 10, y + 290);
            tempos.push(tempo.toFixed(1));
        }
        return { imagem: tela.toDataURL('image/jpeg', 0.8), contexto: `A imagem contém seis quadros amostrados de um vídeo de ${visual.duration.toFixed(1)} segundos, em ordem da esquerda para a direita, de cima para baixo (${tempos.join(', ')} s). Analise somente o que está visível nesses quadros. O áudio não foi fornecido. Não infira falas, sons ou ações entre os quadros.` };
    } finally { visual.pause(); visual.removeAttribute('src'); visual.load(); }
}

async function gerarLegenda(reescrever) {
    const modelo = modelosDisponiveis.find(m => m.id === $('modelo-astra').value);
    if (!modelo) { avisar('Selecione um modelo válido.'); return; }
    let prompt;
    try { prompt = IR.montarPrompt(atual, reescrever, Boolean(modelo.vision)); } catch (erro) { avisar(erro.message); return; }
    atual.modeloAstra = modelo.id;
    const botao = reescrever ? $('reescrever-legenda') : $('gerar-legenda');
    const original = botao.textContent; botao.disabled = true; botao.textContent = 'Astra escrevendo…';
    try {
        const visual = atual.usarVisao !== false && modelo.vision ? await prepararMidiaParaVisao(atual) : {};
        const resposta = await cliente.solicitar('/astra/generate', { prompt: [prompt, visual.contexto].filter(Boolean).join('\n\n'), model: modelo.id, ...(visual.imagem ? { imagem: visual.imagem } : {}) }, { prazo: 120000 });
        const texto = resposta.astra?.text;
        if (typeof texto !== 'string' || !texto.trim()) throw new Error('Astra não retornou texto.');
        atual.legenda = texto; atual.estado = 'rascunho'; $('legenda').value = texto;
        marcarAlterado(); renderizarRevisao(); avisar('Legenda recebida. O template não foi alterado.');
    } catch (erro) { avisar(`IA: ${erro.message} Você pode escrever manualmente.`); }
    finally { botao.disabled = false; botao.textContent = original; }
}

async function analisarMidia() {
    const modelo = modelosDisponiveis.find(m => m.id === $('modelo-astra').value);
    if (!(atual.imagens[0]?.dados || atual.videoUrl || atual.imagemUrl) || !modelo?.vision) { avisar('Selecione uma imagem ou MP4 e um modelo com visão.'); return; }
    const botao = $('analisar-midia'); botao.disabled = true; botao.textContent = 'Analisando…';
    try {
        const visual = await prepararMidiaParaVisao(atual);
        const resposta = await cliente.solicitar('/astra/generate', { model: modelo.id, imagem: visual.imagem, prompt: 'Analise a mídia e retorne SOMENTE JSON {"fatos":["..."],"texto":["..."]}. Separe fatos de OCR. Não invente dados.\n' + visual.contexto }, { prazo: 120000 });
        const bruto = resposta.astra?.text?.match(/\{[\s\S]*\}/)?.[0];
        const dados = bruto ? JSON.parse(bruto) : null;
        if (!dados || !Array.isArray(dados.fatos) || !Array.isArray(dados.texto)) throw new Error('Formato inesperado.');
        atual.fatosIa = dados.fatos.filter(i => typeof i === 'string').join('\n');
        atual.textoMidia = dados.texto.filter(i => typeof i === 'string').join('\n');
        $('fatosIa').value = atual.fatosIa; $('textoMidia').value = atual.textoMidia;
        marcarAlterado(); renderizarRevisao(); avisar(visual.contexto ? 'Análise de 6 quadros do MP4 concluída, sem áudio. Revise os fatos extraídos.' : 'Análise concluída.');
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
        if (dados.instagramConfigured && !perfilInstagram) await verificarInstagram();
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
    finally { $('testar-instagram').disabled = false; atualizarControlesStory(); renderizarRevisao(); }
}

function montarEntradaPublicacao() {
    if (atual.tipoMidia === 'carrossel') return { formato: 'carrossel', itens: atual.imagens.map(item => ({ tipo: item.tipo, url: urlPublicaDaMidia(item) })), caption: R.compor(atual), publicarStory: false };
    if (atual.tipoMidia === 'reel') return { formato: 'reel', videoUrl: atual.videoUrl.trim(), mediaMime: 'video/mp4', caption: R.compor(atual), publicarStory: atual.publicarStory === true };
    return { formato: 'imagem', imageUrl: atual.imagemUrl.trim(), caption: R.compor(atual), publicarStory: atual.publicarStory === true };
}

function renderizarStatusPublicacao() {
    const alvo = $('status-publicacao');
    if (!alvo) return;
    const estado = Publicacoes.statusPublicacaoVisual(atual);
    alvo.className = estado.classe;
    alvo.textContent = `STATUS DA PUBLICAÇÃO: ${estado.texto}`;
    const resultados = atual.resultadosPublicacao || {};
    for (const [destino, resultado] of Object.entries(resultados)) {
        alvo.append(document.createElement('br'), document.createTextNode(`${({ facebook: 'Feed Facebook', facebookStory: 'Story Facebook', story: 'Story Instagram', feed: 'Feed Instagram' })[destino] || destino}: ${resultado.estado}${resultado.idPublicado ? ` · ID ${resultado.idPublicado}` : ''}`));
    }
    if (atual.permalink) {
        const link = elemento('a', 'Abrir no Instagram', 'nota');
        link.href = atual.permalink; link.target = '_blank'; link.rel = 'noopener';
        alvo.append(document.createElement('br'), link);
    }
}

function prepararPublicacao() {
    if (atual.statusPublicacao === 'publicado') { avisar('Esta publicação já foi enviada ao Instagram.'); return; }
    if (atual.statusPublicacao === 'publicando' || enviandoPublicacao) { avisar('Já existe uma tentativa em andamento.'); return; }
    const avaliacao = elegibilidadePublicacaoAtual();
    if (!avaliacao.podePublicar) { avisar(avaliacao.motivos.join(' · ')); renderizarRevisao(); return; }
    const entrada = montarEntradaPublicacao();
    entrada.publicarInstagram = atual.publicarInstagram !== false;
    entrada.publicarFacebook = atual.publicarFacebook === true;
    entrada.publicarFacebookStory = atual.publicarFacebookStory === true;
    if (entrada.publicarFacebook || entrada.publicarFacebookStory) entrada.facebookPageId = perfilFacebook.id;
    confirmacaoAtual = { id: atual.id, assinatura: IR.assinaturaConteudo(atual), entrada, conta: perfilInstagram?.destinoId || null };
    $('conta-confirmacao').textContent = [entrada.publicarInstagram ? `Feed Instagram: ${perfilInstagram.username || perfilInstagram.id}` : '', entrada.publicarStory ? `Story Instagram: ${perfilInstagram.username || perfilInstagram.id}` : '', entrada.publicarFacebook ? `Feed Facebook: ${perfilFacebook.name || perfilFacebook.id}` : '', entrada.publicarFacebookStory ? `Story Facebook: ${perfilFacebook.name || perfilFacebook.id}` : ''].filter(Boolean).join(' · ');
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
    registrar('publicar_agora_confirmado', { operationId: atual.id, destinos: [atual.publicarInstagram !== false && 'instagram:feed', atual.publicarStory && 'instagram:story', atual.publicarFacebook && 'facebook:feed', atual.publicarFacebookStory && 'facebook:story'].filter(Boolean) });
    $('confirmar-publicacao').disabled = true; $('confirmar-publicacao').textContent = 'Publicando…'; $('cancelar-publicacao').disabled = true;
    const tentativa = Publicacoes.iniciarTentativa(atual, crypto.randomUUID());
    if (!tentativa) { enviandoPublicacao = false; return; }
    marcarAlterado(); renderizarStatusPublicacao();
    if (!await salvar(true)) {
        delete atual.publicacaoReal; atual.statusPublicacao = 'nao_publicada';
        enviandoPublicacao = false; $('cancelar-publicacao').disabled = false; $('confirmar-publicacao').disabled = false; $('confirmar-publicacao').textContent = 'Publicar agora';
        $('confirmacao-publicacao').close(); confirmacaoAtual = undefined; renderizarStatusPublicacao(); avisar('Envio cancelado.');
        return;
    }
    $('confirmacao-publicacao').close(); confirmacaoAtual = undefined;
    try {
        const resposta = await cliente.solicitar('/instagram/publish', { ...confirmacao.entrada, publicationId: atual.id, containerId: atual.containerPublicacaoId || undefined, storyContainerId: atual.containerStoryId || undefined }, { prazo: 270000, id: tentativa.tentativaId });
        if (resposta.success !== true || !resposta.published?.id) throw new Error(resposta.error || 'O servidor não confirmou a publicação.');
        atual.resultadosPublicacao = resposta.resultadosPublicacao || { feed: { estado: 'confirmada', idPublicado: resposta.published.id } };
        tentativa.estado = 'publicado'; tentativa.idPublicado = resposta.published.id; tentativa.finalizadoEm = new Date().toISOString();
        Publicacoes.registrarPublicacao(atual, { mediaId: resposta.media_id || resposta.published.id, containerId: resposta.containerId, permalink: resposta.permalink, publicadoEm: resposta.published_at });
        registrar('publicacao_concluida', { status: Object.keys(atual.resultadosPublicacao || {}).length > 1 ? 'sucesso_parcial' : 'sucesso', operationId: atual.id, contexto: { resultados: atual.resultadosPublicacao || null } });
        avisar('✓ Publicação confirmada nos destinos selecionados.');
        renderizarMetricasResumo();
    } catch (erro) {
        if (erro.resultadosPublicacao) atual.resultadosPublicacao = erro.resultadosPublicacao;
        if (erro.destinoPublicacao === 'story' && erro.containerId) atual.containerStoryId = erro.containerId;
        tentativa.estado = 'incerto'; tentativa.mensagem = erro.message;
        Publicacoes.registrarPublicacao(atual, { erro: erro.message, containerId: erro.destinoPublicacao === 'story' ? null : erro.containerId, estadoContainer: erro.containerStatus });
        registrar('publicacao_falhou', { nivel: 'ERROR', status: 'falhou', operationId: atual.id, codigo: erro.codigo, destino: erro.destinoPublicacao || null, mensagem: erro.message, contexto: { resultados: erro.resultadosPublicacao || null } });
        avisar(`✗ A publicação não foi concluída em todos os destinos: ${erro.message}`);
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
    anteriores.forEach((item, indice) => {
        const cartao = elemento('article', undefined, 'cartao-anterior');
        const moldura = elemento('span', 'Carregando…', 'miniatura-anterior');
        const fontes = Array.isArray(item.miniaturas) && item.miniaturas.length ? item.miniaturas : (item.miniatura ? [item.miniatura] : []);
        if (fontes.length) {
            const img = elemento('img'); img.alt = `Miniatura de ${item.formato || 'publicação'}`; img.loading = indice < 6 ? 'eager' : 'lazy';
            let indiceFonte = 0;
            img.onload = () => { img.hidden = false; moldura.textContent = ''; moldura.append(img); };
            img.onerror = () => { indiceFonte += 1; if (indiceFonte < fontes.length) img.src = fontes[indiceFonte]; else { img.remove(); moldura.textContent = 'Sem miniatura'; } };
            img.src = fontes[0]; moldura.replaceChildren(img);
        } else moldura.textContent = 'Sem miniatura';
        cartao.append(moldura);
        const info = elemento('div');
        info.append(elemento('strong', `${item.formato || 'publicação'}`), elemento('small', item.publicadoEm ? new Date(item.publicadoEm).toLocaleString('pt-BR') : 'data n/i'));
        info.append(elemento('p', trecho(item.legenda) || '(sem legenda)', 'nota'));
        cartao.append(info);
        const acoes = elemento('div', undefined, 'acoes');
        const detalhes = elemento('button', 'Ver detalhes'); detalhes.type = 'button'; detalhes.onclick = () => selecionarAnterior(item);
        const rascunho = elemento('button', 'Usar como exemplo e criar rascunho'); rascunho.type = 'button'; rascunho.onclick = () => usarComoBase(item);
        acoes.append(detalhes, rascunho); cartao.append(acoes);
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
    const base = elemento('button', 'Usar como exemplo e criar rascunho'); base.type = 'button'; base.onclick = () => usarComoBase(item);
    const copiar = elemento('button', 'Copiar legenda'); copiar.type = 'button'; copiar.onclick = () => { atual.legenda = item.legenda || ''; if ($('legenda')) $('legenda').value = atual.legenda; marcarAlterado(); renderizarRevisao(); avisar('Legenda copiada para a publicação atual.'); };
    const metricas = elemento('button', 'Atualizar métricas'); metricas.type = 'button'; metricas.onclick = () => atualizarMetricas([item]);
    acoes.append(base, copiar, metricas);
    bloco.append(acoes);
    detalhe.replaceChildren(bloco);
}

/** Cria uma nova publicação local a partir de uma anterior; nunca altera o original. */
async function usarComoBase(origem = anteriorSelecionada) {
    if (!origem) return;
    const nova = aplicarRecorrentesEm(R.criarConteudo());
    nova.titulo = `Exemplo: ${trecho(origem.legenda, 40) || origem.id}`;
    nova.legenda = origem.legenda || '';
    nova.contexto = `Rascunho criado a partir da publicação histórica ${origem.id}.`;
    nova.tipoMidia = origem.formato === 'reel' ? 'reel' : origem.formato === 'carrossel' ? 'carrossel' : 'imagem';
    if (templatePadrao.aplicarAutomatico && !nova.templateTexto) nova.templateTexto = templatePadrao.texto;
    nova.referenciaImportada = origem.id;
    nova.referenciaVisual = origem.miniatura || null;
    nova.imagens = []; nova.imagemUrl = ''; nova.videoUrl = '';
    nova.statusPublicacao = 'nao_publicada'; nova.instagramMediaId = null; nova.publicacaoReal = null; nova.resultadosPublicacao = {};
    conteudos.push(nova); atual = nova;
    marcarAlterado(); sincronizarCampos(); renderizarMidias(); renderizarRevisao(); atualizarSeletorConteudos(); abrirAba('midia');
    const salvo = await salvar(true);
    avisar(salvo && ultimoSalvamentoServidor ? 'Rascunho criado e salvo no backend. A miniatura histórica é apenas referência; selecione a mídia original.' : 'Rascunho criado somente neste navegador. O post original não foi alterado.');
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
        destinos: [...($('periodo-instagram').checked ? ['Instagram Feed', ...($('periodo-story').checked ? ['Instagram Story'] : [])] : []), ...($('periodo-facebook').checked ? ['Facebook Page'] : [])],
        facebookPageId: $('periodo-facebook').checked ? perfilFacebook?.id || null : null,
        atraso: 'reagendar', toleranciaMinutos: 30
    };
}

async function gerarPeriodo() {
    const config = lerConfigPeriodo();
    if (!config.destinos.length) { avisar('Escolha ao menos um destino para a agenda.'); return; }
    if (config.destinos.includes('Facebook Page') && !config.facebookPageId) { avisar('Conecte e selecione a Página do Facebook antes de gerar o plano.'); return; }
    const melhoresHorarios = (analiseAtual?.melhoresHorarios || []).length ? analiseAtual.melhoresHorarios : (await analisarHorarios())?.melhoresHorarios || [];
    const plano = PS.planejarPeriodo(config, ctxMidias(), { melhoresHorarios });
    plano.sincronizacao = { estado: 'rascunho_local', confirmadoEm: null, erro: null };
    planoPeriodo = plano;
    selecionadosPeriodo = new Set(plano.itens.map(i => i.id));
    await persistirPlanoPeriodo();
    renderizarPeriodoPrevia();
    const exigeIa = plano.itens.some(item => item.variarTexto);
    const iaDisponivel = servidorOnline && modelosDisponiveis.some(modelo => modelo.id === $('modelo-astra').value);
    $('periodo-confirmar').disabled = !plano.itens.length || (exigeIa && !iaDisponivel);
    $('periodo-confirmar').textContent = exigeIa && !iaDisponivel ? 'IA indisponível' : 'Confirmar plano';
    $('periodo-status').textContent = plano.erros.length ? plano.erros.join(' ') : exigeIa && !iaDisponivel ? 'A variação por IA está selecionada, mas a IA não está disponível. Escolha um modelo válido ou desative a variação.' : `Rascunho local com ${plano.itens.length} publicação(ões). Confirme para sincronizar com o servidor.`;
    $('periodo-status').className = plano.erros.length ? 'pendente' : 'ok';
}

function ctxMidias() { return Fluxo.prepararMidiasParaAgenda(globalThis.AstraContexto?.obterMidias?.() || bibliotecaMidias, conteudos); }

function renderizarPeriodoPrevia() {
    const container = $('periodo-previa'); container.replaceChildren();
    if (!planoPeriodo) return;
    for (const bloqueio of planoPeriodo.inelegiveis || []) {
        const regraImagem = bloqueio.tipo !== 'video' && bloqueio.tipo !== 'reel';
        const aviso = regraImagem
            ? `Imagem ignorada na agenda orgânica: ${bloqueio.motivo} Vídeos e Reels continuam elegíveis.`
            : `Mídia ignorada na agenda orgânica: ${bloqueio.motivo}`;
        container.append(elemento('p', aviso, 'nota'));
    }
    for (const item of planoPeriodo.itens) {
        const linha = elemento('div', undefined, 'agenda-item');
        const sincronizacao = planoPeriodo.sincronizacao?.estado ? ` · ${planoPeriodo.sincronizacao.estado.replaceAll('_', ' ')}` : '';
        linha.append(elemento('div', `${item.data} ${item.hora} · ${item.tipo} · ${item.status} · v${item.versao}${item.variarTexto ? ' · variação ' + item.nivelVariacao : ''}${sincronizacao}`));
        linha.append(elemento('p', trecho(item.legenda) || '(legenda vazia)', 'nota'));
        linha.append(elemento('p', `Destinos: ${(item.destinos || []).join(', ')}`, 'nota'));
        const story = document.createElement('input'); story.type = 'checkbox'; story.checked = item.destinos?.includes('Instagram Story');
        story.disabled = !item.destinos?.includes('Instagram Feed') || item.tipo === 'carrossel' || String(perfilInstagram?.account_type || '').toUpperCase() !== 'BUSINESS' || planoPeriodo.sincronizacao?.estado === 'confirmado_servidor';
        story.onchange = async () => {
            item.destinos = story.checked ? [...new Set([...(item.destinos || []), 'Instagram Story'])] : (item.destinos || []).filter(destino => destino !== 'Instagram Story');
            item.approvalSignature = null; item.status = 'rascunho'; planoPeriodo.status = 'rascunho'; planoPeriodo.sincronizacao = { estado: 'rascunho_local', erro: null };
            await persistirPlanoPeriodo(); renderizarPeriodoPrevia();
        };
        const rotuloStory = elemento('label', undefined, 'check'); rotuloStory.append(story, document.createTextNode(item.tipo === 'carrossel' ? ' Story indisponível para carrossel' : ' Publicar também no Story'));
        linha.append(rotuloStory);
        for (const [destino, resultado] of Object.entries(item.resultados || {})) linha.append(elemento('p', `${destino}: ${resultado.estado}${resultado.idPublicado ? ` · ID ${resultado.idPublicado}` : ''}`, 'nota'));
        container.append(linha);
    }
}

/** Opcionalmente varia apenas a parte principal, preservando template/links/hashtags. */
async function aplicarVariacoes(plano) {
    if (!plano?.itens?.some(i => i.variarTexto)) return structuredClone(plano);
    const modelo = modelosDisponiveis.find(m => m.id === $('modelo-astra').value);
    if (!servidorOnline || !modelo) throw Object.assign(new Error('A IA precisa estar online e com um modelo válido antes de confirmar variações.'), { codigo: 'VARIACAO_IA_INDISPONIVEL' });
    return Fluxo.aplicarVariacoes(plano, {
        localizarConteudo: (publicacaoId, mediaId) => conteudos.find(item => item.id === publicacaoId) || conteudos.find(item => (item.imagens || []).some(midia => midia.id === mediaId)),
        gerarTexto: async ({ texto, nivel }) => {
            const prompt = `Reescreva somente a parte editorial abaixo com variação ${nivel}. Não acrescente hashtags, links, telefones, endereços ou texto fixo. Retorne somente o novo texto editorial.\n\nTexto editorial:\n${texto}`;
            const resposta = await cliente.solicitar('/astra/generate', { prompt, model: modelo.id }, { prazo: 120000 });
            return resposta.astra?.text;
        }
    });
}

async function confirmarPeriodo() {
    if (!planoPeriodo || !planoPeriodo.itens.length) { avisar('Gere o agendamento antes de confirmar.'); return; }
    if (planoPeriodo.sincronizacao?.estado === 'sincronizando' || planoPeriodo.sincronizacao?.estado === 'confirmado_servidor') return;
    const botao = $('periodo-confirmar'); botao.disabled = true; botao.textContent = planoPeriodo.itens.some(item => item.variarTexto && !item.variacaoConcluida) ? 'Gerando variações…' : 'Sincronizando…';
    $('periodo-status').textContent = botao.textContent; $('periodo-status').className = 'nota';
    try {
        planoPeriodo = await Fluxo.sincronizarPlano(planoPeriodo, {
            prepararVariacoes: aplicarVariacoes,
            aprovar: PS.aprovar,
            enviar: plano => cliente.solicitar('/agenda/planos', { planos: [plano] }, { prazo: 20000 })
        });
        await persistirPlanoPeriodo();
        $('periodo-status').textContent = `Plano confirmado pelo servidor: ${planoPeriodo.itens.length} publicação(ões) agendada(s).`;
        $('periodo-status').className = 'ok'; botao.textContent = 'Confirmado pelo servidor';
        registrar('periodo_confirmado', { itens: planoPeriodo.itens.length });
    } catch (erro) {
        planoPeriodo = erro.planoRecuperavel || { ...planoPeriodo, status: 'rascunho', sincronizacao: { estado: 'falhou', erro: erro.message } };
        await persistirPlanoPeriodo();
        $('periodo-status').textContent = `Falha ao confirmar no servidor: ${erro.message} O rascunho foi preservado.`;
        $('periodo-status').className = 'pendente'; botao.disabled = false; botao.textContent = 'Tentar novamente';
        registrar('periodo_falhou', { nivel: 'ERROR', code: erro.codigo, message: erro.message });
    }
    renderizarPeriodoPrevia();
}

/** Persiste a prévia local para permitir retry sem perder os campos. */
async function persistirPlanoPeriodo() {
    if (!banco || !planoPeriodo) return false;
    try { await salvarArmazenamento('plano-periodo-rascunho', planoPeriodo); return true; } catch { return false; }
}

// ============================================================
// INICIALIZAÇÃO
// ============================================================

function conectarCampos() {
    for (const campo of ['objetivo', 'tema', 'fatos', 'contexto', 'fatosIa', 'textoMidia', 'hashtags', 'palavras', 'ideias', 'imagemUrl', 'videoUrl', 'legenda', 'titulo']) {
        if (!$(campo)) continue;
        $(campo).oninput = () => { prepararReutilizacao(); atual[campo] = $(campo).value; if (campo !== 'titulo') atual.estado = 'rascunho'; marcarAlterado(); renderizarRevisao(); atualizarSeletorConteudos(); };
    }
    for (const [id, campo] of [['local', 'local'], ['site', 'site'], ['site1', 'site1'], ['site2', 'site2'], ['maps', 'maps'], ['links-adicionais', 'linksAdicionais'], ['informacoes-fixas', 'informacoesAdicionais'], ['chamadas-fixas', 'chamadasFixas'], ['hashtags-padrao', 'hashtags']]) {
        $(id).oninput = () => { prepararReutilizacao(); atual[campo] = $(id).value; atual.estado = 'rascunho'; marcarAlterado(); renderizarRevisao(); };
    }
    $('tipoMidia').onchange = async () => {
        prepararReutilizacao();
        if (!Publicacoes.definirTipoMidia(atual, $('tipoMidia').value)) return;
        IR.sincronizarUrlsPublicas(atual);
        atual.estado = 'rascunho';
        marcarAlterado(); sincronizarCampos(); renderizarRevisao();
        await salvar(true);
    };
    $('publicar-story').onchange = () => { prepararReutilizacao(); atual.publicarStory = $('publicar-story').checked === true; atual.estado = 'rascunho'; marcarAlterado(); renderizarRevisao(); salvar(true); registrar('destinos_alterados', { instagramStory: atual.publicarStory === true, operationId: atual.id }); };
    $('publicar-facebook-story').onchange = () => { prepararReutilizacao(); atual.publicarFacebookStory = $('publicar-facebook-story').checked === true; atual.estado = 'rascunho'; marcarAlterado(); renderizarRevisao(); salvar(true); registrar('destinos_alterados', { facebookStory: atual.publicarFacebookStory === true, operationId: atual.id }); };
    for (const destino of ['instagram', 'facebook']) $('publicar-' + destino).onchange = () => {
        prepararReutilizacao();
        atual.publicarInstagram = $('publicar-instagram').checked;
        atual.publicarFacebook = $('publicar-facebook').checked;
        atual.estado = 'rascunho';
        marcarAlterado(); atualizarControlesStory(); renderizarRevisao(); salvar(true);
        registrar('destinos_alterados', { instagram: atual.publicarInstagram === true, facebook: atual.publicarFacebook === true, operationId: atual.id });
    };
    $('form-integracoes').onsubmit = salvarIntegracoes;
    $('testar-facebook').onclick = testarFacebook;
    $('usar-visao').onchange = () => { atual.usarVisao = $('usar-visao').checked; marcarAlterado(); };
    $('arquivos').onchange = async event => { const arquivos = [...event.target.files]; event.target.value = ''; event.target.disabled = true; try { await processarArquivos(arquivos); } finally { event.target.disabled = false; } };
    $('gerar-legenda').onclick = () => gerarLegenda(false);
    $('reescrever-legenda').onclick = () => gerarLegenda(true);
    $('analisar-midia').onclick = analisarMidia;
    $('atualizar-modelos').onclick = () => carregarModelos(true);
    $('modelo-astra').onchange = () => { atual.modeloAstra = $('modelo-astra').value; marcarAlterado(); mostrarModeloSelecionado(); };
    $('revisar').onclick = marcarRevisaoHumana;
    $('aprovar').onclick = async () => {
        if (validacoesDaRevisao().some(i => !i.ok)) { renderizarRevisao(); avisar('Ainda há pendências.'); return; }
        atual.estado = 'confirmado'; marcarAlterado(); renderizarRevisao();
        const salvo = await salvar(true);
        registrar('conteudo_confirmado', { status: salvo ? 'persistido' : 'local', operationId: atual.id, destinos: [atual.publicarInstagram !== false && 'instagram:feed', atual.publicarStory && 'instagram:story', atual.publicarFacebook && 'facebook:feed', atual.publicarFacebookStory && 'facebook:story'].filter(Boolean) });
        avisar(salvo ? 'Conteúdo confirmado. Escolha publicar agora ou ir para o agendamento.' : 'Conteúdo confirmado nesta aba, mas ainda não foi persistido.');
    };
    $('salvar').onclick = () => salvarEAvancar();
    $('publicar-agora-revisao').onclick = prepararPublicacao;
    $('ir-agendamento').onclick = async () => { sincronizarFormularioNoEstado(); if (await salvar(true)) abrirAba('agendamento'); else avisar('Não foi possível salvar; o agendamento não foi aberto.'); };
    $('salvar-recorrentes').onclick = salvarRecorrentesEmpresa;
    $('preparar-publicacao').onclick = prepararPublicacao;
    $('cancelar-publicacao').onclick = () => { confirmacaoAtual = undefined; $('confirmacao-publicacao').close(); };
    $('autorizo-publicacao').onchange = () => { $('confirmar-publicacao').disabled = !$('autorizo-publicacao').checked || enviandoPublicacao; };
    $('confirmar-publicacao').onclick = confirmarPublicacao;
    $('confirmacao-publicacao').oncancel = event => { if (enviandoPublicacao) event.preventDefault(); else confirmacaoAtual = undefined; };
    $('atualizar-conexao').onclick = verificarServidor;
    $('testar-instagram').onclick = verificarInstagram;
    $('nova').onclick = novaPublicacao;
    $('conteudo-atual').onchange = () => trocarConteudo($('conteudo-atual').value);
    $('template-salvar').onclick = salvarTemplatePadrao;
    $('template-atualizar').onclick = atualizarTemplateSelecionado;
    $('template-seletor').onchange = () => { const template = templatesBiblioteca.find(item => item.id === $('template-seletor').value); if (template) preencherFormularioTemplate(template); else { templateSelecionadoId = ''; renderizarTemplates(); } };
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
    carregarIntegracoes();
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
        const planoSalvo = await lerArmazenamento('plano-periodo-rascunho');
        if (planoSalvo?.id && Array.isArray(planoSalvo.itens)) planoPeriodo = planoSalvo;
    } catch { avisar('Armazenamento local indisponível.'); }
    try { const config = await cliente.solicitar('/empresa/template-padrao', undefined, { prazo: 10000 }); if (config?.templatePadrao) templatePadrao = config.templatePadrao; } catch { /* offline */ }
    await carregarRecorrentes();
    if (!atual.templateTexto && templatePadrao.texto) atual.templateTexto = templatePadrao.texto;
    IR.sincronizarUrlsPublicas(atual);
    sincronizarCampos(); carregarTemplateNoCampo(); atualizarSeletorConteudos(); preencherCamposRecorrentes();
    atualizarRodapeEtapa();
    renderizarMidias(); renderizarRevisao(); renderizarPeriodoPrevia(); renderizarAnalise(); renderizarDesempenho(); renderizarBaseAnalise(); renderizarStatusPublicacao();
    if (planoPeriodo) {
        const confirmado = planoPeriodo.sincronizacao?.estado === 'confirmado_servidor';
        $('periodo-confirmar').disabled = confirmado;
        $('periodo-confirmar').textContent = confirmado ? 'Confirmado pelo servidor' : planoPeriodo.sincronizacao?.estado === 'falhou' ? 'Tentar novamente' : 'Confirmar plano';
        $('periodo-status').textContent = confirmado ? 'Plano confirmado pelo servidor.' : planoPeriodo.sincronizacao?.erro ? `Rascunho recuperado: ${planoPeriodo.sincronizacao.erro}` : 'Rascunho local recuperado.';
        $('periodo-status').className = confirmado ? 'ok' : 'pendente';
    }
    restaurarDatasPeriodo();
    window.iniciarDiagnostico?.((rota, corpo, opcoes) => cliente.solicitar(rota, corpo, opcoes));
    await verificarServidor();
    const rascunhosNoServidor = await carregarRascunhosBackend();
    $('salvamento').textContent = rascunhosNoServidor ? 'Rascunhos sincronizados com o servidor' : 'Somente neste navegador · servidor indisponível';
    await carregarBibliotecaTemplates();
    sincronizarCampos(); atualizarSeletorConteudos(); renderizarMidias(); renderizarRevisao(); renderizarStatusPublicacao();
    carregarModelos(); carregarAnteriores(true);
    globalThis.AstraContexto = {
        avisar,
        cliente: (rota, corpo, opcoes) => cliente.solicitar(rota, corpo, opcoes),
        ler: lerArmazenamento,
        gravar: salvarArmazenamento,
        obterMidias: () => bibliotecaMidias,
        registrarDiagnostico: (secao, evento, dados) => registrar(evento, dados)
    };
    window.AstraContexto = globalThis.AstraContexto;
    window.MetaConexao?.iniciar({ cliente: (rota, corpo, opcoes) => cliente.solicitar(rota, corpo, opcoes), aoAtualizar: async () => { await carregarIntegracoes(); await restaurarConexoes(); }, aoConectar: perfil => { perfilFacebook = perfil; $('status-facebook').textContent = perfil ? `Página conectada: ${perfil.name} · ID ${perfil.id}` : 'Conecte ou verifique a Página.'; renderizarRevisao(); } });
    window.AstraLogs?.iniciar({ cliente: (rota, corpo, opcoes) => cliente.solicitar(rota, corpo, opcoes), timezone: atual.fuso });
    window.addEventListener?.('error', evento => window.AstraLogs?.registrar({ nivel: 'ERROR', modulo: 'FRONTEND', acao: 'erro_nao_tratado', mensagem: evento.message, contexto: { arquivo: evento.filename, linha: evento.lineno } }));
    window.addEventListener?.('unhandledrejection', evento => window.AstraLogs?.registrar({ nivel: 'ERROR', modulo: 'FRONTEND', acao: 'promise_rejeitada', mensagem: evento.reason?.message || String(evento.reason || '') }));
    await restaurarConexoes();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
else iniciar();
