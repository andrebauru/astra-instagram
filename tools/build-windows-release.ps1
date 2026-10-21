param(
    [string]$Versao = '1.1.0',
    [string]$Destino = ''
)

$ErrorActionPreference = 'Stop'
$raiz = Split-Path -Parent $PSScriptRoot
$package = Get-Content (Join-Path $raiz 'package.json') -Raw | ConvertFrom-Json
if ($package.version -ne $Versao) { throw "A versão solicitada ($Versao) difere do package.json ($($package.version))." }

$nodeComando = Get-Command node -ErrorAction Stop
$nodeOrigem = $nodeComando.Source
$arquitetura = (& $nodeOrigem -p "process.arch").Trim()
if ($arquitetura -ne 'x64') { throw "O pacote Windows x64 requer Node x64; arquitetura encontrada: $arquitetura." }
$versaoNode = (& $nodeOrigem -p "process.versions.node").Trim()
$majorNode = [int]$versaoNode.Split('.')[0]
if ($majorNode -lt 24) { throw "Node.js 24 ou posterior é necessário; versão encontrada: $versaoNode." }

if (-not $Destino) { $Destino = Join-Path $raiz 'release-artifacts' }
$Destino = [System.IO.Path]::GetFullPath($Destino)
$staging = Join-Path $Destino "astra-instagram-v$Versao-windows-x64"
$zip = Join-Path $Destino "astra-instagram-v$Versao-windows-x64.zip"
New-Item -ItemType Directory -Force -Path $Destino | Out-Null
if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
New-Item -ItemType Directory -Force -Path $staging | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $staging 'runtime') | Out-Null

$arquivosRaiz = @(
    '.env.example', 'package.json', 'iniciar.js', 'server.js', 'bridge-seguranca.js',
    'encerramento-servidor.js', 'diagnostico.js', 'midia-publica.js',
    'modelos-astra.js', 'astra-visao.js', 'rede-publica.js'
)
foreach ($arquivo in $arquivosRaiz) {
    Copy-Item -LiteralPath (Join-Path $raiz $arquivo) -Destination $staging
}

foreach ($diretorio in @('services', 'painel-meta-prototipo')) {
    $origem = Join-Path $raiz $diretorio
    $alvo = Join-Path $staging $diretorio
    New-Item -ItemType Directory -Force -Path $alvo | Out-Null
    Get-ChildItem -LiteralPath $origem -File -Recurse | Where-Object {
        $_.Extension -in @('.js', '.html', '.css') -and $_.Name -notmatch '\.test\.js$'
    } | ForEach-Object {
        $prefixoOrigem = $origem.TrimEnd('\') + '\'
        $relativo = $_.FullName.Substring($prefixoOrigem.Length)
        $destinoArquivo = Join-Path $alvo $relativo
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destinoArquivo) | Out-Null
        Copy-Item -LiteralPath $_.FullName -Destination $destinoArquivo
    }
}

Copy-Item -LiteralPath $nodeOrigem -Destination (Join-Path $staging 'runtime\node.exe')
$fonteLauncher = Join-Path $PSScriptRoot 'AstraLauncher.cs'
$executavel = Join-Path $staging 'Astra.exe'
Add-Type -TypeDefinition (Get-Content -LiteralPath $fonteLauncher -Raw) -OutputAssembly $executavel -OutputType ConsoleApplication

$readme = @"
# Astra Instagram v$Versao para Windows

1. Extraia toda a pasta do pacote.
2. Execute `Astra.exe`.
3. Na primeira execução, o Astra cria `.env` ao lado do executável a partir de `.env.example`.
4. Preencha as credenciais somente no `.env` local e reinicie o Astra.

O `.env` existente nunca é substituído. Não compartilhe esse arquivo. O pacote contém o runtime Node.js $versaoNode x64 e não exige uma instalação de Node no computador.

O servidor local usa `http://localhost:8080/painel/`. Para fechar, encerre a janela do Astra.
"@
Set-Content -LiteralPath (Join-Path $staging 'LEIA-ME-WINDOWS.md') -Value $readme -Encoding utf8

if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zip -CompressionLevel Optimal
Write-Output "Pacote criado: $zip"
Write-Output "Executável: $executavel"
