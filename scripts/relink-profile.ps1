<#
  把 Desktop profile 里的旧插件名 @local/nitui 迁到 @zhangxij/dsh-nitui。

  DSH 的文件沙箱只允许 agent 写工作区（D:\shiqianyanshika），
  profile 在 C:\Users\lenovo\.dsh\profiles\desktop，agent 写不进去。
  这个脚本由你在本机运行；它会先备份 package.json 和 pnpm-lock.yaml。

  用法（关不关 DSH 都可以，改动在下次启动时生效）：
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\relink-profile.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\relink-profile.ps1 -DryRun
#>
[CmdletBinding()]
param(
  [switch]$DryRun,
  [string]$Profile = 'C:\Users\lenovo\.dsh\profiles\desktop',
  [string]$Plugin = 'D:\shiqianyanshika\plugin'
)

$ErrorActionPreference = 'Stop'

$profileDir = $Profile
$pluginDir = $Plugin
$oldName = '@local/nitui'
$newName = '@zhangxij/dsh-nitui'

$profilePkg = Join-Path $profileDir 'package.json'
$lockFile = Join-Path $profileDir 'pnpm-lock.yaml'
$oldLink = Join-Path $profileDir 'node_modules\@local\nitui'
$newLink = Join-Path $profileDir 'node_modules\@zhangxij\dsh-nitui'

foreach ($path in @($profilePkg, $lockFile, (Join-Path $pluginDir 'package.json'))) {
  if (-not (Test-Path -LiteralPath $path)) { throw "找不到：$path" }
}

$pluginPkg = Get-Content -LiteralPath (Join-Path $pluginDir 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($pluginPkg.name -ne $newName) {
  throw "插件 package.json 的 name 是 $($pluginPkg.name)，不是 $newName"
}

$pkgText = [IO.File]::ReadAllText($profilePkg)
$lockText = [IO.File]::ReadAllText($lockFile)
$pkgChanged = $pkgText.Contains('"' + $oldName + '"')
$lockChanged = $lockText.Contains("'" + $oldName + "':")

Write-Host "profile : $profileDir"
Write-Host "plugin  : $pluginDir"
Write-Host "package.json 需要改：$pkgChanged"
Write-Host "pnpm-lock 需要改  ：$lockChanged"
Write-Host "旧 junction 存在  ：$(Test-Path -LiteralPath $oldLink)"
Write-Host "新 junction 存在  ：$(Test-Path -LiteralPath $newLink)"

if (Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^(DeepSeek Harness|dsh)$' }) {
  Write-Warning 'DSH 似乎正在运行；脚本可以现在跑，但要重启 DSH 后才会用新名字。'
}

if ($DryRun) {
  Write-Host 'DRY RUN：没有写入任何文件。'
  return
}

$backup = Join-Path $profileDir ('.nitui-relink-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $backup | Out-Null
Copy-Item -LiteralPath $profilePkg -Destination (Join-Path $backup 'package.json')
Copy-Item -LiteralPath $lockFile -Destination (Join-Path $backup 'pnpm-lock.yaml')
Write-Host "备份：$backup"

$newParent = Split-Path -Parent $newLink
if (-not (Test-Path -LiteralPath $newParent)) {
  New-Item -ItemType Directory -Path $newParent | Out-Null
}
if (-not (Test-Path -LiteralPath $newLink)) {
  New-Item -ItemType Junction -Path $newLink -Target $pluginDir | Out-Null
  Write-Host '已创建 node_modules\@zhangxij\dsh-nitui -> 插件目录'
}

$utf8 = [Text.UTF8Encoding]::new($false)
if ($pkgChanged) {
  $pkgText = $pkgText.Replace('"' + $oldName + '"', '"' + $newName + '"')
  [IO.File]::WriteAllText($profilePkg, $pkgText, $utf8)
  Write-Host '已更新 package.json（dependencies + dsh.profile.bundles）'
}
if ($lockChanged) {
  $lockText = $lockText.Replace("'" + $oldName + "':", "'" + $newName + "':")
  [IO.File]::WriteAllText($lockFile, $lockText, $utf8)
  Write-Host '已更新 pnpm-lock.yaml'
}

if (Test-Path -LiteralPath $oldLink) {
  cmd /c rmdir "$oldLink"
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "旧 junction 没删掉（可能被正在运行的 DSH 占用）：$oldLink"
    Write-Warning '新名字已经可用；重启后如果插件管理里还有旧条目，再在界面里移除。'
  } else {
    Write-Host '已删除 node_modules\@local\nitui'
  }
}

$after = [IO.File]::ReadAllText($profilePkg)
if ($after.Contains('"' + $oldName + '"')) { throw 'package.json 里仍有旧名字，请检查' }
$linkedPkg = Get-Content -LiteralPath (Join-Path $newLink 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($linkedPkg.name -ne $newName) { throw "新 junction 指向的包名是 $($linkedPkg.name)" }

Write-Host ''
Write-Host '完成。重启 DSH，然后到 设置 → 插件 里确认「逆推」在列表里。'
Write-Host '如果插件管理仍显示旧条目，在界面里移除后再添加本地目录：'
Write-Host "  $pluginDir"
