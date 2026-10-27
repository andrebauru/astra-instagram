'use strict';

/** Assistente de conexão: somente estados públicos, nunca tokens de provedor. */
(function () {
    let cliente, aoConectar, aoAtualizar, ocupado = false, configurado = false;
    const el = id => document.getElementById(id);
    /** Mostra identidade, expiração e diagnóstico comprovado pela API. */
    function renderizar(conexao, erro) {
        configurado = conexao.configurado;
        for (const campo of ['META_APP_ID', 'META_APP_SECRET', 'META_LOGIN_CONFIG_ID', 'META_REDIRECT_URI', 'FACEBOOK_GRAPH_VERSION']) {
            const input = el('config-' + campo), aviso = el('erro-' + campo);
            const mensagem = conexao.errosConfiguracao?.[campo] || '';
            if (aviso) aviso.textContent = mensagem;
            input?.setAttribute?.('aria-invalid', String(Boolean(mensagem)));
            input?.setAttribute?.('aria-describedby', 'erro-' + campo);
        }
        el('meta-configuracao-pendente').textContent = configurado ? '' : conexao.errosConfiguracao ? 'Confira os campos indicados abaixo e clique em Salvar integrações. Não é necessário copiar tokens do Facebook.' : `Configuração inicial necessária: ${(conexao.pendenciasConfiguracao || ['complete os campos do aplicativo abaixo']).join(', ')}. Preencha e clique em Salvar integrações. Não é necessário copiar tokens do Facebook.`;
        const etapa = conexao.etapa || conexao.estado;
        const ordem = ['meta-etapa-conta', 'meta-etapa-autorizar', 'meta-etapa-escolher', 'meta-etapa-verificar', 'meta-etapa-finalizar'];
        const indiceAtual = !conexao.configurado ? 0 : conexao.estado === 'desconectado' ? 1 : conexao.pagina?.id ? (conexao.estado === 'conectado' ? 4 : 3) : 2;
        ordem.forEach((id, indice) => {
            const item = el(id);
            if (!item?.classList) return;
            item.classList.toggle('concluida', indice < indiceAtual || (indice === 4 && conexao.estado === 'conectado'));
            item.classList.toggle('atual', indice === indiceAtual && conexao.estado !== 'conectado');
        });
        const rotulo = { nao_configurado: 'Não configurado', pronto_para_autorizar: 'Pronto para autorizar', conectado: 'Conectado', token_expirado: 'Autorização expirada ou revogada', erro_api: 'Erro na verificação' }[etapa] || etapa.replaceAll('_', ' ');
        el('meta-estado').textContent = erro || `${rotulo} · ${conexao.mensagem}${conexao.expiraEm ? ' · token expira em ' + new Date(conexao.expiraEm).toLocaleString('pt-BR') : ''}`;
        el('meta-conectar').disabled = !conexao.configurado || ocupado;
        el('meta-conectar').textContent = conexao.estado === 'desconectado' ? 'Conectar com Facebook' : 'Reconectar com Facebook';
        const seletor = el('meta-paginas');
        seletor.replaceChildren(new Option('Selecione uma Página autorizada…', ''));
        for (const pagina of conexao.paginas) seletor.append(new Option(`${pagina.nome} · ${pagina.id}`, pagina.id));
        seletor.value = conexao.pagina?.id || '';
        el('meta-selecionar').disabled = ocupado || !seletor.value;
        el('meta-instagram').textContent = conexao.pagina?.instagramId ? `Instagram profissional vinculado: ${conexao.pagina.instagramId}. A conexão Instagram anterior foi mantida.` : 'A conta Instagram existente continua independente desta conexão Facebook.';
        el('meta-diagnostico').textContent = JSON.stringify(conexao.diagnostico || { estado: conexao.estado, observacao: 'Sem consulta de permissões nesta conexão. App Review e modo do aplicativo não verificados.' }, null, 2);
        aoConectar?.(conexao.estado === 'conectado' ? { id: conexao.pagina.id, name: conexao.pagina.nome } : undefined);
    }
    /** Atualiza o assistente e a sessão CSRF sem consulta automática à Meta. */
    async function carregar() {
        if (!cliente) return;
        try { const dados = await cliente('/meta/conexao'); renderizar(dados.conexao, dados.erroConexao); }
        catch (erro) { el('meta-estado').textContent = erro.message; }
    }
    /** Executa somente ações explícitas do usuário e impede cliques concorrentes. */
    async function executar(rota, body = {}, popup = null) {
        if (ocupado) return;
        ocupado = true;
        for (const id of ['meta-conectar', 'meta-verificar', 'meta-desconectar', 'meta-revogar', 'meta-selecionar']) el(id).disabled = true;
        try {
            const dados = await cliente(rota, body, { prazo: 120000 });
            if (dados.url) {
                const url = new URL(dados.url);
                if (url.origin !== 'https://www.facebook.com' || !/^\/v\d+\.\d+\/dialog\/oauth$/.test(url.pathname)) throw new Error('Endereço de autorização inesperado.');
                const retorno = new URL(url.searchParams.get('redirect_uri'));
                if (retorno.origin !== location.origin) throw new Error(`Para login em popup, abra o painel em ${retorno.origin}/painel/ e tente novamente.`);
                if (!popup || popup.closed) throw new Error('A janela de login foi fechada. Clique em Conectar com Facebook para tentar novamente.');
                popup.location.replace(url.href);
                el('meta-estado').textContent = 'Aguardando autorização na janela do Facebook…';
                const resultado = await aguardarRetorno(popup);
                await carregar();
                await aoAtualizar?.();
                if (resultado !== 'retorno') el('meta-estado').textContent = resultado === 'expirado' ? 'O prazo do login terminou. Inicie a conexão novamente.' : 'Janela fechada ou isolada pelo navegador. Confira o estado usando Verificar conexão e permissões; se necessário, tente novamente.';
            } else if (dados.conexao) {
                renderizar(dados.conexao);
                if (['/meta/oauth/selecionar', '/meta/oauth/desconectar'].includes(rota)) await aoAtualizar?.();
            }
        } catch (erro) { popup?.close(); el('meta-estado').textContent = erro.message; }
        finally {
            ocupado = false;
            for (const id of ['meta-conectar', 'meta-verificar', 'meta-desconectar', 'meta-revogar']) el(id).disabled = false;
            el('meta-conectar').disabled = !configurado;
            el('meta-selecionar').disabled = !el('meta-paginas').value;
        }
    }
    /** Observa apenas o retorno local; não lê páginas, senhas ou cookies do Facebook. */
    function aguardarRetorno(popup) {
        return new Promise(resolve => {
            const limite = Date.now() + 600000;
            const intervalo = setInterval(() => {
                let resultado;
                try {
                    const url = new URL(popup.location.href);
                    if (url.origin === location.origin && url.pathname === '/painel/' && url.searchParams.has('meta')) resultado = 'retorno';
                } catch { /* O navegador impede leitura enquanto o popup está na Meta. */ }
                if (!resultado && popup.closed) resultado = 'fechado';
                if (!resultado && Date.now() >= limite) resultado = 'expirado';
                if (resultado) { clearInterval(intervalo); if (!popup.closed) popup.close(); resolve(resultado); }
            }, 500);
        });
    }
    /** Abre durante o clique para evitar bloqueio de popup após a requisição assíncrona. */
    function conectar() {
        if (ocupado || !configurado) return;
        const popup = window.open('about:blank', '_blank', 'popup=yes,width=620,height=760');
        if (!popup) { el('meta-estado').textContent = 'O navegador bloqueou a janela. Permita popups para este Astra e tente novamente.'; return; }
        // O provedor não recebe acesso à janela principal; o pai observa o retorno local.
        popup.opener = null;
        return executar('/meta/oauth/iniciar', {}, popup);
    }
    /** Liga controles ao cliente local; retorno OAuth abre esta mesma área. */
    function iniciar(opcoes) {
        cliente = opcoes.cliente; aoConectar = opcoes.aoConectar; aoAtualizar = opcoes.aoAtualizar;
        el('meta-conectar').onclick = conectar;
        el('meta-verificar').onclick = () => executar('/meta/oauth/verificar');
        el('meta-paginas').onchange = () => { el('meta-selecionar').disabled = ocupado || !el('meta-paginas').value; };
        el('meta-selecionar').onclick = () => executar('/meta/oauth/selecionar', { pageId: el('meta-paginas').value });
        el('meta-desconectar').onclick = () => { if (confirm('Desconectar Facebook deste Astra? Envios pendentes para Facebook ficarão bloqueados. O Instagram existente será mantido.')) executar('/meta/oauth/desconectar'); };
        el('meta-revogar').onclick = () => { if (confirm('Revogar na Meta TODAS as permissões Facebook concedidas a este aplicativo por este usuário? Isso pode afetar outras instalações que usam a mesma autorização.')) executar('/meta/oauth/desconectar', { revogar: true }); };
        carregar();
        // Reconsulta somente o backend ao voltar do OAuth, inclusive quando o navegador isola o popup.
        window.addEventListener?.('focus', carregar);
        if (new URLSearchParams(location.search).has('meta')) {
            document.querySelector('[data-view="configuracoes"]')?.click();
            // Marcador sem credenciais permite ao painel confirmar e fechar o popup.
        }
    }
    globalThis.MetaConexao = { iniciar, carregar };
})();
