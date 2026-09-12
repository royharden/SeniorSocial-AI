<#
.SYNOPSIS
    Customer-term leak scanner for the SeniorSocial coding tree (WP-001).

.DESCRIPTION
    Fails closed (C10, 03-parallel-build-architecture.md s4.2):

      * exit 1 when $env:LEAK_TERMS_FILE is unset or empty
      * exit 1 when the file it names does not exist
      * exit 1 when that file holds zero usable terms
      * exit 1 when any term is found in a scanned file (one line per hit)
      * exit 0 only when a non-empty term list was actually applied and matched nothing

    It never exits 0 for lack of input. A leak check that passes because it found
    nothing to check is worse than no check, because the ledger records it green.

    The scanner lives INSIDE the coding tree so a builder in a sparse lane
    worktree can run it. The term list stays OUTSIDE the coding tree (it names
    the customer) and is located only through LEAK_TERMS_FILE.

.NOTES
    Windows PowerShell 5.1 compatible: no &&, no ternary, no ?? operators.
#>
[CmdletBinding()]
param(
    # Path prefixes to scan, relative to the repo root. Defaults match 04 s4.2.
    [string[]]$Paths = @('apps', 'packages', 'infra'),

    # Extra individual files to scan (README and root config).
    [string[]]$Files = @(),

    # Print every scanned file. Off by default; the gate wants a quiet pass.
    [switch]$VerboseScan
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $OutputEncoding

$RepoRoot = Split-Path -Parent $PSScriptRoot

function Write-Fail {
    param([string]$Message)
    Write-Host "leak-scan: FAIL - $Message" -ForegroundColor Red
}

# ---------------------------------------------------------------- fail closed
$termsFile = $env:LEAK_TERMS_FILE

if ([string]::IsNullOrWhiteSpace($termsFile)) {
    Write-Fail 'LEAK_TERMS_FILE is not set. The leak scan cannot pass without a term list.'
    exit 1
}

if (-not (Test-Path -LiteralPath $termsFile -PathType Leaf)) {
    Write-Fail ("LEAK_TERMS_FILE points at '{0}', which does not exist." -f $termsFile)
    exit 1
}

$utf8 = [System.Text.UTF8Encoding]::new($false, $true)
try {
    $rawTerms = @([System.IO.File]::ReadAllLines($termsFile, $utf8))
} catch {
    Write-Fail 'LEAK_TERMS_FILE could not be read as UTF-8.'
    exit 1
}
$terms = @()
foreach ($line in $rawTerms) {
    $t = $line.Trim()
    if ($t.Length -eq 0) { continue }
    if ($t.StartsWith('#')) { continue }
    $terms += $t
}

if ($terms.Count -eq 0) {
    Write-Fail ("LEAK_TERMS_FILE '{0}' holds zero usable terms." -f $termsFile)
    exit 1
}

# ------------------------------------------------------------- what to scan
$excludeDirs = @('node_modules', '.next', '.turbo', 'dist', 'build', 'coverage',
                 '.git', 'playwright-report', 'test-results', '.pnpm-store')

$binaryExt = @('.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.avif', '.pdf',
               '.woff', '.woff2', '.ttf', '.otf', '.eot', '.zip', '.gz', '.tgz',
               '.mp4', '.webm', '.mp3', '.wav', '.node', '.wasm', '.lock',
               '.tsbuildinfo')

$targets = New-Object System.Collections.Generic.List[string]

# An explicit -Paths override means "scan exactly this". Without this flag the
# default root-config file set below would be appended to a scoped run, so a
# caller asking for one fixture directory would silently get the whole tree —
# and a scoped scan that quietly widens is a scoped scan nobody can trust.
$scoped = $PSBoundParameters.ContainsKey('Paths')

# Invoked through `powershell -File`, an array parameter arrives as a single
# string when the caller wrote `-Paths apps,packages,infra`. Split it here so the
# same argument means the same thing whether the script is dot-sourced or run as
# a file — a scanner that silently scans one nonexistent directory called
# "apps,packages,infra" is the no-op this whole script is written against.
$expanded = @()
foreach ($p in $Paths) {
    foreach ($piece in ($p -split ',')) {
        $piece = $piece.Trim()
        if ($piece.Length -gt 0) { $expanded += $piece }
    }
}
$Paths = $expanded

function Resolve-ScanPath {
    param([string]$Candidate)
    # Accept both an absolute path and one relative to the repo root. Join-Path
    # mangles an absolute second argument on Windows PowerShell, which is how a
    # caller-supplied absolute fixture path turns into a silent no-match.
    if ([System.IO.Path]::IsPathRooted($Candidate)) { return $Candidate }
    return (Join-Path $RepoRoot $Candidate)
}

function Test-ExcludedDirectoryPath {
    param([string]$Candidate)
    $rel = $Candidate
    if ($Candidate.StartsWith($RepoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        $rel = $Candidate.Substring($RepoRoot.Length)
    }
    $segments = $rel.TrimStart('\', '/') -split '[\\/]'
    foreach ($segment in $segments) {
        if ($excludeDirs -contains $segment) { return $true }
    }
    return $false
}

function Add-ScanTree {
    param([string]$Root)

    # Get-ChildItem -Recurse discovers excluded trees before the pipeline can
    # filter them. Prune those directories before descent so node_modules and
    # build outputs do not dominate the real publication-surface scan.
    if (Test-ExcludedDirectoryPath $Root) { return }
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($Root)
    while ($pending.Count -gt 0) {
        $directory = $pending.Pop()
        try {
            $entries = @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)
        } catch {
            Write-Fail ("cannot enumerate scan directory '{0}'." -f $directory)
            exit 1
        }
        foreach ($entry in $entries) {
            # Directory junctions/symlinks can escape the requested scope or
            # create cycles. Git tracks their link, not an expanded local tree.
            if (($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
            if ($entry.PSIsContainer) {
                if ($excludeDirs -notcontains $entry.Name) { $pending.Push($entry.FullName) }
                continue
            }
            if ($binaryExt -contains $entry.Extension.ToLowerInvariant()) { continue }
            if ($entry.Length -gt 2MB) { continue }
            $targets.Add($entry.FullName)
        }
    }
}

foreach ($p in $Paths) {
    $full = Resolve-ScanPath $p
    if (-not (Test-Path -LiteralPath $full)) { continue }

    if (Test-Path -LiteralPath $full -PathType Leaf) {
        $targets.Add((Resolve-Path -LiteralPath $full).Path)
        continue
    }

    Add-ScanTree $full
}

# Individual files: README plus the root config the scaffold owns. Only on a
# DEFAULT run — see $scoped above.
$defaultFiles = @()
if (-not $scoped) {
    $defaultFiles = @('README.md', 'package.json', 'pnpm-workspace.yaml',
                      'tsconfig.base.json', 'turbo.json', '.npmrc', '.editorconfig',
                      '.dockerignore', 'eslint.config.mjs')
}
foreach ($f in ($defaultFiles + $Files)) {
    $full = Resolve-ScanPath $f
    if (Test-Path -LiteralPath $full -PathType Leaf) {
        $targets.Add((Resolve-Path -LiteralPath $full).Path)
    }
}

# .github/workflows is root config too — again, default runs only.
if (-not $scoped) {
    $wf = Join-Path $RepoRoot '.github'
    if (Test-Path -LiteralPath $wf) {
        Add-ScanTree $wf
    }
}

$targets = @($targets | Sort-Object -Unique)

if ($targets.Count -eq 0) {
    # A caller that named its own scope and got nothing has almost certainly
    # mistyped the path, and returning 0 there is the same silent no-op as an
    # unset term list. Fail closed. Only a DEFAULT run over a tree that has not
    # been created yet is a legitimate zero.
    if ($scoped) {
        Write-Fail ("no scannable files under [{0}]. A scoped scan that matches nothing is not a pass." -f ($Paths -join ', '))
        exit 1
    }
    Write-Host ("leak-scan: no scannable files under [{0}]; {1} term(s) loaded." -f ($Paths -join ', '), $terms.Count)
    Write-Host 'leak-scan: PASS (empty tree not yet created)'
    exit 0
}

# ------------------------------------------------------------------- scan
$hits = New-Object System.Collections.Generic.List[string]
$scannedFiles = 0
$regexOptions = [System.Text.RegularExpressions.RegexOptions]::IgnoreCase -bor
                [System.Text.RegularExpressions.RegexOptions]::CultureInvariant
$termPatterns = New-Object System.Collections.Generic.List[string]
$termMatchers = New-Object 'System.Collections.Generic.List[System.Text.RegularExpressions.Regex]'
foreach ($term in $terms) {
    $pattern = [regex]::Escape($term)
    # Customer names and phrases are tokens, not arbitrary fragments inside
    # hashes, UUIDs or longer words. Preserve punctuation and hyphen
    # separators while requiring boundaries only at alphanumeric term edges.
    # Treat underscores as identifier characters too. A short numeric customer
    # token must still match prose inside a hyphenated label, but not generated
    # schema placeholders whose underscore makes the digits part of an identifier.
    if ([char]::IsLetterOrDigit($term[0])) { $pattern = '(?<![\p{L}\p{N}_])' + $pattern }
    if ([char]::IsLetterOrDigit($term[$term.Length - 1])) { $pattern += '(?![\p{L}\p{N}_])' }
    $termPatterns.Add($pattern)
    $termMatchers.Add([System.Text.RegularExpressions.Regex]::new($pattern, $regexOptions))
}
$termPrefilters = New-Object 'System.Collections.Generic.List[System.Text.RegularExpressions.Regex]'
$prefilterBatchSize = 64
for ($offset = 0; $offset -lt $terms.Count; $offset += $prefilterBatchSize) {
    $limit = [Math]::Min($offset + $prefilterBatchSize, $terms.Count)
    $patterns = New-Object System.Collections.Generic.List[string]
    for ($index = $offset; $index -lt $limit; $index++) {
        $patterns.Add($termPatterns[$index])
    }
    # One enormous alternation has disproportionate construction/match cost
    # for the private list. Small regex batches keep startup bounded while
    # still reducing exact term checks to the rare candidate line.
    $termPrefilters.Add([System.Text.RegularExpressions.Regex]::new(($patterns -join '|'), $regexOptions))
}

foreach ($file in $targets) {
    if ($VerboseScan) { Write-Host ("  scan {0}" -f $file) }

    try {
        $lineNo = 0
        foreach ($line in [System.IO.File]::ReadLines($file, $utf8)) {
            $lineNo++
            $candidate = $false
            foreach ($prefilter in $termPrefilters) {
                if ($prefilter.IsMatch($line)) { $candidate = $true; break }
            }
            # Re-run the exact per-term checks only on candidate lines so
            # overlapping or duplicate terms retain the original semantics.
            if (-not $candidate) { continue }
            for ($termIndex = 0; $termIndex -lt $terms.Count; $termIndex++) {
                if ($termMatchers[$termIndex].IsMatch($line)) {
                    $term = $terms[$termIndex]
                    $rel = $file
                    if ($file.StartsWith($RepoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
                        $rel = $file.Substring($RepoRoot.Length).TrimStart('\', '/')
                    }
                    $hits.Add(("{0}:{1}: matches term '{2}'" -f $rel, $lineNo, $term))
                }
            }
        }
        $scannedFiles++
    } catch {
        $rel = $file
        if ($file.StartsWith($RepoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            $rel = $file.Substring($RepoRoot.Length).TrimStart('\', '/')
        }
        Write-Fail ("cannot read scanned file '{0}' as UTF-8." -f $rel)
        exit 1
    }
}

if ($hits.Count -gt 0) {
    Write-Fail ("{0} customer-term hit(s) in {1} scanned file(s)." -f $hits.Count, $scannedFiles)
    foreach ($h in $hits) { Write-Host ("  {0}" -f $h) -ForegroundColor Red }
    exit 1
}

Write-Host ("leak-scan: PASS - {0} term(s) applied to {1} file(s); 0 hits." -f $terms.Count, $scannedFiles)
exit 0
