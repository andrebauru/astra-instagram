# Seleção de modelos da Astra

Na etapa **IA** do editor, escolha o **Modelo da Astra** e use **Gerar com
Astra** ou **Reescrever com Astra**. **Atualizar modelos** consulta novamente o
catálogo. A legenda permanece editável e o resultado identifica o modelo
informado pelo provedor. Nada é publicado automaticamente.

A integração fica isolada no AIService (`services/ai-service.js`). O modelo é
centralizado em `services/config.js` (`OPENROUTER_MODEL`, padrão
`z-ai/glm-5.3-flash`) e nunca é espalhado por vários arquivos.

## Catálogo e seleção

`GET /astra/models` consulta o catálogo real do OpenRouter, com timeout de 15
segundos e cache em memória de 20 minutos. `?refresh=1` força atualização;
consultas simultâneas compartilham a mesma requisição. Falhas não transformam
cache vencido em catálogo válido.

A lista contém até 21 IDs realmente retornados, com diversidade entre famílias
(Gemini, GPT, Claude, DeepSeek, Qwen, Mistral, Llama) quando disponíveis. Exclui
batch, embeddings, tarefas incompatíveis, modelos vencidos e IDs inválidos. Exige
entrada textual e saída exclusivamente textual. Prioriza modelos gerais, entrada
visual e data de criação; não presume qualidade a partir do nome.

- **Econômico:** preços informados de entrada até US$ 0,50 e saída até US$ 2 por
  milhão de tokens.
- **Maior capacidade:** demais modelos com contexto de pelo menos 200 mil tokens.
- **Equilibrado:** demais modelos compatíveis.
- **👁 Visão:** atributo adicional quando o catálogo informa entrada de imagens.

Família, contexto e preços vêm dos metadados do catálogo. Preço ausente aparece
como não informado; zero não é confundido com ausência. Campos seguem a
[documentação oficial do catálogo](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties).

## Geração e persistência

`POST /astra/generate` recebe `{ "prompt": "...", "model": "ID selecionado" }`.
O backend aceita apenas IDs presentes na seleção válida e usa a rota fixa de
chat.

Quando `model` é omitido, o modelo configurado (`OPENROUTER_MODEL`, ou
`ASTRA_MODEL` como compatibilidade) é usado somente se compatível com o catálogo;
caso contrário escolhe-se uma opção compatível. Uma escolha explícita inválida é
recusada. Não há troca silenciosa de modelo após erro do provedor.

A preferência é apenas uma string com o ID, salva no IndexedDB existente. O
catálogo fica em memória; chaves e tokens permanecem exclusivamente no backend.
O `.env` não é alterado.

Erros de autorização, saldo, modelo indisponível, limite, timeout e falha
temporária têm mensagens próprias. Diagnósticos registram status, código,
mensagem sanitizada e modelo solicitado; não registram prompts nem respostas
brutas.
