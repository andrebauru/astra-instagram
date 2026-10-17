'use strict';
const { erroSeguro } = require('../bridge-seguranca');
const { urlPublica } = require('../painel-meta-prototipo/integracao-regras');
const { createHash } = require('node:crypto');

/** Publica na Página com token próprio e impede repetição de envios incertos. */
function criarFacebookService({ pageId, token, versao = '', store, fetchImpl } = {}) {
    const base = `https://graph.facebook.com${versao ? '/' + versao : ''}`;
    /** Mantém autenticação fora da URL e não expõe respostas externas. */
    async function request(caminho, parametros) {
        if (!pageId || !token) throw erroSeguro('FACEBOOK_NAO_CONFIGURADO', 'Configure o ID e o token de acesso da Página do Facebook.', 503);
        let resposta, dados;
        try {
            resposta = await (fetchImpl || globalThis.fetch)(`${base}/${caminho}`, {
                method: parametros ? 'POST' : 'GET',
                headers: { Authorization: `Bearer ${token}`, ...(parametros ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
                ...(parametros ? { body: new URLSearchParams(parametros).toString() } : {}),
                signal: AbortSignal.timeout(120000)
            });
            dados = await resposta.json();
        } catch { throw erroSeguro('PUBLICACAO_INDETERMINADA', 'Sem confirmação do Facebook. Confira a Página antes de repetir o envio.'); }
        if (!resposta.ok || dados.error) {
            const erro = erroSeguro('FACEBOOK_RECUSADO', 'O Facebook recusou a operação. Verifique o token da Página, permissões e formato da mídia.');
            erro.rejeitado = resposta.status < 500;
            throw erro;
        }
        return dados;
    }
    /** Valida todas as mídias antes de iniciar qualquer escrita na Meta. */
    function validar(entrada) {
        if (!pageId || !token) throw erroSeguro('FACEBOOK_NAO_CONFIGURADO', 'Configure o ID e o token de acesso da Página do Facebook.', 503);
        const urls = entrada.formato === 'carrossel' ? (entrada.itens || []).map(item => item.url) : [entrada.videoUrl || entrada.imageUrl || entrada.mediaUrl];
        if (entrada.formato === 'story' || !urls.length || !urls.every(urlPublica)) throw erroSeguro('FACEBOOK_MIDIA_INVALIDA', 'Informe mídias HTTPS públicas para a publicação na Página.', 400);
        if (entrada.formato === 'carrossel' && (urls.length < 2 || urls.length > 10 || entrada.itens.some(item => item.tipo === 'video'))) throw erroSeguro('FACEBOOK_MIDIA_INVALIDA', 'A publicação com várias fotos no Facebook exige de 2 a 10 imagens, sem vídeos.', 400);
    }
    /** Consulta somente a identidade da Página configurada. */
    async function perfil() { const dados = await request(`${pageId}?fields=id,name`); return { id: dados.id, name: dados.name }; }
    /** Persiste IDs de fotos preparadas e resultado final para retries seguros. */
    async function publish(entrada, publicacaoId) {
        validar(entrada);
        if (!publicacaoId || !store) throw erroSeguro('IDENTIFICADOR_INVALIDO', 'Salve a publicação antes de enviar ao Facebook.', 400);
        const chave = `${publicacaoId}:facebook`;
        const assinatura = createHash('sha256').update(JSON.stringify({ pageId, entrada })).digest('hex');
        let estado = store.obter(chave) || {};
        if (estado.assinatura && estado.assinatura !== assinatura) throw erroSeguro('PUBLICACAO_DIVERGENTE', 'O conteúdo ou a Página mudou. Crie uma nova publicação.', 409);
        if (estado.mediaId) return estado;
        if (estado.incerto) throw erroSeguro('PUBLICACAO_INDETERMINADA', 'Envio anterior sem confirmação. Confira a Página antes de repetir.', 409);
        estado = { ...estado, assinatura, fotos: estado.fotos || [] };
        /** Registra a incerteza antes de cada operação externa irreversível. */
        async function enviar(caminho, parametros) {
            estado.incerto = true; store.salvar(chave, estado);
            try {
                const dados = await request(caminho, parametros);
                if (!dados.id && !dados.post_id) throw erroSeguro('PUBLICACAO_INDETERMINADA', 'Facebook não retornou um identificador de publicação.');
                estado.incerto = false;
                return dados;
            } catch (erro) {
                if (erro.rejeitado) { estado.incerto = false; store.salvar(chave, estado); }
                throw erro;
            }
        }
        let dados;
        if (entrada.formato === 'carrossel') {
            for (let i = estado.fotos.length; i < entrada.itens.length; i++) {
                const foto = await enviar(`${pageId}/photos`, { url: entrada.itens[i].url, published: 'false' });
                estado.fotos.push(foto.id); store.salvar(chave, estado);
            }
            dados = await enviar(`${pageId}/feed`, { message: entrada.caption || '', attached_media: JSON.stringify(estado.fotos.map(id => ({ media_fbid: id }))) });
        } else if (entrada.formato === 'reel') {
            dados = await enviar(`${pageId}/videos`, { file_url: entrada.videoUrl || entrada.mediaUrl, description: entrada.caption || '' });
        } else {
            dados = await enviar(`${pageId}/photos`, { url: entrada.imageUrl || entrada.mediaUrl, caption: entrada.caption || '', published: 'true' });
        }
        estado = { ...estado, mediaId: dados.post_id || dados.id, formato: entrada.formato, publicadoEm: new Date().toISOString(), incerto: false };
        store.salvar(chave, estado);
        return estado;
    }
    /** Stories são destinos próprios; carrossel não é convertido silenciosamente. */
    function validarStory(entrada) {
        if (!pageId || !token) throw erroSeguro('FACEBOOK_NAO_CONFIGURADO', 'Conecte a Página do Facebook.', 403);
        if (!['imagem', 'reel'].includes(entrada.formato) || !urlPublica(entrada.videoUrl || entrada.imageUrl || entrada.mediaUrl)) throw erroSeguro('FACEBOOK_MIDIA_INVALIDA', 'Story Facebook exige uma única imagem ou vídeo HTTPS público.', 400);
    }
    /** Persiste cada etapa, isola o Story do Feed e não repete operação sem confirmação. */
    async function publicarStory(entrada, publicacaoId) {
        validarStory(entrada);
        if (!publicacaoId || !store) throw erroSeguro('IDENTIFICADOR_INVALIDO', 'Salve a publicação antes de enviar.', 400);
        const chave = `${publicacaoId}:facebook-story`;
        const assinatura = createHash('sha256').update(JSON.stringify({ pageId, formato: entrada.formato, url: entrada.videoUrl || entrada.imageUrl || entrada.mediaUrl })).digest('hex');
        let estado = store.obter(chave) || {};
        if (estado.assinatura && estado.assinatura !== assinatura) throw erroSeguro('PUBLICACAO_DIVERGENTE', 'O Story mudou; crie uma nova publicação.', 409);
        if (estado.mediaId) return estado;
        if (estado.incerto) throw erroSeguro('PUBLICACAO_INDETERMINADA', 'Story Facebook sem confirmação anterior. Confira a Página antes de reenviar.', 409);
        estado.assinatura = assinatura;
        /** Só libera a próxima etapa depois de validar a resposta da operação anterior. */
        async function etapa(operacao, validarResposta, aplicar) {
            estado.incerto = true; store.salvar(chave, estado);
            try {
                const dados = await operacao();
                if (!validarResposta(dados)) throw erroSeguro('PUBLICACAO_INDETERMINADA', 'Facebook não confirmou a etapa do Story.');
                aplicar(dados); estado.incerto = false; store.salvar(chave, estado); return dados;
            } catch (erro) { if (erro.rejeitado) { estado.incerto = false; store.salvar(chave, estado); } throw erro; }
        }
        if (entrada.formato === 'imagem') {
            if (!estado.photoId) await etapa(() => request(`${pageId}/photos`, { url: entrada.imageUrl || entrada.mediaUrl, published: 'false' }), d => Boolean(d.id), d => { estado.photoId = d.id; });
            await etapa(() => request(`${pageId}/photo_stories`, { photo_id: estado.photoId }), d => d.success === true && Boolean(d.post_id || d.id), d => { estado.mediaId = d.post_id || d.id; });
        } else {
            if (!estado.videoId) await etapa(() => request(`${pageId}/video_stories`, { upload_phase: 'START' }), d => Boolean(d.video_id && d.upload_url), d => { estado.videoId = d.video_id; estado.uploadUrl = d.upload_url; });
            if (!estado.uploadConcluido) {
                const url = new URL(estado.uploadUrl);
                if (url.protocol !== 'https:' || url.hostname !== 'rupload.facebook.com' || url.port || url.username || url.password) throw erroSeguro('FACEBOOK_RECUSADO', 'Endereço de upload Facebook inesperado.', 502);
                await etapa(async () => {
                    const resposta = await (fetchImpl || globalThis.fetch)(url.href, { method: 'POST', redirect: 'error', headers: { Authorization: `OAuth ${token}`, file_url: entrada.videoUrl || entrada.mediaUrl }, signal: AbortSignal.timeout(120000) });
                    if (!resposta.ok) throw erroSeguro('PUBLICACAO_INDETERMINADA', 'Upload do Story Facebook não confirmado.');
                    return resposta.json();
                }, d => d.success === true, () => { estado.uploadConcluido = true; });
            }
            await etapa(() => request(`${pageId}/video_stories`, { upload_phase: 'FINISH', video_id: estado.videoId, video_state: 'PUBLISHED' }), d => d.success === true, d => { estado.mediaId = d.post_id || estado.videoId; });
        }
        estado.publicadoEm = new Date().toISOString(); store.salvar(chave, estado);
        return { mediaId: estado.mediaId, publicadoEm: estado.publicadoEm };
    }
    return { perfil, validar, publish, validarStory, publicarStory };
}
module.exports = { criarFacebookService };
