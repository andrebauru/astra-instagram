'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { instalarEncerramento } = require('../encerramento-servidor');

// Lista explícita dos arquivos públicos do painel. Nenhum backend aqui.
const arquivos = {
    '/': ['index.html', 'text/html'],
    '/index.html': ['index.html', 'text/html'],
    '/estilo.css': ['estilo.css', 'text/css'],
    '/regras.js': ['regras.js', 'text/javascript'],
    '/empresa.js': ['empresa.js', 'text/javascript'],
    '/publicacoes.js': ['publicacoes.js', 'text/javascript'],
    '/planejamento-semanal.js': ['planejamento-semanal.js', 'text/javascript'],
    '/diagnostico.js': ['diagnostico.js', 'text/javascript'],
    '/integracao-regras.js': ['integracao-regras.js', 'text/javascript'],
    '/painel.js': ['painel.js', 'text/javascript'],
    '/agendamentos.js': ['agendamentos.js', 'text/javascript']
};

/** Serve somente a lista de arquivos públicos, sem acessar o bridge ou credenciais. */
function servirPainel(req, res, rota = req.url.split('?')[0]) {
    const arquivo = Object.hasOwn(arquivos, rota) ? arquivos[rota] : undefined;
    if (!['GET', 'HEAD'].includes(req.method) || !arquivo) { res.writeHead(404); res.end('Não encontrado'); return; }
    fs.readFile(path.join(__dirname, arquivo[0]), (erro, dados) => {
        if (erro) { res.writeHead(500); res.end('Arquivo indisponível'); return; }
        res.writeHead(200, {
            'Content-Type': `${arquivo[1]}; charset=utf-8`,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self' http://127.0.0.1:8080 http://localhost:8080; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
        });
        res.end(req.method === 'HEAD' ? undefined : dados);
    });
}

function criarServidor() { return http.createServer(servirPainel); }

if (require.main === module) {
    const servidor = criarServidor();
    instalarEncerramento(servidor, 'Painel local');
    servidor.on('error', erro => { console.error(`Não foi possível iniciar: ${erro.message}`); process.exitCode = 1; });
    servidor.listen(Number(process.env.PAINEL_PORT || 4317), '127.0.0.1', () => console.log(`Painel local: http://127.0.0.1:${servidor.address().port}`));
}

module.exports = { criarServidor, servirPainel };
