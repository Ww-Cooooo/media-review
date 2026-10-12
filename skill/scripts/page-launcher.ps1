param(
  [ValidateSet('Register','Unregister','Status')][string]$Action = 'Register',
  [Parameter(Mandatory)][string]$AppRoot,
  [Parameter(Mandatory)][string]$DataRoot,
  [Parameter(Mandatory)][string]$Node,
  [switch]$ReplaceExisting
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$name = '启动 Media Review 本机音视频校对室'
$owner = 'media-review-native-launcher/v1'
foreach ($value in @($AppRoot,$DataRoot,$Node)) {
  if (-not [IO.Path]::IsPathFullyQualified($value) -or $value -match '["\r\n\x00]') { throw 'Media Review启动入口需要明确的本机绝对路径。' }
}
$AppRoot = [IO.Path]::GetFullPath($AppRoot)
$DataRoot = [IO.Path]::GetFullPath($DataRoot)
$Node = [IO.Path]::GetFullPath($Node)
function Assert-Ordinary([string]$file, [bool]$directory) {
  $parent = Split-Path -Parent $file
  if ($parent -and $parent -ne $file) { Assert-Ordinary $parent $true }
  $item = Get-Item -LiteralPath $file -Force
  if ([bool]$item.PSIsContainer -ne $directory -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '启动入口不是普通文件或目录，未沿链接继续。' }
}
Assert-Ordinary $AppRoot $true
Assert-Ordinary $Node $false
Assert-Ordinary (Join-Path $AppRoot 'server/native-start.mjs') $false
$marker = Get-Content -LiteralPath (Join-Path $AppRoot 'standalone.json') -Raw | ConvertFrom-Json
if ($marker.format -ne 'media-review-standalone/v1') { throw '启动入口需要Media Review完整独立安装。' }
$runtime = Get-Content -LiteralPath (Join-Path $AppRoot 'server/runtime.mjs') -Raw
$revision = [regex]::Match($runtime, "export const UI_REVISION = '([a-z0-9-]+)';").Groups[1].Value
if (-not $revision) { throw '无法确认本机入口版本，未修改登记。' }
$local = Join-Path $DataRoot 'data'
$idText = [IO.Path]::GetFullPath($local).Replace('\','/').ToLowerInvariant()
$id = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($idText))).ToLowerInvariant()
$scheme = 'media-review-' + $id
$keyPath = 'Software\Classes\' + $scheme
function Format-LauncherArgument([string]$value) { return '"' + ($value -replace '(\\+)$','$1$1') + '"' }
$command = (Format-LauncherArgument $Node) + ' ' + (Format-LauncherArgument (Join-Path $AppRoot 'server/native-start.mjs')) + ' --data-dir ' + (Format-LauncherArgument $DataRoot) + ' "%1"'
$config = Join-Path $local 'native-launcher.json'
$registry = [Microsoft.Win32.Registry]::CurrentUser
$key = $registry.OpenSubKey($keyPath)
$oldCommand = $null
try {
  if ($key) {
    if ($key.GetValue('MediaReviewOwner') -ne $owner -or $key.GetValue('MediaReviewDataId') -ne $id) { throw '这个协议已有其他归属，原样保留；未覆盖未知入口。' }
    $cmdKey = $key.OpenSubKey('shell\open\command')
    try { if ($cmdKey) { $oldCommand = $cmdKey.GetValue('') } } finally { if ($cmdKey) { $cmdKey.Dispose() } }
  }
} finally { if ($key) { $key.Dispose() } }
if ($Action -eq 'Status') {
  [pscustomobject]@{registered=($oldCommand -eq $command);name=$name;scheme=$scheme} | ConvertTo-Json -Compress
  return
}
if ($Action -eq 'Unregister') {
  if ($oldCommand -and $oldCommand -ne $command) { throw '登记属于另一个安装副本，未取消。' }
  if (Test-Path -LiteralPath $config) {
    Assert-Ordinary $config $false
    $previous = Get-Content -LiteralPath $config -Raw | ConvertFrom-Json
    if ($previous.format -ne $owner -or $previous.runtimeRoot -ne $AppRoot -or $previous.dataRoot -ne $DataRoot -or $previous.node -ne $Node) { throw '启动资料归属不同，未取消或删除。' }
  }
  if ($oldCommand) { $registry.DeleteSubKeyTree($keyPath,$false) }
  if (Test-Path -LiteralPath $config) { Remove-Item -LiteralPath $config }
  Write-Output ($name + '：已取消本副本的页面启动协议；未关闭服务、删除意见或改动桌面入口。')
  return
}
if ($oldCommand -and $oldCommand -ne $command -and -not $ReplaceExisting) {
  Write-Warning '已有另一Media Review副本的页面启动入口，保持原登记；本次安装继续，但未切换协议。明确采用新副本时再加-ReplacePageLauncher。'
  return
}
function Initialize-LauncherDirectory([string]$directory) {
  if (Test-Path -LiteralPath $directory) { Assert-Ordinary $directory $true; return }
  $parent = Split-Path -Parent $directory
  if ($parent -and $parent -ne $directory) { Initialize-LauncherDirectory $parent }
  [IO.Directory]::CreateDirectory($directory) | Out-Null
  Assert-Ordinary $directory $true
}
Initialize-LauncherDirectory $local
if (Test-Path -LiteralPath $config) {
  Assert-Ordinary $config $false
  $previous = Get-Content -LiteralPath $config -Raw | ConvertFrom-Json
  if ($previous.format -ne $owner -or $previous.dataRoot -ne $DataRoot) { throw '已有启动资料身份不同，原样保留。' }
  if ($previous.runtimeRoot -ne $AppRoot -and -not $ReplaceExisting) { Write-Warning '启动资料已绑定另一安装，未替换；本副本仍可从桌面启动。'; return }
}
$value = [ordered]@{format=$owner;uiRevision=$revision;dataRoot=$DataRoot;runtimeRoot=$AppRoot;node=$Node}
# 协议只传固定start网址；直接调用Node，不经cmd或PowerShell解释网址内容。
$created = $null -eq $oldCommand
try {
  $key = $registry.CreateSubKey($keyPath)
  try {
    $key.SetValue('MediaReviewOwner',$owner)
    $key.SetValue('MediaReviewDataId',$id)
    $key.SetValue('','URL:' + $name)
    $key.SetValue('URL Protocol','')
    $key.SetValue('FriendlyTypeName',$name)
    $app = $key.CreateSubKey('Application')
    try { $app.SetValue('ApplicationName',$name); $app.SetValue('ApplicationDescription','启动本机Media Review的Node.js音视频校对服务，不上传素材，不开机自启。') } finally { $app.Dispose() }
    $cmdKey = $key.CreateSubKey('shell\open\command')
    try { $cmdKey.SetValue('',$command) } finally { $cmdKey.Dispose() }
  } finally { $key.Dispose() }
  $temporary = Join-Path $local ('.native-launcher-' + [Guid]::NewGuid().ToString('N') + '.tmp')
  try {
    [IO.File]::WriteAllText($temporary,($value | ConvertTo-Json -Compress) + "`n",[Text.UTF8Encoding]::new($false))
    [IO.File]::Move($temporary,$config,$true)
  } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary } }
} catch {
  # 失败时只撤回本轮创建的键，或恢复已确认属于本应用的原启动命令。
  if ($created) { $registry.DeleteSubKeyTree($keyPath,$false) }
  elseif ($oldCommand) { $restore=$registry.OpenSubKey($keyPath + '\shell\open\command',$true); try { $restore.SetValue('',$oldCommand) } finally { $restore.Dispose() } }
  throw
}
Write-Output ($name + '：已配置Windows当前用户的页面启动入口。')
Write-Output '用途：从浏览器唤起本机Media Review的Node.js服务。不上传素材，不开机自启，不增加常驻启动器。'
Write-Output '系统可能显示Node.js、脚本程序或未知发布者。请核对安装来源和实际路径；若被安全软件阻止，请查看拦截详情，不要关闭防护或随意加入排除。'
