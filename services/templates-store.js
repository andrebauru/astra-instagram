'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** Biblioteca durável de templates editoriais. */
function criarStoreTemplates(caminho) {
    function lerEstado() {
        try {
            const dados = JSON.parse(fs.readFileSync(caminho, 'utf8'));
            return { templates: Array.isArray(dados?.templates) ? dados.templates : [] };
        } catch { return { templates: [] }; }
    }

    function salvarEstado(estado) {
        fs.mkdirSync(path.dirname(caminho), { recursive: true });
        const temporario = `${caminho}.${process.pid}.tmp`;
        const fd = fs.openSync(temporario, 'w', 0o600);
        try { fs.writeFileSync(fd, JSON.stringify(estado, null, 2), 'utf8'); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
        fs.renameSync(temporario, caminho);
    }

    function listar() { return lerEstado().templates; }

    function salvar(template, { novo = false } = {}) {
        const estado = lerEstado();
        const agora = new Date().toISOString();
        const id = template.id || crypto.randomUUID();
        const indice = estado.templates.findIndex(item => item.id === id);
        if (!novo && template.id && indice < 0) return null;
        const registro = { ...template, id, criadoEm: indice >= 0 ? estado.templates[indice].criadoEm : agora, atualizadoEm: agora };
        if (indice >= 0) estado.templates[indice] = registro; else estado.templates.push(registro);
        salvarEstado(estado);
        return registro;
    }

    function migrar(templatePadrao, recorrentes) {
        const existentes = listar();
        if (existentes.length) return existentes;
        const temDados = Boolean(templatePadrao?.texto || Object.values(recorrentes || {}).some(Boolean));
        if (!temDados) return [];
        const migrado = salvar({
            id: 'template-migrado', nome: 'Template padrão migrado', texto: templatePadrao?.texto || recorrentes?.templateTexto || '',
            hashtags: recorrentes?.hashtagsPadrao || '', site: recorrentes?.site || '', maps: recorrentes?.maps || '',
            linksAdicionais: recorrentes?.linksAdicionais || '', informacoesAdicionais: recorrentes?.informacoesAdicionais || '',
            chamadasFixas: recorrentes?.chamadasFixas || '', aplicarAutomatico: templatePadrao?.aplicarAutomatico === true
        }, { novo: true });
        return migrado ? [migrado] : [];
    }

    return { listar, salvar, migrar };
}

module.exports = { criarStoreTemplates };
