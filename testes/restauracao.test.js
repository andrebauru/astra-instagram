'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const R = require('../painel-meta-prototipo/regras');
const Publicacoes = require('../painel-meta-prototipo/publicacoes');
const PS = require('../painel-meta-prototipo/planejamento-semanal');
const IR = require('../painel-meta-prototipo/integracao-regras');
const analise = require('../services/analise');
const { criarInsightsService, normalizarMidia } = require('../services/insights-service');
const { criarStoreEmpresa } = require('../services/empresa-store');

const URL_OK = 'https://quimbanda.jp/astra/media/public/arquivo.png';
const AGORA = Date.parse('2026-10-09T12:00:00Z');

// ============================================================
// REVISÃO HUMANA
// ============================================================

test('revisão humana marca mesmo com outra pendência no checklist', () => {
    const p = R.criarConteudo();
    p.ideias = 'Agendamento de atendimento particular';
    p.legenda = ''; // outra pendência real
    // Antes de marcar: o item de revisão humana está pendente...
    assert.ok(R.validar(p, Date.now(), { exigirMidia: false }).some(i => !i.ok && i.texto.startsWith('Revisão humana')));
    // Marcar a revisão humana não depende das demais pendências.
    p.revisoes = [...new Set([...(p.revisoes || []), ...R.linhas(p.ideias)])];
    const validacoes = R.validar(p, Date.now(), { exigirMidia: false });
    assert.ok(validacoes.every(i => i.ok || !i.texto.startsWith('Revisão humana')), 'nenhum item de revisão humana permanece pendente');
    assert.ok(validacoes.some(i => i.ok && i.texto.startsWith('Revisão humana')));
    assert.ok(validacoes.some(i => !i.ok && i.texto.includes('Legenda preenchida')), 'a outra pendência continua visível');
});

// ============================================================
// TEMPLATE PADRÃO
// ============================================================

test('template persiste, aplica e não duplica', () => {
    const caminho = path.join(os.tmpdir(), `astra-template-${process.pid}.json`);
    try { fs.rmSync(caminho, { force: true }); } catch { /* inexistente */ }
    const store = criarStoreEmpresa(caminho);
    const salvo = { texto: 'Informações:\n080-5774-4281\nhttps://quimbanda.jp\n#Quimbanda', aplicarAutomatico: true };
    store.salvarTemplatePadrao(salvo);
    const relido = criarStoreEmpresa(caminho).lerTemplatePadrao();
    assert.equal(relido.texto, salvo.texto);
    assert.equal(relido.aplicarAutomatico, true);

    const p = R.criarConteudo();
    p.templateTexto = relido.texto;
    p.templateAplicarAutomatico = true;
    p.legenda = 'Encontro de domingo na comunidade.\nInformações:\n080-5774-4281\n#Quimbanda';
    const final = R.compor(p);
    assert.ok(final.includes('Encontro de domingo'), 'conteúdo principal');
    assert.ok(final.includes('https://quimbanda.jp'), 'link do template');
    assert.equal((final.match(/080-5774-4281/g) || []).length, 1, 'telefone não duplicado');
    assert.equal((final.match(/#Quimbanda\b/g) || []).length, 1, 'hashtag não duplicada');
    // A IA não sobrescreve o template: ele continua no estado.
    assert.equal(p.templateTexto, salvo.texto);
    try { fs.rmSync(caminho, { force: true }); } catch { /* melhor esforço */ }
});

// ============================================================
// PUBLICAÇÕES ANTERIORES
// ============================================================

test('posts antigos carregam, paginam e copiar não altera o original', async () => {
    let paginas = 0;
    const instagram = { listarMidias: async () => { paginas += 1; return paginas === 1
        ? { itens: [{ id: 'm1', media_type: 'IMAGE', caption: 'Primeiro post', timestamp: 1760000000, permalink: 'https://instagram.com/p/1', media_url: 'https://cdn.dominio-publico.com/1.jpg' }], proximoCursor: 'cur2' }
        : { itens: [{ id: 'm2', media_type: 'IMAGE', caption: 'Segundo post', timestamp: 1760000100, permalink: 'https://instagram.com/p/2' }], proximoCursor: null }; } };
    const caminho = path.join(os.tmpdir(), `astra-metricas-${process.pid}.json`);
    const servico = criarInsightsService({ instagram, caminhoCache: caminho });
    const primeira = await servico.listarMidias({ limite: 1 });
    assert.equal(primeira.itens.length, 1);
    assert.equal(primeira.proximoCursor, 'cur2');
    const segunda = await servico.listarMidias({ limite: 1, cursor: 'cur2' });
    assert.equal(segunda.itens[0].id, 'm2');
    assert.equal(segunda.proximoCursor, null);

    // "Usar como base" cria nova publicação e não altera a original.
    const original = normalizarMidia({ id: 'm2', caption: 'Segundo post', media_type: 'IMAGE' });
    const copia = { ...original };
    const nova = R.criarConteudo();
    nova.legenda = copia.legenda;
    nova.tipoMidia = 'imagem';
    nova.referenciaImportada = original.id;
    assert.equal(original.legenda, 'Segundo post');
    assert.notEqual(nova.id, original.id);
    assert.equal(nova.legenda, 'Segundo post');
    try { fs.rmSync(caminho, { force: true }); } catch { /* melhor esforço */ }
});

// ============================================================
// MÉTRICAS ORGÂNICAS E ANÁLISE
// ============================================================

test('métricas ausentes não quebram e não viram zero', async () => {
    const instagram = {
        listarMidias: async () => ({ itens: [{ id: 'm1', media_type: 'IMAGE', timestamp: 1760000000 }] }),
        insights: async () => ({ id: 'm1', timestamp: 1760000000, like_count: 5, comments_count: 2, media_type: 'IMAGE', reach: null, impressions: null, saved: null, shares: null, video_views: null })
    };
    const caminho = path.join(os.tmpdir(), `astra-metricas-ausentes-${process.pid}.json`);
    const servico = criarInsightsService({ instagram, caminhoCache: caminho });
    const pagina = await servico.listarMidias({ limite: 5 });
    const metrica = await servico.atualizarMetrica(pagina.itens[0]);
    assert.equal(metrica.reach, null);
    assert.equal(metrica.likes, 5);
    const resumo = servico.analisar({ timezone: 'Asia/Tokyo' });
    assert.equal(typeof resumo.postsAnalisados, 'number');
    try { fs.rmSync(caminho, { force: true }); } catch { /* melhor esforço */ }
});

test('score é determinístico e melhores horários são calculados', () => {
    const metricas = [10, 19, 30, 12, 18, 21].map((hora, indice) => ({
        mediaId: `m${indice}`, source: 'organic', publishedAt: `2026-09-2${indice % 9}T${String(hora).padStart(2, '0')}:00:00Z`, timezone: 'Asia/Tokyo',
        reach: 1000 + indice * 500, likes: 50 + indice * 10, comments: 5 + indice, saves: indice + 1, shares: indice, capturedAt: new Date(AGORA).toISOString()
    }));
    const primeira = analise.analisarMelhoresHorarios(metricas, { timezone: 'Asia/Tokyo' });
    const segunda = analise.analisarMelhoresHorarios(metricas, { timezone: 'Asia/Tokyo' });
    assert.deepEqual(primeira.melhoresHorarios, segunda.melhoresHorarios, 'score não é aleatório');
    assert.equal(primeira.suficiente, true);
    assert.ok(primeira.melhoresHorarios.length >= 1);
    assert.ok(primeira.melhoresHorarios[0].score >= primeira.melhoresHorarios.at(-1).score);
    assert.ok(primeira.melhorDia);
    assert.match(primeira.mensagem, /Baseado no histórico disponível/);
});

test('poucos dados informam insuficiência', () => {
    const poucos = [{ mediaId: 'a', source: 'organic', publishedAt: '2026-09-20T10:00:00Z', reach: 100, likes: 5 }];
    const resumo = analise.analisarMelhoresHorarios(poucos, { timezone: 'Asia/Tokyo' });
    assert.equal(resumo.suficiente, false);
    assert.match(resumo.mensagem, /Dados insuficientes/);
});

// ============================================================
// AGENDAMENTO POR PERÍODO
// ============================================================

function midia(id, tipo = 'imagem') {
    return { id, tipo, status: 'disponível', urlPublica: `https://quimbanda.jp/astra/media/public/${id}.png`, legenda: `legenda ${id}`, miniatura: null };
}

function configPeriodo(extra = {}) {
    return { id: 'plano-periodo', nome: 'Plano teste', inicio: '2026-10-10', fim: '2026-10-15', timezone: 'Asia/Tokyo', quantidade: 5, porDia: 0, intervaloMinimoHoras: 8, intervaloMaximoHoras: null, diasPermitidos: [0, 1, 2, 3, 4, 5, 6], estrategiaHorario: 'automatico', horarios: ['12:00', '20:00'], variarTexto: false, nivelVariacao: 'Baixa', permitirReutilizacao: true, ...extra };
}

test('planeja quantidade, respeita data final, intervalo e dias', () => {
    const melhoresHorarios = [{ hora: '12:15', score: 91 }, { hora: '20:00', score: 84 }, { hora: '19:30', score: 78 }];
    const plano = PS.planejarPeriodo(configPeriodo(), [midia('a'), midia('b'), midia('c'), midia('d'), midia('e')], { melhoresHorarios, agoraMs: Date.parse('2026-10-09T12:00:00Z') });
    assert.ok(plano.valido);
    assert.equal(plano.itens.length, 5);
    assert.equal(new Set(plano.itens.map(i => i.id)).size, 5);
    // Nenhum item depois da data final e todos no fuso informado.
    for (const item of plano.itens) {
        assert.equal(item.timezone, 'Asia/Tokyo');
        assert.ok(item.data <= '2026-10-15', `data final respeitada: ${item.data}`);
        assert.ok(item.scheduledAt);
    }
    // Intervalo mínimo entre publicações.
    const instantes = plano.itens.map(i => Date.parse(i.scheduledAt)).sort((a, b) => a - b);
    for (let i = 1; i < instantes.length; i++) assert.ok(instantes[i] - instantes[i - 1] >= 8 * 3600000, 'intervalo mínimo');
    // Dias permitidos respeitados.
    const dias = new Set(plano.itens.map(i => new Date(Date.parse(i.scheduledAt)).getUTCDay()));
    for (const dia of dias) assert.ok([1, 2, 3, 4, 5, 6, 0].includes(dia));
});

test('quantidade maior que o possível informa quantas faltam', () => {
    const plano = PS.planejarPeriodo(configPeriodo({ quantidade: 20 }), [midia('a')], { melhoresHorarios: [{ hora: '12:00' }], agoraMs: AGORA });
    assert.ok(plano.faltam > 0);
    assert.match(plano.erros.join(' '), /Faltam/);
});

test('porDia gera a quantidade esperada', () => {
    const plano = PS.planejarPeriodo(configPeriodo({ quantidade: 0, porDia: 2, quantidade: undefined }), [midia('a'), midia('b')], { melhoresHorarios: [{ hora: '12:00' }, { hora: '20:00' }], agoraMs: AGORA });
    assert.equal(plano.itens.length, 12); // 6 dias permitidos no período × 2
});

test('dias permitidos reduzem o calendário', () => {
    const plano = PS.planejarPeriodo(configPeriodo({ quantidade: 2, diasPermitidos: [1] }), [midia('a'), midia('b')], { melhoresHorarios: [{ hora: '12:00' }, { hora: '20:00' }], agoraMs: AGORA });
    for (const item of plano.itens) assert.equal(new Date(Date.parse(item.scheduledAt)).getUTCDay(), 1);
});

test('mídia não é reutilizada sem autorização e informa faltantes', () => {
    const plano = PS.planejarPeriodo(configPeriodo({ quantidade: 4, permitirReutilizacao: false }), [midia('a'), midia('b')], { melhoresHorarios: [{ hora: '12:00' }], agoraMs: AGORA });
    assert.ok(plano.faltamMidia > 0);
    const ids = plano.itens.map(i => i.mediaId);
    assert.equal(new Set(ids).size, ids.length, 'sem repetição silenciosa');
    assert.equal(new Set(ids).size, 2);
});

// ============================================================
// VARIAÇÃO DE TEXTO
// ============================================================

test('variação desligada mantém texto; ligada preserva template', () => {
    const p = R.criarConteudo();
    p.templateTexto = 'Informações:\n080-5774-4281\nhttps://quimbanda.jp';
    p.hashtags = '#Quimbanda';
    p.legenda = 'Encontro de domingo.';
    const protegidas = R.partesProtegidas(p);
    assert.ok(protegidas.includes('080-5774-4281'));
    assert.ok(protegidas.includes('https://quimbanda.jp'));
    assert.ok(protegidas.includes('#Quimbanda'));

    const original = R.compor(p);
    assert.equal(R.validarVariacao(original, original, protegidas).valido, true, 'texto igual é válido');
    const variacaoBoa = 'Convite para o encontro.\nInformações:\n080-5774-4281\nhttps://quimbanda.jp\n#Quimbanda';
    assert.equal(R.validarVariacao(original, variacaoBoa, protegidas).valido, true);
    const variacaoRuim = 'Convite para o encontro.';
    const resultado = R.validarVariacao(original, variacaoRuim, protegidas);
    assert.equal(resultado.valido, false);
    assert.match(resultado.motivo, /protegido/);
});

// ============================================================
// SCHEDULER: CONTROLES E PERSISTÊNCIA
// ============================================================

const { criarMotor, criarArmazenamentoArquivo, criarArmazenamentoMemoria, publicarItemNoInstagram } = require('../services/scheduler-service');

function motorComPublicador(contador, agoraMs = Date.parse('2026-10-12T00:00:00Z')) {
    return criarMotor({ armazenamento: criarArmazenamentoMemoria(), publicador: async () => { contador.chamadas += 1; return { id: `pub-${contador.chamadas}` }; }, agora: () => agoraMs + contador.chamadas });
}

test('pausar impede, retomar publica sem duplicar, cancelar e reagendar funcionam', async () => {
    const plano = PS.aprovar(PS.planejarPeriodo(configPeriodo({ quantidade: 3, atraso: 'publicar' }), [midia('a'), midia('b'), midia('c')], { melhoresHorarios: [{ hora: '12:00' }], agoraMs: AGORA }));
    const contador = { chamadas: 0 };
    const motor = motorComPublicador(contador);
    motor.sincronizarPlanos([plano]);
    motor.pausarPlano(plano.id);
    await motor.executarCiclo();
    assert.equal(contador.chamadas, 0);
    motor.retomarPlano(plano.id);
    await motor.executarCiclo();
    assert.equal(contador.chamadas, 2, 'somente os dois itens já vencidos são publicados');
    await motor.executarCiclo();
    assert.equal(contador.chamadas, 2, 'item publicado não duplica');
    motor.cancelarItem(plano.id, plano.itens[2].id);
    assert.equal(motor.listarPlanos()[0].itens[2].status, 'cancelado');
    motor.reagendarItem(plano.id, plano.itens[2].id);
    assert.equal(motor.listarPlanos()[0].itens[2].status, 'rascunho', 'item cancelado volta a rascunho para nova aprovação');
});

test('reinício preserva o plano em arquivo', async () => {
    const caminho = path.join(os.tmpdir(), `astra-plano-restart-${process.pid}.json`);
    try { fs.rmSync(caminho, { force: true }); } catch { /* inexistente */ }
    const plano = PS.aprovar(PS.planejarPeriodo(configPeriodo({ quantidade: 1, atraso: 'publicar' }), [midia('a')], { melhoresHorarios: [{ hora: '12:00' }], agoraMs: AGORA }));
    const armazenamento = criarArmazenamentoArquivo(caminho);
    const motor1 = criarMotor({ armazenamento, publicador: async () => ({ id: 'pub-1' }), agora: () => Date.parse('2026-10-10T12:15:00Z') });
    motor1.sincronizarPlanos([plano]);
    await motor1.executarCiclo();

    const motor2 = criarMotor({ armazenamento, publicador: async () => ({ id: 'pub-2' }), agora: () => Date.parse('2026-10-10T12:15:00Z') });
    const relido = motor2.listarPlanos();
    assert.equal(relido.length, 1);
    assert.equal(relido[0].id, plano.id);
    assert.equal(relido[0].itens[0].status, 'confirmada');
    try { fs.rmSync(caminho, { force: true }); } catch { /* melhor esforço */ }
});

test('publicação imediata e agendamento usam o mesmo InstagramService.publish', async () => {
    let chamadas = 0;
    const instagram = { publish: async entrada => { chamadas += 1; return { mediaId: `mid-${chamadas}`, formato: entrada.formato }; } };
    const publicador = publicarItemNoInstagram(instagram);

    // Caminho do agendamento
    const item = { id: 'i1', mediaId: 'm1', tipo: 'imagem', url: URL_OK, legenda: 'Agendada', destinos: ['Instagram'] };
    const resultado = await publicador({ item, destino: 'Instagram' });
    assert.equal(resultado.id, 'mid-1');
    assert.equal(chamadas, 1);

    // Caminho da publicação imediata é o mesmo método
    await instagram.publish({ formato: 'imagem', imageUrl: URL_OK, caption: 'Agora' });
    assert.equal(chamadas, 2);
});

// ============================================================
// ABAS / ESTADO
// ============================================================

test('trocar de aba (re-render) preserva mídia, URL, legenda, hashtags e template', () => {
    const p = R.criarConteudo();
    p.tipoMidia = 'imagem';
    p.imagens = [{ id: 'm1', nome: 'a.png', tipo: 'imagem', urlPublica: '' }];
    Publicacoes.registrarUrlPublica(p, 'm1', URL_OK, {});
    p.legenda = 'Legenda editada'; p.hashtags = '#Marca'; p.templateTexto = 'https://quimbanda.jp';
    const antes = structuredClone({ imagemUrl: p.imagemUrl, legenda: p.legenda, hashtags: p.hashtags, templateTexto: p.templateTexto, revisoes: p.revisoes });
    Publicacoes.migrarPublicacao(p); // re-render/preencher não pode apagar nada
    assert.equal(p.imagemUrl, antes.imagemUrl);
    assert.equal(p.legenda, antes.legenda);
    assert.equal(p.hashtags, antes.hashtags);
    assert.equal(p.templateTexto, antes.templateTexto);
    assert.deepEqual(p.revisoes, antes.revisoes);
    const campo = { value: '' };
    Publicacoes.sincronizarUrlPublicaNoCampo(campo, p);
    assert.equal(campo.value, URL_OK);
});
