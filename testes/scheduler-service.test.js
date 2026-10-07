'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const PS = require('../painel-meta-prototipo/planejamento-semanal');
const { criarMotor, criarArmazenamentoMemoria } = require('../services/scheduler-service');

const INSTANTE_10H_TOKYO = Date.parse('2026-09-28T01:00:00Z');

function midia(id, extra = {}) {
    return { id, tipo: 'imagem', status: 'disponível', nome: `${id}.jpg`, urlPublica: `https://midia.dominio-publico.com/${id}.jpg`, legenda: `legenda ${id}`, miniatura: null, ...extra };
}

function config(extra = {}) {
    return { id: 'plano-teste', semente: 'semente-fixa', inicio: '2026-09-28', fim: '2026-09-28', dias: [1], horarios: ['10:00'], porDia: 1, timezone: 'Asia/Tokyo', tipos: ['imagem', 'video', 'carrossel'], modo: 'aleatorio', atraso: 'reagendar', toleranciaMinutos: 30, ...extra };
}

function publicadorFicticio(comportamento = () => ({ id: 'publicado-1' })) {
    const chamadas = [];
    const publicador = async argumentos => { chamadas.push(argumentos); return comportamento(argumentos); };
    return { publicador, chamadas };
}

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

test('destinos são somente Instagram', () => {
    const plano = PS.planejar(config(), [midia('a')]);
    assert.deepEqual(plano.itens[0].destinos, ['Instagram']);
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
    assert.equal(chamadas[0].destino, 'Instagram');
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
    const midiaSemUrl = { id: 'sem-url', tipo: 'imagem', status: 'disponível', nome: 'x.jpg', urlPublica: '', legenda: '' };
    const plano = PS.aprovar(PS.planejar(config(), [midiaSemUrl]));
    const { publicador, chamadas } = publicadorFicticio();
    const motor = criarMotor({ armazenamento: criarArmazenamentoMemoria(), publicador, agora: () => INSTANTE_10H_TOKYO });
    motor.sincronizarPlanos([plano]);
    const resumo = await motor.executarCiclo();
    assert.equal(chamadas.length, 0);
    assert.equal(resumo.bloqueados, 1);
});
