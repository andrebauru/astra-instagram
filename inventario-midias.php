<?php
declare(strict_types=1);

// Endpoint opcional: liste somente a pasta pública de mídias após configurar no servidor.
header('Content-Type: application/json; charset=utf-8');
$chaveEsperada = getenv('ASTRA_MEDIA_KEY') ?: '';
$chaveRecebida = $_SERVER['HTTP_X_ASTRA_KEY'] ?? '';
if ($chaveEsperada === '' || !hash_equals($chaveEsperada, $chaveRecebida)) {
    http_response_code(401); echo json_encode(['error' => 'Não autorizado']); exit;
}

$diretorio = realpath(getenv('ASTRA_MEDIA_DIR') ?: (__DIR__ . '/media/public'));
$base = rtrim(getenv('ASTRA_MEDIA_PUBLIC_BASE') ?: 'https://quimbanda.jp/astra/media/public/', '/') . '/';
if ($diretorio === false || !is_dir($diretorio)) {
    http_response_code(503); echo json_encode(['error' => 'Diretório indisponível']); exit;
}

$limite = max(1, min(100, (int)($_GET['limit'] ?? 100)));
$cursor = max(0, (int)($_GET['cursor'] ?? 0));
$permitidas = ['jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'png' => 'image/png', 'webp' => 'image/webp', 'mp4' => 'video/mp4'];
$arquivos = [];
foreach (new DirectoryIterator($diretorio) as $arquivo) {
    if (!$arquivo->isFile() || !isset($permitidas[strtolower($arquivo->getExtension())])) continue;
    $arquivos[] = $arquivo->getFilename();
}
sort($arquivos, SORT_NATURAL | SORT_FLAG_CASE);
$pagina = array_slice($arquivos, $cursor, $limite);
$items = array_map(function (string $nome) use ($diretorio, $base, $permitidas): array {
    $caminho = $diretorio . DIRECTORY_SEPARATOR . $nome;
    return ['filename' => $nome, 'name' => $nome, 'url' => $base . rawurlencode($nome), 'mime' => $permitidas[strtolower(pathinfo($nome, PATHINFO_EXTENSION))], 'bytes' => filesize($caminho), 'modified_at' => gmdate(DATE_ATOM, filemtime($caminho))];
}, $pagina);
$proximo = $cursor + count($pagina);
echo json_encode(['items' => $items, 'next_cursor' => $proximo < count($arquivos) ? (string)$proximo : null], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
