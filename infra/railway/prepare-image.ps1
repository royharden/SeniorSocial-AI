[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-f]{40}$')]
  [string]$SealedCandidateSha,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-z0-9][a-z0-9./_-]+$')]
  [string]$LocalImageRepository
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$env:SEALED_CANDIDATE_SHA = $SealedCandidateSha

node (Join-Path $PSScriptRoot 'release-gate.mjs') candidate $repoRoot
if ($LASTEXITCODE -ne 0) { throw 'Candidate identity gate failed.' }

# This is deliberately the repository's fail-closed scanner. It requires the
# externally supplied LEAK_TERMS_FILE and exits nonzero when that input is absent.
& (Join-Path $repoRoot 'scripts\leak-scan.ps1') -Paths @(
  (Join-Path $repoRoot 'apps'),
  (Join-Path $repoRoot 'packages'),
  (Join-Path $repoRoot 'infra'),
  (Join-Path $repoRoot 'README.md'),
  (Join-Path $repoRoot 'package.json'),
  (Join-Path $repoRoot 'pnpm-lock.yaml'),
  (Join-Path $repoRoot 'pnpm-workspace.yaml'),
  (Join-Path $repoRoot 'tsconfig.base.json'),
  (Join-Path $repoRoot 'turbo.json'),
  (Join-Path $repoRoot '.npmrc'),
  (Join-Path $repoRoot '.editorconfig'),
  (Join-Path $repoRoot '.dockerignore'),
  (Join-Path $repoRoot 'eslint.config.mjs'),
  (Join-Path $repoRoot '.github')
)
if ($LASTEXITCODE -ne 0) { throw 'Leak scan failed; no image may be built or uploaded.' }

$tag = "${LocalImageRepository}:candidate-$SealedCandidateSha"
docker build --file (Join-Path $repoRoot 'infra\docker\Dockerfile') --target release --tag $tag $repoRoot
if ($LASTEXITCODE -ne 0) { throw 'Local release image build failed.' }

$localImageId = docker image inspect --format '{{.Id}}' $tag
if ($LASTEXITCODE -ne 0) { throw 'Built image inspection failed.' }
Write-Output "LOCAL_IMAGE_TAG=$tag"
Write-Output "LOCAL_IMAGE_ID=$localImageId"
Write-Output 'IMAGE_DIGEST remains unresolved until an authorized registry push returns the OCI manifest digest.'
Write-Output 'No registry push, Railway command, authentication, provisioning, deployment, DNS change, or remote request was performed.'
