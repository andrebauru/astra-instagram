'use strict';

/*
 * Editor principal do Astra (somente Instagram).
 *
 * Fluxo: Mídia → Informações → IA → Revisão → Publicar agora ou Agendar.
 * A UI coordena; a IA prepara; os serviços do backend publicam/agendam.
 */

const R = globalThis.Regras;
const IR = globalThis.IntegracaoRegras;
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
let sugestao;
let perfilInstagram;
let servidorOnline = false;
let templateRequisitosFixo;
let agendaEmpresa;
let temporizadorEmpresa;

/** Aplica a identidade visual sem alterar contratos técnicos. */
function aplicarMarca() {
    document.title = 'Astra Instagram · Estúdio de publicações';
    document.documentElement.dataset.aplicativo = 'Astra Instagram';
}

function elemento(tag, texto, classe) {
    const el = document.createElement(tag);
    if (texto !== undefined) el.textContent = texto;
    if (classe) el.className = classe;
    return el;
}

function avisar(texto) {
    const alvo = $('mensagem');
    if (!alvo) return;
    alvo.textContent = texto;
    clearTimeout(temporizador);
    temporizador = setTimeout(() => { alvo.textContent = ''; }, 8000);
}

function formatarBytes(bytes) {
    const valor = Number(bytes) || 0;
    if (valor < 1024) return `${valor} B`;
    if (valor < 1048576) return `${(valor / 1024).toFixed(1)} KB`;
    return `${(valor / 1048576).toFixed(1)} MB`;
}

function registrar(evento, dados = {}) { window.registrarDiagnostico?.('EDITOR', evento, dados); }

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
    if (!banco) { if (!silencioso) avisar('Armazenamento local indisponível. Os dados ficam apenas nesta aba.'); return false; }
    try {
        await salvarArmazenamento('conteudos', conteudos);
        try { await salvarArmazenamento('biblioteca-midias', bibliotecaMidias); } catch { /* melhor esforço */ }
        $('salvamento').textContent = 'Salvo neste navegador · ' + new Date().toLocaleTimeString('pt-BR');
        if (!silencioso) avisar('✓ Salvo');
        return true;
    } catch (erro) {
        registrar('save_failed', { message: erro.message });
        if (!silencioso) avisar('Não foi possível salvar. Verifique o espaço do navegador.');
        return false;
    }
}

function marcarAlterado() { $('salvamento').textContent = 'Alterações ainda não salvas'; }

// ============================================================
// MÍDIA
// ============================================================

function urlPublicaDaMidia(midia) { return IR.urlPublicaHttps(midia?.urlPublica) ? midia.urlPublica : ''; }

/** Lê um arquivo local, valida formato/tamanho/integridade e devolve metadados. */
async function lerArquivo(arquivo) {
    const imagem = ['image/jpeg', 'image/png', 'image/webp'].includes(arquivo.type);
    const video = arquivo.type === 'video/mp4';
    if (!imagem && !video) throw new Error(`${arquivo.name}: use JPEG, PNG, WebP ou MP4.`);
    if (arquivo.size > (video ? 50 : 5) * 1024 * 1024) throw new Error(`${arquivo.name}: excede o tamanho permitido (${video ? '50 MB' : '5 MB'}).`);
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
        visual.onerror = () => reject(new Error(`${arquivo.name}: o vídeo não pôde ser validado.`));
        visual.src = dados;
    });
    return { id: crypto.randomUUID(), nome: arquivo.name, dados, miniatura: dados, tipo: video ? 'video' : 'imagem', mime: arquivo.type, tamanho: arquivo.size, duracao, status: 'disponível', statusProcessamento: 'concluído', urlPublica: '', tags: [] };
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
        const legenda = elemento('figcaption', `${indice + 1}. ${foto.nome} · ${foto.tipo}${duracao} · ${url ? 'disponível' : 'sem URL pública'} · ${formatarBytes(foto.tamanho)}`);
        const controles = elemento('div');
        for (const [texto, deslocamento] of [['←', -1], ['→', 1], ['Remover', 0]]) {
            const botao = elemento('button', texto); botao.type = 'button';
            botao.setAttribute('aria-label', `${texto === 'Remover' ? 'Remover' : deslocamento < 0 ? 'Mover para antes' : 'Mover para depois'} ${foto.nome}`);
            botao.disabled = deslocamento !== 0 && (indice + deslocamento < 0 || indice + deslocamento >= atual.imagens.length);
            botao.onclick = () => {
                if (!deslocamento) atual.imagens.splice(indice, 1);
                else [atual.imagens[indice], atual.imagens[indice + deslocamento]] = [atual.imagens[indice + deslocamento], atual.imagens[indice]];
                IR.sincronizarUrlsPublicas(atual); marcarAlterado(); renderizarMidias(); renderizarRevisao();
            };
            controles.append(botao);
        }
        if (!url) {
            const enviar = elemento('button', 'Enviar mídia'); enviar.type = 'button';
            enviar.onclick = () => enviarMidia(foto, enviar);
            controles.append(enviar);
        }
        figura.append(imagem, legenda);
        if (url) {
            const link = elemento('a', `✓ Enviada · ${url}`, 'nota');
            link.href = url; link.target = '_blank'; link.rel = 'noopener'; link.title = 'Abrir a URL pública';
            figura.append(link);
        }
        figura.append(controles);
        galeria.append(figura);
    });
}

/** Envia uma mídia local ao MediaService, sincroniza o estado e o campo visual. */
async function enviarMidia(midia, botao) {
    if (midia.tipo !== 'imagem') { avisar('Somente imagens JPEG/PNG/WebP usam o upload público nesta versão.'); return; }
    const conteudo = atual;
    const original = botao?.textContent;
    if (botao) { botao.disabled = true; botao.textContent = 'Enviando…'; }
    try {
        const resposta = await cliente.solicitar('/media/upload', { id: midia.id, dados: midia.dados, mime: midia.mime, nome: midia.nome }, { prazo: 60000 });
        if (typeof resposta?.public_url !== 'string' || !resposta.public_url) throw Object.assign(new Error('O servidor não retornou public_url.'), { codigo: 'MIDIA_UPLOAD_RESPOSTA_INVALIDA' });
        // Re-localiza pelo ID estável: a referência antiga pode ter sido recriada.
        const atualizada = Publicacoes.registrarUrlPublica(conteudo, midia.id, resposta.public_url, resposta);
        if (!atualizada) throw Object.assign(new Error('A mídia enviada não foi encontrada no conteúdo atual.'), { codigo: 'MIDIA_NAO_ENCONTRADA' });
        registrar('media_uploaded', { mediaId: midia.id, mime: midia.mime, bytes: atualizada.tamanho });
        marcarAlterado();
        if (conteudo === atual) { sincronizarCampos(); renderizarMidias(); renderizarRevisao(); }
        await salvar(true);
        avisar('✓ Imagem enviada. URL pública preenchida.');
    } catch (erro) {
        registrar('media_upload_failed', { mediaId: midia.id, code: erro.codigo, message: erro.message });
        avisar(`Upload: ${erro.message}`);
    } finally {
        if (botao) { botao.disabled = false; botao.textContent = original; }
    }
}

async function processarArquivos(arquivos) {
    const acao = $('acao-upload').value;
    const progresso = $('progresso-upload');
    progresso.replaceChildren();
    const lidas = []; const falhas = [];
    for (const arquivo of arquivos) {
        const linha = elemento('div', `… ${arquivo.name}`, 'nota');
        progresso.append(linha);
        try {
            const midia = await lerArquivo(arquivo);
            lidas.push(midia);
            linha.textContent = `✓ ${arquivo.name} · ${midia.tipo} · ${formatarBytes(midia.tamanho)}`;
            registrar('media_read', { file: arquivo.name, type: arquivo.type, bytes: arquivo.size, result: 'sucesso' });
        } catch (erro) {
            falhas.push(arquivo.name);
            linha.textContent = `✗ ${arquivo.name} · ${erro.message}`;
            registrar('media_read', { file: arquivo.name, result: 'falhou', message: erro.message });
        }
    }
    if (!lidas.length) { avisar(falhas.length ? 'Nenhum arquivo válido foi adicionado.' : 'Nenhum arquivo selecionado.'); return; }
    bibliotecaMidias.push(...lidas);
    bibliotecaMidias = bibliotecaMidias.slice(-200);
    if (acao === 'carrossel') {
        atual.tipoMidia = 'carrossel';
        atual.imagens = [...lidas];
        try { globalThis.PlanejamentoSemanal.criarCarrossel(lidas, {}); } catch (erro) { avisar(erro.message); }
        atual.estado = 'rascunho';
    } else if (acao === 'distribuir') {
        for (const midia of lidas) {
            const novo = R.criarConteudo();
            novo.titulo = midia.nome; novo.imagens = [midia];
            novo.tipoMidia = midia.tipo === 'video' ? 'reel' : 'imagem';
            Empresa.aplicarAgendaEmpresa(novo, agendaEmpresa);
            conteudos.push(novo);
        }
        atual = conteudos[conteudos.length - 1];
        IR.sincronizarUrlsPublicas(atual);
        avisar(`${lidas.length} conteúdo(s) criado(s) para agendar. Preencha informações e agende em Agendamentos.`);
    } else {
        for (const midia of lidas) {
            if (atual.imagens.length >= 10) { avisar('Limite local de 10 mídias por conteúdo.'); break; }
            atual.imagens.push(midia);
        }
    }
    IR.sincronizarUrlsPublicas(atual);
    atual.estado = 'rascunho';
    marcarAlterado(); sincronizarCampos(); renderizarMidias(); renderizarRevisao();
    if (falhas.length) avisar(`${lidas.length} adicionada(s); ${falhas.length} arquivo(s) falharam sem apagar os demais.`);
}

// ============================================================
// CAMPOS E REVISÃO
// ============================================================

const CAMPOS = ['objetivo', 'tema', 'fatos', 'contexto', 'fatosIa', 'textoMidia', 'hashtags', 'palavras', 'ideias', 'imagemUrl', 'videoUrl', 'legenda', 'agendar-data', 'agendar-hora'];

function sincronizarCampos() {
    $('tipoMidia').value = atual.tipoMidia;
    for (const campo of ['objetivo', 'tema', 'fatos', 'contexto', 'fatosIa', 'textoMidia', 'hashtags', 'palavras', 'ideias', 'imagemUrl', 'videoUrl', 'legenda']) if ($(campo)) $(campo).value = atual[campo] || '';
    // Garante que o campo visual reflita o estado mesmo após upload/migração.
    if ($('imagemUrl')) Publicacoes.sincronizarUrlPublicaNoCampo($('imagemUrl'), atual);
    $('campo-imagem-url').hidden = atual.tipoMidia === 'reel';
    $('campo-video-url').hidden = atual.tipoMidia !== 'reel';
    $('usar-visao').checked = atual.usarVisao !== false;
    if ($('agendar-fuso')) $('agendar-fuso').value = atual.fuso || 'Asia/Tokyo';
    $('estado').textContent = Publicacoes.estadoPublicacao(atual);
}

function renderizarRevisao() {
    const previas = $('previas');
    previas.replaceChildren();
    const cartao = elemento('div', undefined, 'previa');
    const legendaFinal = R.compor(atual) || 'Sua legenda aparecerá aqui.';
    cartao.append(elemento('strong', 'Instagram'), elemento('p', 'Prévia local · apresentação aproximada', 'nota'));
    if (atual.imagens[0]) {
        const img = elemento('img'); img.src = atual.imagens[0].miniatura || atual.imagens[0].dados; img.alt = atual.imagens[0].nome; cartao.append(img);
    } else if (urlPublicaDaMidia({ urlPublica: atual.imagemUrl })) {
        const img = elemento('img'); img.src = atual.imagemUrl; img.alt = 'Imagem por URL'; cartao.append(img);
    }
    cartao.append(elemento('p', legendaFinal, 'texto-final'));
    previas.append(cartao);

    const validacoes = R.validar(atual, Date.now(), { exigirMidia: false });
    const midiaOk = IR.midiasPublicasProntas(atual);
    validacoes.push({ ok: midiaOk, texto: 'URL HTTPS pública da mídia pronta para publicação' });
    $('validacoes').replaceChildren(...validacoes.map(item => elemento('li', `${item.ok ? '✓' : '○'} ${item.texto}`, item.ok ? 'ok' : 'pendente')));
    const pronto = validacoes.every(item => item.ok);
    $('aprovar').disabled = !pronto;
    renderizarValidacoesPublicacao(pronto);
}

function renderizarValidacoesPublicacao(prontoConteudo) {
    const itens = IR.validarInstagram(atual, R);
    $('validacoes-publicacao').replaceChildren(...itens.map(item => elemento('li', `${item.ok ? '✓' : '○'} ${item.texto}`, item.ok ? 'ok' : 'pendente')));
    const podePublicar = prontoConteudo && itens.every(item => item.ok) && Boolean(perfilInstagram) && atual.estado === 'confirmado';
    $('preparar-publicacao').disabled = enviandoPublicacao || !podePublicar;
    $('resultado-publicacao').textContent = atual.publicacaoReal
        ? (atual.publicacaoReal.estado === 'publicado' ? `Publicada · ID ${atual.publicacaoReal.idPublicado}` : `${atual.publicacaoReal.mensagem || 'Resultado não confirmado.'} Confira o Instagram antes de repetir.`)
        : (perfilInstagram ? 'Conexão verificada. Confirme o conteúdo para habilitar a publicação.' : 'Use "Testar Instagram" antes de publicar.');
}

// ============================================================
// IA
// ============================================================

function mostrarModeloSelecionado() {
    const modelo = modelosDisponiveis.find(item => item.id === $('modelo-astra').value);
    if (!modelo) { $('detalhes-modelo').textContent = 'Carregue a lista para escolher um modelo.'; return; }
    const moeda = valor => typeof valor === 'number' && Number.isFinite(valor) ? new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(valor) : 'Preço não informado';
    const preco = modelo.pricing.inputPerMillion === null && modelo.pricing.outputPerMillion === null ? 'Preço não informado' : `Entrada: ${moeda(modelo.pricing.inputPerMillion)} · Saída: ${moeda(modelo.pricing.outputPerMillion)} por 1M tokens`;
    $('detalhes-modelo').textContent = `${modelo.id} · ${modelo.family} · ${modelo.vision ? '👁 Visão' : 'Entrada de texto'} · Contexto: ${modelo.contextLength ? modelo.contextLength.toLocaleString('pt-BR') + ' tokens' : 'não informado'} · ${preco}`;
    $('aviso-visao').textContent = (atual.imagens.length || atual.imagemUrl) && modelo.vision === false ? 'O modelo selecionado não analisa imagens; a legenda será criada com texto.' : 'Visão opcional: a primeira imagem é enviada quando habilitada e compatível.';
}

async function carregarModelos(atualizar = false) {
    if (carregandoModelos) return;
    carregandoModelos = true;
    $('atualizar-modelos').disabled = true; $('modelo-astra').disabled = true;
    $('status-modelos').textContent = 'Atualizando modelos…';
    try {
        const anterior = atual.modeloAstra || $('modelo-astra').value;
        const dados = await cliente.solicitar('/astra/models', undefined, { prazo: 20000, atualizar });
        if (!Array.isArray(dados.models) || !dados.models.length || !dados.models.some(m => m.id === dados.defaultModel)) throw new Error('O servidor não retornou uma seleção válida de modelos.');
        modelosDisponiveis = dados.models;
        $('modelo-astra').replaceChildren();
        for (const categoria of ['Econômico', 'Equilibrado', 'Maior capacidade']) {
            const grupo = elemento('optgroup'); grupo.label = categoria;
            modelosDisponiveis.filter(m => m.category === categoria).forEach(m => { const o = elemento('option', `${m.vision ? '👁 Visão · ' : ''}${m.name}`); o.value = m.id; grupo.append(o); });
            if (grupo.children.length) $('modelo-astra').append(grupo);
        }
        $('modelo-astra').value = modelosDisponiveis.some(m => m.id === anterior) ? anterior : dados.defaultModel;
        $('status-modelos').textContent = `${modelosDisponiveis.length} modelos · ${dados.cached ? 'catálogo em cache' : 'catálogo atualizado'}`;
        mostrarModeloSelecionado();
    } catch (erro) {
        $('status-modelos').textContent = `${erro.message} A edição manual continua disponível.`;
    } finally {
        carregandoModelos = false; $('atualizar-modelos').disabled = false; $('modelo-astra').disabled = !modelosDisponiveis.length;
    }
}

async function gerarLegenda(reescrever) {
    const modelo = modelosDisponiveis.find(m => m.id === $('modelo-astra').value);
    if (!modelo) { avisar('Selecione um modelo válido antes de gerar.'); return; }
    let prompt;
    try { prompt = IR.montarPrompt(atual, reescrever, Boolean(modelo.vision)); } catch (erro) { avisar(erro.message); return; }
    const disponivel = atual.imagens[0]?.dados || (atual.tipoMidia !== 'reel' ? atual.imagemUrl : '');
    const imagem = atual.usarVisao !== false && modelo.vision ? disponivel : undefined;
    atual.modeloAstra = modelo.id;
    const botao = reescrever ? $('reescrever-legenda') : $('gerar-legenda');
    const original = botao.textContent; botao.disabled = true; botao.textContent = 'Astra está escrevendo…';
    try {
        const resposta = await cliente.solicitar('/astra/generate', { prompt, model: modelo.id, ...(imagem ? { imagem } : {}) }, { prazo: 120000 });
        const texto = resposta.astra?.text;
        if (typeof texto !== 'string' || !texto.trim()) throw new Error('Astra não retornou texto para revisão.');
        atual.legenda = texto; atual.estado = 'rascunho';
        $('legenda').value = texto;
        marcarAlterado(); renderizarRevisao();
        avisar('Legenda recebida. Revise e edite antes de confirmar.');
    } catch (erro) {
        registrar('ai_generate_failed', { code: erro.codigo, message: erro.message });
        avisar(`IA: ${erro.message} Você pode escrever manualmente.`);
    } finally { botao.disabled = false; botao.textContent = original; }
}

async function analisarMidia() {
    const modelo = modelosDisponiveis.find(m => m.id === $('modelo-astra').value);
    const imagem = atual.imagens[0]?.dados || (atual.tipoMidia !== 'reel' ? atual.imagemUrl : '');
    if (!imagem || !modelo?.vision) { avisar('Selecione uma imagem e um modelo com visão para analisar a mídia.'); return; }
    const botao = $('analisar-midia'); botao.disabled = true; botao.textContent = 'Analisando mídia…';
    try {
        const resposta = await cliente.solicitar('/astra/generate', {
            model: modelo.id, imagem,
            prompt: 'Analise a mídia e retorne SOMENTE JSON válido {"fatos":["fato visual curto"],"texto":["texto visível exato"]}. Separe interpretação de OCR. Não invente nomes, datas, preços ou acontecimentos.'
        }, { prazo: 120000 });
        const bruto = resposta.astra?.text?.match(/\{[\s\S]*\}/)?.[0];
        const dados = bruto ? JSON.parse(bruto) : null;
        if (!dados || !Array.isArray(dados.fatos) || !Array.isArray(dados.texto)) throw new Error('A análise não retornou o formato esperado.');
        atual.fatosIa = dados.fatos.filter(item => typeof item === 'string').join('\n');
        atual.textoMidia = dados.texto.filter(item => typeof item === 'string').join('\n');
        $('fatosIa').value = atual.fatosIa; $('textoMidia').value = atual.textoMidia;
        marcarAlterado(); renderizarRevisao();
        avisar('Análise concluída. Revise os fatos e o texto.');
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
        $('detalhes-servidor').textContent = `Instagram: ${dados.instagramConfigured ? 'configurado' : 'não configurado'} · IA: ${dados.aiConfigured ? 'configurada' : 'não configurada'} · Mídia: ${dados.mediaStorageConfigured ? 'pronta' : 'não configurada'} · Build ${dados.buildId} · Modelo ${dados.model}`;
    } catch (erro) {
        servidorOnline = false; perfilInstagram = undefined;
        $('status-servidor').textContent = erro.codigo === 'OFFLINE' || erro.codigo === 'TEMPO_ESGOTADO' ? 'Servidor local offline. Inicie o Astra Instagram.' : erro.message;
        $('detalhes-servidor').textContent = 'A edição local continua disponível.';
        $('status-instagram').textContent = 'Instagram ainda não verificado.';
    } finally { $('atualizar-conexao').disabled = false; renderizarRevisao(); }
}

async function verificarInstagram() {
    $('testar-instagram').disabled = true; perfilInstagram = undefined;
    $('status-instagram').textContent = 'Verificando Instagram…';
    try {
        const dados = await cliente.solicitar('/meta/me', undefined, { prazo: 20000 });
        if (dados.success !== true || !dados.profile?.id) throw new Error('O servidor não confirmou o perfil do Instagram.');
        perfilInstagram = { ...dados.profile, destinoId: dados.publishingAccountId || dados.profile.id };
        $('status-instagram').textContent = `Instagram conectado${perfilInstagram.username ? ' · @' + perfilInstagram.username : ''} · ID ${perfilInstagram.id}${perfilInstagram.account_type ? ' · ' + perfilInstagram.account_type : ''}`;
    } catch (erro) { $('status-instagram').textContent = erro.message; }
    finally { $('testar-instagram').disabled = false; renderizarRevisao(); }
}

function montarEntradaPublicacao() {
    if (atual.tipoMidia === 'carrossel') {
        const itens = atual.imagens.map(item => ({ tipo: item.tipo, url: urlPublicaDaMidia(item) }));
        return { formato: 'carrossel', itens, caption: R.compor(atual) };
    }
    if (atual.tipoMidia === 'reel') return { formato: 'reel', videoUrl: atual.videoUrl.trim(), caption: R.compor(atual) };
    return { formato: 'imagem', imageUrl: atual.imagemUrl.trim(), caption: R.compor(atual) };
}

function prepararPublicacao() {
    if (!perfilInstagram || IR.validarInstagram(atual, R).some(item => !item.ok) || atual.estado !== 'confirmado') { avisar('Confirme o conteúdo e resolva as pendências.'); return; }
    const entrada = montarEntradaPublicacao();
    confirmacaoAtual = { id: atual.id, assinatura: IR.assinaturaConteudo(atual), entrada, conta: perfilInstagram.destinoId };
    $('conta-confirmacao').textContent = `Perfil: ${perfilInstagram.username ? '@' + perfilInstagram.username : perfilInstagram.id}. Destino no backend: ${perfilInstagram.destinoId}.`;
    $('midia-confirmacao').textContent = JSON.stringify(entrada.formato === 'carrossel' ? entrada.itens : { [entrada.formato === 'reel' ? 'videoUrl' : 'imageUrl']: entrada.videoUrl || entrada.imageUrl }, null, 2);
    $('legenda-confirmacao').textContent = entrada.caption;
    $('autorizo-publicacao').checked = false; $('confirmar-publicacao').disabled = true;
    $('confirmacao-publicacao').showModal();
}

async function confirmarPublicacao() {
    const confirmacao = confirmacaoAtual;
    if (!confirmacao || enviandoPublicacao || !$('autorizo-publicacao').checked) return;
    if (atual.id !== confirmacao.id || IR.assinaturaConteudo(atual) !== confirmacao.assinatura || IR.validarInstagram(atual, R).some(item => !item.ok)) {
        $('confirmacao-publicacao').close(); confirmacaoAtual = undefined; avisar('O conteúdo mudou. Revise novamente.'); return;
    }
    enviandoPublicacao = true; $('confirmar-publicacao').disabled = true; $('cancelar-publicacao').disabled = true;
    const tentativa = { estado: 'enviando', tentativaId: crypto.randomUUID(), iniciadoEm: new Date().toISOString() };
    atual.publicacaoReal = tentativa; marcarAlterado();
    if (!await salvar(true)) { delete atual.publicacaoReal; enviandoPublicacao = false; $('cancelar-publicacao').disabled = false; $('confirmacao-publicacao').close(); confirmacaoAtual = undefined; avisar('Envio cancelado: não foi possível registrar a tentativa.'); return; }
    $('confirmacao-publicacao').close(); confirmacaoAtual = undefined;
    registrar('publish_started', { publication: atual.id, formato: confirmacao.entrada.formato });
    try {
        const resposta = await cliente.solicitar('/instagram/publish', { ...confirmacao.entrada, publicationId: atual.id }, { prazo: 270000, id: tentativa.tentativaId });
        if (resposta.success !== true || !resposta.published?.id) throw new Error('O servidor não confirmou o identificador da publicação.');
        tentativa.estado = 'publicado'; tentativa.idPublicado = resposta.published.id; tentativa.finalizadoEm = new Date().toISOString();
        registrar('publish_confirmed', { publication: atual.id, metaMediaId: tentativa.idPublicado });
        avisar('Publicação confirmada no Instagram.');
    } catch (erro) {
        tentativa.estado = 'incerto'; tentativa.mensagem = erro.message;
        registrar('publish_failed', { publication: atual.id, code: erro.codigo, message: erro.message });
        avisar(erro.message);
    } finally { enviandoPublicacao = false; $('cancelar-publicacao').disabled = false; renderizarRevisao(); await salvar(true); }
}

// ============================================================
// AGENDAMENTO (reutiliza o mesmo SchedulerService)
// ============================================================

async function criarAgendamento() {
    if (atual.estado !== 'confirmado') { avisar('Confirme o conteúdo antes de agendar.'); return; }
    if (!IR.midiasPublicasProntas(atual)) { avisar('A mídia precisa de URL HTTPS pública antes de agendar.'); return; }
    const data = $('agendar-data').value; const hora = $('agendar-hora').value; const fuso = $('agendar-fuso').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || !/^\d{2}:\d{2}$/.test(hora)) { avisar('Informe data e horário válidos.'); return; }
    const instantes = R.instantes(data, hora, fuso);
    if (instantes.length !== 1) { avisar('Data/horário inválidos no fuso informado.'); return; }
    if (instantes[0] <= Date.now()) { avisar('Escolha um horário futuro.'); return; }
    const PS = globalThis.PlanejamentoSemanal;
    const tipo = atual.tipoMidia === 'carrossel' ? 'carrossel' : atual.tipoMidia === 'reel' ? 'video' : 'imagem';
    const item = {
        id: `item-${crypto.randomUUID()}`,
        mediaId: atual.id,
        tipo,
        data, hora, timezone: fuso,
        destinos: ['Instagram'],
        legenda: R.compor(atual),
        status: 'rascunho',
        approvalSignature: null,
        atraso: 'reagendar',
        toleranciaMinutos: 30,
        url: tipo === 'carrossel' ? null : (tipo === 'video' ? atual.videoUrl : atual.imagemUrl),
        itens: tipo === 'carrossel' ? atual.imagens.map((m, ordem) => ({ mediaId: m.id, ordem, tipo: m.tipo, url: urlPublicaDaMidia(m) })) : null,
        resultados: {}
    };
    const plano = PS.aprovar({ id: `plano-${crypto.randomUUID()}`, status: 'rascunho', timezone: fuso, config: { timezone: fuso }, itens: [item] });
    try {
        await cliente.solicitar('/agenda/planos', { planos: [plano] }, { prazo: 15000 });
        atual.estado = 'agendada'; marcarAlterado(); await salvar(true);
        registrar('scheduled', { publication: atual.id, plano: plano.id, data, hora, timezone: fuso });
        avisar('Agendamento adicionado. Acompanhe em Agendamentos.');
    } catch (erro) { avisar(`Não foi possível agendar: ${erro.message}`); }
}

// ============================================================
// EMPRESA / TEMPLATE
// ============================================================

function atualizarControlesTemplate() {
    const aplicar = $('aplicar-template-requisitos');
    if (aplicar) aplicar.disabled = !templateRequisitosFixo;
    if ($('status-template-requisitos')) $('status-template-requisitos').textContent = templateRequisitosFixo ? 'Template fixo disponível no backend.' : 'Nenhum template fixo salvo.';
}

async function salvarTemplate() {
    templateRequisitosFixo = Empresa.criarTemplateRequisitos(atual);
    try {
        await cliente.solicitar('/empresa/template', { template: templateRequisitosFixo }, { prazo: 15000 });
        atualizarControlesTemplate(); avisar('Template fixo salvo no backend.');
    } catch (erro) { avisar(`Não foi possível salvar o template: ${erro.message}`); }
}

function aplicarTemplate() {
    Empresa.aplicarTemplateRequisitos(atual, templateRequisitosFixo);
    marcarAlterado(); sincronizarCampos(); renderizarRevisao(); avisar('Template fixo aplicado.');
}

function agendarSalvarEmpresa() {
    clearTimeout(temporizadorEmpresa);
    temporizadorEmpresa = setTimeout(async () => {
        agendaEmpresa = Empresa.criarAgendaEmpresa(atual);
        try { await cliente.solicitar('/empresa/agenda', { agenda: agendaEmpresa }, { prazo: 10000 }); } catch { /* melhor esforço */ }
    }, 400);
}

// ============================================================
// INICIALIZAÇÃO
// ============================================================

function conectarCampos() {
    for (const campo of ['objetivo', 'tema', 'fatos', 'contexto', 'fatosIa', 'textoMidia', 'hashtags', 'palavras', 'ideias', 'imagemUrl', 'videoUrl', 'legenda']) {
        if (!$(campo)) continue;
        $(campo).oninput = () => { atual[campo] = $(campo).value; atual.estado = 'rascunho'; marcarAlterado(); renderizarRevisao(); };
    }
    $('tipoMidia').onchange = () => { atual.tipoMidia = $('tipoMidia').value; IR.sincronizarUrlsPublicas(atual); atual.estado = 'rascunho'; marcarAlterado(); sincronizarCampos(); renderizarRevisao(); };
    $('usar-visao').onchange = () => { atual.usarVisao = $('usar-visao').checked; marcarAlterado(); };
    $('arquivos').onchange = async event => { const arquivos = [...event.target.files]; event.target.value = ''; event.target.disabled = true; try { await processarArquivos(arquivos); } finally { event.target.disabled = false; } };
    $('gerar-legenda').onclick = () => { if ($('modo-legenda').value === 'manual') { avisar('Modo manual: escreva a legenda diretamente.'); return; } gerarLegenda(false); };
    $('reescrever-legenda').onclick = () => { if ($('modo-legenda').value === 'manual') { avisar('Modo manual: edite a legenda diretamente.'); return; } gerarLegenda(true); };
    $('analisar-midia').onclick = analisarMidia;
    $('atualizar-modelos').onclick = () => carregarModelos(true);
    $('modelo-astra').onchange = () => { atual.modeloAstra = $('modelo-astra').value; marcarAlterado(); mostrarModeloSelecionado(); };
    $('revisar').onclick = () => { if (R.validar(atual, Date.now(), { exigirMidia: false }).some(i => !i.ok)) { renderizarRevisao(); avisar('Resolva as pendências do checklist.'); return; } atual.estado = 'em revisão'; marcarAlterado(); renderizarRevisao(); avisar('Conteúdo revisado. Confirme quando estiver pronto.'); };
    $('aprovar').onclick = () => { if (!IR.midiasPublicasProntas(atual) || R.validar(atual, Date.now(), { exigirMidia: false }).some(i => !i.ok)) { renderizarRevisao(); avisar('Ainda há pendências.'); return; } atual.estado = 'confirmado'; marcarAlterado(); renderizarRevisao(); salvar(true); avisar('Conteúdo confirmado. Use publicar agora ou agendar.'); };
    $('preparar-publicacao').onclick = prepararPublicacao;
    $('cancelar-publicacao').onclick = () => { confirmacaoAtual = undefined; $('confirmacao-publicacao').close(); };
    $('autorizo-publicacao').onchange = () => { $('confirmar-publicacao').disabled = !$('autorizo-publicacao').checked || enviandoPublicacao; };
    $('confirmar-publicacao').onclick = confirmarPublicacao;
    $('confirmacao-publicacao').oncancel = event => { if (enviandoPublicacao) event.preventDefault(); else confirmacaoAtual = undefined; };
    $('criar-agendamento').onclick = criarAgendamento;
    for (const campo of ['agendar-data', 'agendar-hora', 'agendar-fuso']) $(campo).oninput = () => { atual.fuso = $('agendar-fuso').value; marcarAlterado(); agendarSalvarEmpresa(); };
    $('atualizar-conexao').onclick = verificarServidor;
    $('testar-instagram').onclick = verificarInstagram;
    $('salvar').onclick = () => salvar(false);
    $('salvar-template-requisitos').onclick = salvarTemplate;
    $('aplicar-template-requisitos').onclick = aplicarTemplate;
    $('template-publicacao').onchange = () => { atual.templateId = $('template-publicacao').value; marcarAlterado(); };
    $('modo-legenda').onchange = () => { $('selecao-modelo').hidden = $('modo-legenda').value !== 'astra'; };
}

function restaurarAgendaPadrao() {
    if ($('agendar-data') && !$('agendar-data').value) {
        const hoje = new Intl.DateTimeFormat('sv-SE', { timeZone: atual.fuso || 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
        const amanha = new Date(`${hoje}T12:00:00Z`); amanha.setUTCDate(amanha.getUTCDate() + 1);
        $('agendar-data').value = amanha.toISOString().slice(0, 10);
    }
}

async function iniciar() {
    aplicarMarca();
    conectarCampos();
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
        if (!$('template-publicacao').value) $('template-publicacao').value = atual.templateId || 'padrao';
    } catch { avisar('Armazenamento local indisponível. Os dados ficam apenas nesta aba.'); }
    atualizarControlesTemplate();
    IR.sincronizarUrlsPublicas(atual);
    sincronizarCampos();
    renderizarMidias();
    renderizarRevisao();
    restaurarAgendaPadrao();
    window.iniciarDiagnostico?.((rota, corpo, opcoes) => cliente.solicitar(rota, corpo, opcoes));
    verificarServidor();
    carregarModelos();
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
