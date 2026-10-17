'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const PS = require('../painel-meta-prototipo/planejamento-semanal');
const { criarMotor, criarArmazenamentoMemoria } = require('../services/scheduler-service');

const INSTANTE_10H_TOKYO = Date.parse('2026-09-28T01:00:00Z');

function midia(id, extra = {}) {
    return { id, tipo: 'video', status: 'disponível', nome: `${id}.mp4`, urlPublica: `https://midia.dominio-publico.com/${id}.mp4`, legenda: `legenda ${id}`, miniatura: null, ...extra };
}

function config(extra = {}) {
    return { id: 'plano-teste', semente: 'semente-fixa', inicio: '2026-09-28', fim: '2026-09-28', dias: [1], horarios: ['10:00'], porDia: 1, timezone: 'Asia/Tokyo', tipos: ['imagem', 'video', 'carrossel'], modo: 'aleatorio', atraso: 'reagendar', toleranciaMinutos: 30, ...extra };
}

function publicadorFicticio(comportamento = () => ({ id: 'publicado-1' })) {
    const chamadas = [];
    const publicador = async argumentos => { chamadas.push(argumentos); return comportamento(argumentos); };
    return { publicador, chamadas };
}

test('falha ao salvar tentativa impede envio e libera trava do ciclo', async () => {
    const plano = PS.aprovar(PS.planejar(config(), [midia('a')]));
    const memoria = criarArmazenamentoMemoria();
    let falhar = false;
    const armazenamento = { carregar: memoria.carregar, salvar: e => falhar ? false : memoria.salvar(e) };
    const { publicador, chamadas } = publicadorFicticio();
    const motor = criarMotor({ armazenamento, publicador, agora: () => INSTANTE_10H_TOKYO });
    motor.sincronizarPlanos([plano]);
    falhar = true;
    await assert.rejects(motor.executarCiclo(), e => e.codigo === 'AGENDA_PERSISTENCIA');
    assert.equal(chamadas.length, 0);
    falhar = false;
    const resumo = await motor.executarCiclo();
    assert.equal(resumo.ignorado, undefined);
    assert.equal(chamadas.length, 0);
});

test('falha após confirmação interrompe próximos destinos e reinício não repete envio', async () => {
    const plano = PS.aprovar(PS.planejar(config({ destinos: ['Instagram Feed', 'Facebook Page'], facebookPageId: '123' }), [midia('a')]));
    const memoria = criarArmazenamentoMemoria();
    let falhar = false;
    const armazenamento = { carregar: memoria.carregar, salvar: e => falhar ? false : memoria.salvar(e) };
    const { publicador, chamadas } = publicadorFicticio(() => { falhar = true; return { id: 'confirmado' }; });
    const motor = criarMotor({ armazenamento, publicador, agora: () => INSTANTE_10H_TOKYO });
    motor.sincronizarPlanos([plano]);
    await assert.rejects(motor.executarCiclo(), e => e.codigo === 'AGENDA_PERSISTENCIA');
    assert.equal(chamadas.length, 1);
    assert.equal(memoria.carregar().planos[0].itens[0].resultados['Instagram Feed'].estado, 'em andamento');
    falhar = false;
    const reiniciado = criarMotor({ armazenamento, publicador, agora: () => INSTANTE_10H_TOKYO });
    await reiniciado.executarCiclo();
    assert.equal(chamadas.length, 1);
});

test('reagendar e pausa/retomada não reenviam resultado incerto', async () => {
    const plano = PS.aprovar(PS.planejar(config({ destinos: ['Facebook Page'], facebookPageId: '123' }), [midia('a')]));
    const { publicador, chamadas } = publicadorFicticio(() => { throw Object.assign(new Error('sem confirmação'), { codigo: 'PUBLICACAO_INDETERMINADA' }); });
    const motor = criarMotor({ armazenamento: criarArmazenamentoMemoria(), publicador, agora: () => INSTANTE_10H_TOKYO });
    motor.sincronizarPlanos([plano]);
    await motor.executarCiclo();
    assert.equal(motor.reagendarItem(plano.id, plano.itens[0].id), null);
    motor.pausarPlano(plano.id);
    motor.retomarPlano(plano.id);
    await motor.executarCiclo();
    assert.equal(chamadas.length, 1);
    assert.equal(motor.listarPlanos()[0].itens[0].status, 'incerto');
});

test('reinício reconcilia tentativa em andamento sem publicar novamente', async () => {
    const plano = PS.aprovar(PS.planejar(config(), [midia('a')]));
    plano.itens[0].status = 'em andamento';
    plano.itens[0].resultados = { 'Instagram Feed': { estado: 'em andamento' } };
    const { publicador, chamadas } = publicadorFicticio();
    const motor = criarMotor({ armazenamento: criarArmazenamentoMemoria({ planos: [plano] }), publicador,
        reconciliador: async () => ({ id: 'confirmado-na-consulta' }), agora: () => INSTANTE_10H_TOKYO });
    const resumo = await motor.executarCiclo();
    assert.equal(resumo.reconciliados, 1);
    assert.equal(chamadas.length, 0);
    assert.equal(motor.listarPlanos()[0].itens[0].status, 'confirmada');
});

test('pausa preserva itens cancelados, confirmados e falhos', () => {
    const plano = PS.aprovar(PS.planejar(config(), [midia('a')]));
    for (const status of ['cancelado', 'falhou', 'confirmada']) {
        plano.itens[0].status = status;
        const motor = criarMotor({ armazenamento: criarArmazenamentoMemoria({ planos: [plano] }), publicador: async () => assert.fail('Não deve publicar') });
        motor.pausarPlano(plano.id);
        motor.retomarPlano(plano.id);
        assert.equal(motor.listarPlanos()[0].itens[0].status, status);
    }
});

test('arquivo corrompido ou schema inválido bloqueia leitura sem sobrescrever', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { criarArmazenamentoArquivo } = require('../services/scheduler-service');
    const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-agenda-segura-'));
    const arquivo = path.join(pasta, 'agenda.json');
    try {
        const armazenamento = criarArmazenamentoArquivo(arquivo);
        assert.deepEqual(armazenamento.carregar(), { planos: [] });
        for (const texto of ['{', 'null', '[]', '{}', '{"planos":null}']) {
            fs.writeFileSync(arquivo, texto);
            assert.throws(() => armazenamento.carregar(), /corrompida/);
            assert.equal(fs.readFileSync(arquivo, 'utf8'), texto);
        }
    } finally { fs.rmSync(pasta, { recursive: true, force: true }); }
});

test('planejamento é determinístico, sem repetição e informa mídias faltantes', () => {
    const midias = [midia('a'), midia('b'), midia('c')];
    const primeira = PS.planejar(config(), midias);
    const segunda = PS.planejar(config(), midias);
    assert.deepEqual(primeira.itens.map(i => i.mediaId), segunda.itens.map(i => i.mediaId));
    const semana = PS.planejar(config({ inicio: '2026-09-28', fim: '2026-10-02', dias: [1, 2, 3, 4, 5] }), midias);
    assert.equal(semana.itens.length, 3);
    assert.equal(semana.faltam, 2);
    assert.equal(new Set(semana.itens.map(i => i.mediaId)).size, 3);
});

test('destino padrão é Instagram Feed', () => {
    const plano = PS.planejar(config(), [midia('a')]);
    assert.deepEqual(plano.itens[0].destinos, ['Instagram Feed']);
});

test('Facebook agenda foto única no horário Tokyo sem mudar regra Instagram', async () => {
    const foto = midia('foto', { tipo: 'imagem', urlPublica: 'https://midia.dominio-publico.com/foto.jpg' });
    const plano = PS.aprovar(PS.planejar(config({ destinos: ['Facebook Page'], facebookPageId: '123' }), [foto]));
    assert.equal(plano.itens.length, 1);
    assert.equal(plano.itens[0].facebookPageId, '123');
    const { publicador, chamadas } = publicadorFicticio();
    const motor = criarMotor({ armazenamento: criarArmazenamentoMemoria(), publicador, agora: () => INSTANTE_10H_TOKYO });
    motor.sincronizarPlanos([plano]);
    await motor.executarCiclo(); await motor.executarCiclo();
    assert.equal(chamadas.length, 1);
    assert.equal(chamadas[0].destino, 'Facebook Page');
    assert.equal(motor.listarPlanos()[0].itens[0].status, 'confirmada');
    assert.equal(PS.planejar(config(), [foto]).itens.length, 0);
});

test('alterar ID da Página invalida aprovação e bloqueia publicação na agenda', async () => {
    const plano = PS.aprovar(PS.planejar(config({ destinos: ['Facebook Page'], facebookPageId: '123' }), [midia('video')]));
    plano.itens[0].facebookPageId = '999';
    const { publicador, chamadas } = publicadorFicticio();
    const motor = criarMotor({ armazenamento: criarArmazenamentoMemoria(), publicador, agora: () => INSTANTE_10H_TOKYO });
    motor.sincronizarPlanos([plano]);
    await motor.executarCiclo();
    assert.equal(chamadas.length, 0);
    assert.equal(motor.listarPlanos()[0].itens[0].status, 'bloqueado');
});

test('Instagram e Facebook mantêm resultados independentes e tentativa persistida', async () => {
    const plano = PS.aprovar(PS.planejar(config({ destinos: ['Instagram Feed', 'Facebook Page'], facebookPageId: '123' }), [midia('video')]));
    const armazenamento = criarArmazenamentoMemoria();
    const { publicador, chamadas } = publicadorFicticio(({ destino }) => {
        const salvo = armazenamento.carregar().planos[0].itens[0];
        assert.equal(salvo.resultados[destino].estado, 'em andamento');
        if (destino === 'Facebook Page') throw Object.assign(new Error('sem confirmação'), { codigo: 'PUBLICACAO_INDETERMINADA' });
        return { id: 'ig-confirmado' };
    });
    const motor = criarMotor({ armazenamento, publicador, agora: () => INSTANTE_10H_TOKYO });
    motor.sincronizarPlanos([plano]); await motor.executarCiclo(); await motor.executarCiclo();
    assert.equal(chamadas.length, 2);
    assert.equal(motor.listarPlanos()[0].itens[0].resultados['Instagram Feed'].estado, 'confirmada');
    assert.equal(motor.listarPlanos()[0].itens[0].resultados['Facebook Page'].estado, 'incerto');
});

test('Feed e Story têm resultados independentes no agendamento', async () => {
    const plano = PS.aprovar(PS.planejar(config({ destinos: ['Instagram Feed', 'Instagram Story'] }), [midia('story')]));
    const { publicador, chamadas } = publicadorFicticio(({ destino }) => ({ id: destino === 'Instagram Story' ? 'story-1' : 'feed-1' }));
    const motor = criarMotor({ armazenamento: criarArmazenamentoMemoria(), publicador, agora: () => INSTANTE_10H_TOKYO });
    motor.sincronizarPlanos([plano]);
    await motor.executarCiclo();
    assert.deepEqual(chamadas.map(item => item.destino), ['Instagram Feed', 'Instagram Story']);
    const resultados = motor.listarPlanos()[0].itens[0].resultados;
    assert.equal(resultados['Instagram Feed'].idPublicado, 'feed-1');
    assert.equal(resultados['Instagram Story'].idPublicado, 'story-1');
});

test('elegibilidade orgânica aceita Reel e exige 3 imagens realmente distintas', () => {
    assert.equal(PS.avaliarElegibilidadeOrganica({ tipo: 'reel', url: 'https://cdn.jp/reel.mp4' }).elegivel, true, 'Reel elegível');
    assert.equal(PS.avaliarElegibilidadeOrganica({ tipo: 'imagem', url: 'https://cdn.jp/1.jpg' }).elegivel, false, '1 imagem bloqueada');
    assert.equal(PS.avaliarElegibilidadeOrganica({ tipo: 'carrossel', itens: [{ tipo: 'imagem', url: 'https://cdn.jp/1.jpg' }, { tipo: 'imagem', url: 'https://cdn.jp/2.jpg' }] }).elegivel, false, '2 imagens bloqueadas');
    assert.equal(PS.avaliarElegibilidadeOrganica({ tipo: 'carrossel', itens: [{ tipo: 'imagem', url: 'https://cdn.jp/1.jpg' }, { tipo: 'imagem', url: 'https://cdn.jp/2.jpg' }, { tipo: 'imagem', url: 'https://cdn.jp/3.jpg' }] }).elegivel, true, '3 imagens distintas elegíveis');
    const repetida = PS.avaliarElegibilidadeOrganica({ tipo: 'carrossel', itens: [{ tipo: 'imagem', url: 'https://cdn.jp/1.jpg' }, { tipo: 'imagem', url: 'https://cdn.jp/1.jpg' }, { tipo: 'imagem', url: 'https://cdn.jp/2.jpg' }] });
    assert.equal(repetida.elegivel, false, '3 itens com repetição bloqueados');
    assert.match(repetida.motivo, /repetidas|duplicidade/i);
});

test('planejamento devolve justificativa visível para mídia orgânica bloqueada', () => {
    const plano = PS.planejar(config(), [{ id: 'imagem-unica', tipo: 'imagem', status: 'disponível', urlPublica: 'https://cdn.jp/1.jpg' }]);
    assert.equal(plano.itens.length, 0);
    assert.match(plano.erros.join(' '), /mínimo 3 imagens distintas/i);
    assert.equal(plano.inelegiveis.length, 1);
});

test('editar item invalida a aprovação apenas do item alterado', () => {
    const plano = PS.aprovar(PS.planejar(config(), [midia('a')]));
    assert.ok(plano.itens[0].approvalSignature);
    const editado = PS.editarItem(plano, plano.itens[0].id, { hora: '11:00' });
    assert.equal(editado.itens[0].approvalSignature, null);
    assert.equal(editado.itens[0].status, 'rascunho');
});

test('carrossel preserva a ordem e exige o mínimo configurado', () => {
    const carrossel = PS.criarCarrossel([midia('a'), midia('b'), midia('c')], {});
    assert.deepEqual(carrossel.itens.map(i => i.ordem), [0, 1, 2]);
    assert.throws(() => PS.criarCarrossel([midia('a')], {}), /ao menos 2/);
});

test('rascunho não executa; aprovado publica no horário', async () => {
    const rascunho = PS.planejar(config(), [midia('a')]);
    const { publicador, chamadas } = publicadorFicticio();
    const motor = criarMotor({ armazenamento: criarArmazenamentoMemoria(), publicador, agora: () => INSTANTE_10H_TOKYO });
    motor.sincronizarPlanos([rascunho]);
    await motor.executarCiclo();
    assert.equal(chamadas.length, 0);

    motor.sincronizarPlanos([PS.aprovar(rascunho)]);
    const resumo = await motor.executarCiclo();
    assert.equal(chamadas.length, 1);
    assert.equal(resumo.confirmados, 1);
    assert.equal(chamadas[0].destino, 'Instagram Feed');
});

test('reinício retoma o estado e não republica itens confirmados', async () => {
    const plano = PS.aprovar(PS.planejar(config(), [midia('a')]));
    const armazenamento = criarArmazenamentoMemoria();
    const primeiro = publicadorFicticio();
    const motor1 = criarMotor({ armazenamento, publicador: primeiro.publicador, agora: () => INSTANTE_10H_TOKYO });
    motor1.sincronizarPlanos([plano]);
    await motor1.executarCiclo();
    assert.equal(primeiro.chamadas.length, 1);

    const segundo = publicadorFicticio();
    const motor2 = criarMotor({ armazenamento, publicador: segundo.publicador, agora: () => INSTANTE_10H_TOKYO + 60000 });
    motor2.sincronizarPlanos(motor2.listarPlanos());
    const resumo = await motor2.executarCiclo();
    assert.equal(segundo.chamadas.length, 0);
    assert.equal(resumo.confirmados, 0);
});

test('resultado incerto é reconciliado antes de qualquer reenvio', async () => {
    const plano = PS.aprovar(PS.planejar(config(), [midia('a')]));
    let reconciliacoes = 0;
    const { publicador, chamadas } = publicadorFicticio(() => { throw Object.assign(new Error('conexão'), { codigo: 'META_CONEXAO' }); });
    const motor = criarMotor({
        armazenamento: criarArmazenamentoMemoria(), publicador,
        reconciliador: async () => { reconciliacoes++; return { id: 'confirmado-por-reconciliacao' }; },
        agora: () => INSTANTE_10H_TOKYO
    });
    motor.sincronizarPlanos([plano]);
    const primeiro = await motor.executarCiclo();
    assert.equal(primeiro.incertos, 1);
    assert.equal(chamadas.length, 1);
    const segundo = await motor.executarCiclo();
    assert.equal(segundo.reconciliados, 1);
    assert.equal(chamadas.length, 1);
    assert.equal(reconciliacoes, 1);
});

test('política de atraso reagenda além da tolerância e publica quando autorizado', async () => {
    const plano = PS.aprovar(PS.planejar(config({ atraso: 'reagendar', toleranciaMinutos: 30 }), [midia('a')]));
    const { publicador, chamadas } = publicadorFicticio();
    const motor = criarMotor({ armazenamento: criarArmazenamentoMemoria(), publicador, agora: () => INSTANTE_10H_TOKYO + 2 * 3600000 });
    motor.sincronizarPlanos([plano]);
    const resumo = await motor.executarCiclo();
    assert.equal(resumo.reagendados, 1);
    assert.equal(chamadas.length, 0);
    assert.equal(motor.listarPlanos()[0].itens[0].status, 'reagendado');
});

test('pausa impede novas execuções; retomar reabilita aprovados', async () => {
    const plano = PS.aprovar(PS.planejar(config(), [midia('a')]));
    const { publicador, chamadas } = publicadorFicticio();
    const motor = criarMotor({ armazenamento: criarArmazenamentoMemoria(), publicador, agora: () => INSTANTE_10H_TOKYO });
    motor.sincronizarPlanos([plano]);
    motor.pausarPlano(plano.id);
    await motor.executarCiclo();
    assert.equal(chamadas.length, 0);
    motor.retomarPlano(plano.id);
    await motor.executarCiclo();
    assert.equal(chamadas.length, 1);
});

test('item falho só reexecuta após reagendar manual', async () => {
    const plano = PS.aprovar(PS.planejar(config(), [midia('a')]));
    let falhar = true;
    const { publicador, chamadas } = publicadorFicticio(() => { if (falhar) throw Object.assign(new Error('recusado'), { codigo: 'META_RECUSOU' }); return { id: 'ok' }; });
    const motor = criarMotor({ armazenamento: criarArmazenamentoMemoria(), publicador, agora: () => INSTANTE_10H_TOKYO });
    motor.sincronizarPlanos([plano]);
    await motor.executarCiclo();
    assert.equal(chamadas.length, 1);
    await motor.executarCiclo();
    assert.equal(chamadas.length, 1);
    falhar = false;
    motor.reagendarItem(plano.id, plano.itens[0].id);
    await motor.executarCiclo();
    assert.equal(chamadas.length, 2);
});

test('cancelar item não afeta itens confirmados', async () => {
    const plano = PS.aprovar(PS.planejar(config(), [midia('a'), midia('b')]));
    const { publicador } = publicadorFicticio();
    const motor = criarMotor({ armazenamento: criarArmazenamentoMemoria(), publicador, agora: () => INSTANTE_10H_TOKYO });
    motor.sincronizarPlanos([plano]);
    const cancelado = motor.cancelarItem(plano.id, plano.itens[0].id);
    assert.equal(cancelado.itens[0].status, 'cancelado');
});

test('item aprovado sem URL pública é bloqueado, não publicado', async () => {
    const midiaSemUrl = { id: 'sem-url', tipo: 'video', status: 'disponível', nome: 'x.mp4', urlPublica: '', legenda: '' };
    const plano = PS.aprovar(PS.planejar(config(), [midiaSemUrl]));
    const { publicador, chamadas } = publicadorFicticio();
    const motor = criarMotor({ armazenamento: criarArmazenamentoMemoria(), publicador, agora: () => INSTANTE_10H_TOKYO });
    motor.sincronizarPlanos([plano]);
    const resumo = await motor.executarCiclo();
    assert.equal(chamadas.length, 0);
    assert.equal(resumo.bloqueados, 1);
});
