# Upload público de mídias do Astra

Este arquivo contém uma versão completa do `upload.php` para o servidor online. O contrato permanece compatível com o Astra:

- requisição `POST multipart/form-data`;
- campo do arquivo: `arquivo`;
- autenticação: `X-Astra-Key`;
- resposta de sucesso HTTP `200` com `ok`, `arquivo` e `url`;
- formatos do script atual: JPEG, PNG, WebP, MP4, MP3 e WAV;
- limite padrão: 256 MB por arquivo, incluindo vídeos `.mp4`;
- imagens e vídeos são salvos na mesma pasta `media/public`.

Requisitos: PHP 8.1 ou superior, extensão `fileinfo` e permissão de escrita na pasta `media/public`.

> O limite antigo de 5 MB normalmente é escrito como `5 * 1024 * 1024`. Alterar somente essa constante não é suficiente: o PHP também aplica `upload_max_filesize` e `post_max_size` antes de executar o script.

## `upload.php` pronto para enviar

Use o arquivo [upload.php](upload.php) da raiz do projeto. Ele contém um verificador SHA-256 gerado a partir da chave do `.env` local. A chave original não fica gravada no PHP.

O Astra envia `X-Astra-Key`; o PHP compara o SHA-256 do header com o verificador incorporado. Não é necessário configurar `MEDIA_UPLOAD_KEY` no ambiente da hospedagem. Se a chave local mudar, o verificador do PHP deve ser atualizado antes de reenviar o arquivo.

Substitua o `upload.php` no endereço indicado por `MEDIA_UPLOAD_URL`. Reiniciar o backend local não atualiza esse arquivo remoto. O arquivo local atual mantém imagens e vídeos em `media/public`, limite de 256 MB e tempo de execução de 600 segundos.

## Limites do PHP

Crie um `.user.ini` na mesma pasta do `upload.php`, caso a hospedagem permita:

```ini
upload_max_filesize = 256M
post_max_size = 270M
max_execution_time = 600
max_input_time = 600
memory_limit = 512M
```

O tempo configurado é de 600 segundos (10 minutos). O limite do POST inclui uma margem para o formulário multipart. O limite do script atual é definido por MAX_SIZE no upload.php.

Após alterar `.user.ini`, algumas hospedagens levam alguns minutos para recarregar a configuração. Se o servidor usar Nginx, o administrador também precisa configurar `client_max_body_size 270M;` e ajustar os tempos de espera do servidor/proxy e do PHP-FPM para comportar uploads demorados. O cliente que envia o arquivo também precisa permitir uma espera de pelo menos 600 segundos; alterar apenas o PHP não amplia o timeout do cliente.

## Proteção da pasta pública

Se o servidor for Apache, crie `media/public/.htaccess`:

```apacheconf
Options -ExecCGI
RemoveHandler .php .phtml .phar
RemoveType .php .phtml .phar

<FilesMatch "\.(php|phtml|phar|cgi|pl|py|sh)$">
    Require all denied
</FilesMatch>

<IfModule mod_headers.c>
    Header set X-Content-Type-Options "nosniff"
    Header set Content-Security-Policy "default-src 'none'; style-src 'unsafe-inline'; sandbox"
</IfModule>
```

## Compatibilidade com o Astra

O upload.php atual não aceita SVG. O fluxo de publicações do Astra aceita JPEG, PNG, WebP e MP4; a aceitação de áudio pelo PHP não adiciona publicação de áudio ao painel.

## Teste sem publicar na Meta

```bash
curl -i --connect-timeout 30 --max-time 600 -X POST "https://seu-dominio.example/Astra/upload.php" \
  -H "X-Astra-Key: SUA_CHAVE" \
  -F "arquivo=@video.mp4"
```

Resposta esperada:

```json
{
  "ok": true,
  "arquivo": "hash-aleatorio.mp4",
  "url": "https://seu-dominio.example/Astra/media/public/hash-aleatorio.mp4"
}
```

Esse teste verifica apenas o upload remoto e não publica conteúdo no Instagram.
