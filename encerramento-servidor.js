'use strict';

/** Instala encerramento gracioso para liberar a porta ao pressionar Ctrl+C. */
function instalarEncerramento(servidor, nome) {
    const conexoes = new Set();
    let encerrando = false;

    servidor.on('connection', conexao => {
        conexoes.add(conexao);
        conexao.on('close', () => conexoes.delete(conexao));
    });

    const encerrar = sinal => {
        if (encerrando) return;
        encerrando = true;
        console.log(`\n${nome}: encerrando (${sinal})...`);

        servidor.close(() => {
            console.log(`${nome}: porta liberada.`);
            process.exit(0);
        });

        // Conexões keep-alive podem impedir o callback do close; descarte-as.
        for (const conexao of conexoes) conexao.destroy();

        // Garante a saída mesmo se um cliente não responder ao encerramento.
        setTimeout(() => process.exit(0), 3000).unref();
    };

    process.once('SIGINT', () => encerrar('Ctrl+C'));
    process.once('SIGTERM', () => encerrar('SIGTERM'));
}

module.exports = { instalarEncerramento };
