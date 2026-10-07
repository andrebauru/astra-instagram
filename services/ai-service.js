'use strict';

/*
 * AIService — toda a integração com IA (OpenRouter).
 *
 * Responsabilidades: modelo, endpoint, prompt, timeout, tratamento de erro e
 * resposta. A IA prepara conteúdo; nunca publica, agenda ou altera persistência.
 * O modelo é configurável por OPENROUTER_MODEL e validado pelo catálogo real.
 */

const { erroSeguro } = require('../bridge-seguranca');
const { criarCatalogo, registrarErroAstra, erroOpenRouter } = require('../modelos-astra');
const { prepararEntrada } = require('../astra-visao');

const SYSTEM_PROMPT_BASE = `
Você é Astra, assistente de conteúdo para redes sociais.

Sua função é criar conteúdo orgânico para o Instagram.
{INSTRUCAO}

Prioridades:
- linguagem natural;
- evitar aparência de spam;
- criar legendas adequadas para Instagram;
- criar chamadas para interação;
- sugerir hashtags relevantes;
- respeitar exatamente os dados fornecidos;
- não inventar datas, horários ou endereços;
- não usar “hoje”, “amanhã”, “neste domingo” ou outras datas relativas sem informação explícita;
- não afirmar que o evento pertence a “nossa casa” ou que somos seus organizadores sem esse fato ter sido fornecido;
- não publicar endereço completo sem autorização;
- produzir conteúdo em português brasileiro.

Quando solicitado conteúdo religioso, mantenha o contexto e a tradição informados pelo usuário.

Retorne conteúdo pronto para revisão humana antes da publicação.
{ORIENTACAO}
`.trim();

function montarSystemPrompt(instrucao, orientacaoExtra = '') {
    return SYSTEM_PROMPT_BASE.replace('{INSTRUCAO}', instrucao || '').replace('{ORIENTACAO}', orientacaoExtra || '').trim();
}

function criarAIService({ ia, registrar = () => {}, contexto = () => ({}), catalogo = criarCatalogo(), fetchImpl } = {}) {
    const configuracao = ia || {};
    // Resolve o transporte a cada chamada para permitir injeção (testes) sem captura.
    const transporte = () => fetchImpl || globalThis.fetch;

    function configurada() {
        return Boolean(configuracao.chave);
    }

    async function modelos(atualizar = false) {
        return catalogo.obter(atualizar);
    }

    /** Gera conteúdo textual, opcionalmente com visão, sem tocar em publicação. */
    async function gerar({ prompt, model, imagem, orientacaoExtra = '' } = {}) {
        if (!configurada()) throw erroSeguro('ASTRA_NAO_CONFIGURADA', 'Astra não configurada no servidor.', 503);

        const modelo = await catalogo.escolher(model);
        const ctx = contexto() || {};
        const inicio = Date.now();
        registrar('AI', 'request_started', { operacao: 'chat_completion', requestId: ctx.requestId || null, operationId: ctx.operationId || null, model: modelo.id, hasImage: Boolean(imagem), result: 'salvo localmente' });

        const entrada = prepararEntrada(prompt, imagem, modelo);
        const systemPrompt = montarSystemPrompt(entrada.instrucao, orientacaoExtra);

        let resposta;
        let texto;
        try {
            resposta = await transporte()(configuracao.endpoint, {
                method: 'POST',
                signal: AbortSignal.timeout(configuracao.timeoutMs || 90000),
                headers: { Authorization: `Bearer ${configuracao.chave}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: modelo.id,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: entrada.content }
                    ],
                    ...(modelo.supportedParameters?.includes('temperature') ? { temperature: 0.8 } : {})
                })
            });
            texto = await resposta.text();
        } catch (erro) {
            const timeout = erro.name === 'TimeoutError' || erro.name === 'AbortError';
            registrarErroAstra(0, { error: { code: timeout ? 'TIMEOUT' : 'CONEXAO', message: timeout ? 'Prazo de geração esgotado.' : 'Falha de conexão com OpenRouter.' } }, modelo.id);
            throw erroSeguro(timeout ? 'ASTRA_TIMEOUT' : 'ASTRA_CONEXAO', timeout ? 'A geração excedeu o tempo de espera. Tente novamente mais tarde.' : 'Falha de conexão com o OpenRouter.', 504);
        }

        let dados;
        try { dados = JSON.parse(texto); }
        catch {
            registrarErroAstra(resposta.status, { error: { code: 'RESPOSTA_INVALIDA', message: 'Resposta não JSON; conteúdo omitido.' } }, modelo.id);
            if (!resposta.ok) throw erroOpenRouter(resposta.status);
            throw erroSeguro('ASTRA_RESPOSTA_INVALIDA', 'Astra/OpenRouter retornou uma resposta inválida.');
        }
        if (!resposta.ok || dados?.error) {
            registrarErroAstra(resposta.status, dados, modelo.id);
            throw erroOpenRouter(resposta.ok ? Number(dados.error.code) || 502 : resposta.status);
        }
        if (typeof dados?.choices?.[0]?.message?.content !== 'string' || !dados.choices[0].message.content.trim()) {
            registrarErroAstra(resposta.status, { error: { code: 'SEM_TEXTO', message: 'Resposta sem legenda textual.' } }, modelo.id);
            throw erroSeguro('ASTRA_SEM_TEXTO', 'Astra não retornou uma legenda. Tente ajustar o contexto.');
        }

        registrar('AI', 'request_success', { operacao: 'chat_completion', requestId: ctx.requestId || null, operationId: ctx.operationId || null, model: modelo.id, httpStatus: resposta.status, durationMs: Date.now() - inicio, result: 'sucesso' });
        return {
            text: dados.choices[0].message.content,
            model: typeof dados?.model === 'string' && dados.model ? dados.model : modelo.id,
            requestedModel: modelo.id,
            imagemUtilizada: entrada.imagemUtilizada,
            modelReportedByProvider: typeof dados?.model === 'string' && Boolean(dados.model),
            usage: dados?.usage || null
        };
    }

    return { configurada, modelos, gerar };
}

module.exports = { criarAIService, montarSystemPrompt, SYSTEM_PROMPT_BASE };
