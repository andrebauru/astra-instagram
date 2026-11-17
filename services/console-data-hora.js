'use strict';

const INSTALADO = Symbol.for('astra.consoleDataHora.instalado');

/** Formata o instante no fuso operacional exibido pelo Astra. */
function formatarDataHora(data = new Date(), timezone = 'Asia/Tokyo') {
    const partes = new Intl.DateTimeFormat('pt-BR', {
        timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).formatToParts(data);
    const valor = tipo => partes.find(parte => parte.type === tipo)?.value || '';
    return `${valor('day')}/${valor('month')}/${valor('year')} ${valor('hour')}:${valor('minute')}:${valor('second')}`;
}

/** Prefixa mensagens do terminal com data, hora e fuso sem alterar seus argumentos. */
function instalarDataHoraConsole({ timezone = 'Asia/Tokyo', agora = () => new Date() } = {}) {
    if (console[INSTALADO]) return false;
    for (const metodo of ['log', 'info', 'warn', 'error']) {
        const original = console[metodo].bind(console);
        console[metodo] = (...argumentos) => {
            if (argumentos.length === 1 && argumentos[0] === '') return original('');
            return original(`[${formatarDataHora(agora(), timezone)} ${timezone}]`, ...argumentos);
        };
    }
    Object.defineProperty(console, INSTALADO, { value: true, configurable: false });
    return true;
}

module.exports = { formatarDataHora, instalarDataHoraConsole };
