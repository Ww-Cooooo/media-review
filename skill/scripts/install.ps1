param(
  [string]$Destination = (Join-Path $HOME '.claude\skills\media-review'),
  [string]$DesktopDirectory = [Environment]::GetFolderPath('DesktopDirectory'),
  [switch]$InitializeOnly,
  [switch]$SkipPageLauncher,
  [switch]$ReplacePageLauncher,
  [string]$Ffmpeg,
  [string]$Whisper,
  [string]$Model
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if ($env:MEDIA_REVIEW_DATA_DIR -and -not [IO.Path]::IsPathFullyQualified($env:MEDIA_REVIEW_DATA_DIR)) { throw 'MEDIA_REVIEW_DATA_DIR必须是绝对路径；未安装或修改启动入口。' }
$source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw '未找到Node.js。请 Agent 运行本 Skill 的 scripts/first-use.cmd 自动准备；低层安装器不负责下载。' }
$major = [int]((& $node --version).TrimStart('v').Split('.')[0])
if ($major -lt 24) { throw '需要Node.js 24或更新版本；未修改现有安装。' }
function Assert-OrdinaryDirectory([string]$directory) {
  $parent = Split-Path -Parent $directory
  if ($parent -and $parent -ne $directory) { Assert-OrdinaryDirectory $parent }
  if (Test-Path -LiteralPath $directory) {
    $item = Get-Item -LiteralPath $directory -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '目标不是普通目录，拒绝继续安装。' }
  } else {
    [IO.Directory]::CreateDirectory($directory) | Out-Null
  }
}
function Assert-OrdinaryFile([string]$file) {
  Assert-OrdinaryDirectory (Split-Path -Parent $file)
  $item = Get-Item -LiteralPath $file -Force
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '文件不是普通文件，原样保留；拒绝沿链接继续。' }
}
$target = if ($InitializeOnly) { $source } else { [IO.Path]::GetFullPath($Destination) }
Assert-OrdinaryFile (Join-Path $source 'skill-package.json')
$manifest = Get-Content -LiteralPath (Join-Path $source 'skill-package.json') -Raw | ConvertFrom-Json
if ($manifest.name -ne 'media-review') { throw '安装包身份不符。' }
$iconRelative = 'app/dist/brand/media-review-launcher.ico'
if ($iconRelative -notin $manifest.files.path) { throw '安装包缺少启动图标登记，未安装或修改入口。' }
foreach ($file in $manifest.files) {
  if ($file.path -match '(^|[\\/])\.\.([\\/]|$)' -or [IO.Path]::IsPathRooted($file.path)) { throw '安装包路径越界。' }
  $inputFile = Join-Path $source $file.path
  Assert-OrdinaryFile $inputFile
  $actual = (Get-FileHash -LiteralPath $inputFile -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $file.sha256) { throw '安装包内容不完整，未安装。' }
}
if (-not $InitializeOnly) {
  Assert-OrdinaryDirectory (Split-Path -Parent $target)
  if (Test-Path -LiteralPath $target) {
    Assert-OrdinaryDirectory $target
    $existing = Join-Path $target 'skill-package.json'
    if (-not (Test-Path -LiteralPath $existing)) { throw '目标已有其他内容，原样保留；请选择新的安装目录。' }
    Assert-OrdinaryFile $existing
    if ((Get-Content -LiteralPath $existing -Raw) -ne (Get-Content -LiteralPath (Join-Path $source 'skill-package.json') -Raw)) { throw '目标已有不同版本或内容，原样保留；请先选择新的安装目录或明确升级。' }
    foreach ($file in $manifest.files) {
      $installedFile = Join-Path $target $file.path
      Assert-OrdinaryFile $installedFile
      if ((Get-FileHash -LiteralPath $installedFile -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) { throw '已安装副本有本机修改，原样保留。' }
    }
  } else {
    $stage = Join-Path (Split-Path -Parent $target) ('.review-install-' + [Guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($stage) | Out-Null
    foreach ($file in $manifest.files) {
      $output = Join-Path $stage $file.path
      [IO.Directory]::CreateDirectory((Split-Path -Parent $output)) | Out-Null
      [IO.File]::Copy((Join-Path $source $file.path), $output, $false)
    }
    [IO.File]::Copy((Join-Path $source 'skill-package.json'), (Join-Path $stage 'skill-package.json'), $false)
    [IO.Directory]::Move($stage, $target)
  }
}
# 工具绑定只写本机私有数据，不复制进Skill包；不扫描、不下载。
$tools = @{}
foreach ($pair in @(@('ffmpeg',$Ffmpeg),@('whisper_cpu',$Whisper),@('model',$Model))) {
  if ($pair[1]) {
    $file = Get-Item -LiteralPath $pair[1]
    if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '工具路径不是普通文件。' }
    $tools[$pair[0]] = $file.FullName
  }
}
if ($tools.Count) {
  $homeData = if ($env:MEDIA_REVIEW_DATA_DIR) { $env:MEDIA_REVIEW_DATA_DIR } else { Join-Path $HOME '.media-review-desk' }
  $data = Join-Path $homeData 'data'; Assert-OrdinaryDirectory $data
  $toolsFile = Join-Path $data 'tools.json'
  if (Test-Path -LiteralPath $toolsFile) { Write-Warning '已有工具绑定，原样保留；未替换本机配置。' }
  else { $tools | ConvertTo-Json | Set-Content -LiteralPath $toolsFile -Encoding utf8NoBOM }
}
Assert-OrdinaryDirectory $DesktopDirectory
$shortcutPath = Join-Path $DesktopDirectory 'Media Review.lnk'
$legacyShortcutArgs = '"' + (Join-Path $target 'app\server\open.mjs') + '"'
$shortcutArgs = '"' + (Join-Path $target 'scripts\setup.mjs') + '" --desktop-dir "' + ($DesktopDirectory -replace '(\\+)$','$1$1') + '"'
if ($env:MEDIA_REVIEW_DATA_DIR) {
  if ($env:MEDIA_REVIEW_DATA_DIR -match '["\r\n\x00]') { throw '桌面入口需要明确的本机资料目录。' }
  $shortcutArgs += ' --data-dir "' + ([IO.Path]::GetFullPath($env:MEDIA_REVIEW_DATA_DIR) -replace '(\\+)$','$1$1') + '"'
  $legacyShortcutArgs += ' --data-dir "' + ([IO.Path]::GetFullPath($env:MEDIA_REVIEW_DATA_DIR) -replace '(\\+)$','$1$1') + '"'
}
if ($SkipPageLauncher) { $shortcutArgs += ' --skip-page-launcher' }
$shell = New-Object -ComObject WScript.Shell
if (Test-Path -LiteralPath $shortcutPath) {
  Assert-OrdinaryFile $shortcutPath
  $old = $shell.CreateShortcut($shortcutPath)
  if ($old.TargetPath -ne $node -or $old.Arguments -notin @($shortcutArgs,$legacyShortcutArgs)) {
    $matching = $null
    foreach ($file in Get-ChildItem -LiteralPath $DesktopDirectory -Filter 'Media Review-*.lnk' -File) {
      Assert-OrdinaryFile $file.FullName
      $existing = $shell.CreateShortcut($file.FullName)
      if ($existing.TargetPath -eq $node -and $existing.Arguments -in @($shortcutArgs,$legacyShortcutArgs)) { $matching = $file.FullName; break }
    }
    $shortcutPath = if ($matching) { $matching } else { Join-Path $DesktopDirectory ('Media Review-' + [Guid]::NewGuid().ToString('N').Substring(0,6) + '.lnk') }
  }
}
$shortcut = $shell.CreateShortcut($shortcutPath)
$workingDirectory = Join-Path $target 'app'
$iconLocation = (Join-Path $target $iconRelative) + ',0'
$description = '启动 Media Review：先检查已有工具，仅补缺项；按需启动或复用本机服务'
if ($shortcut.TargetPath -ne $node -or $shortcut.Arguments -ne $shortcutArgs -or $shortcut.WorkingDirectory -ne $workingDirectory -or $shortcut.IconLocation -ne $iconLocation -or $shortcut.Description -ne $description -or $shortcut.WindowStyle -ne 7) {
  $shortcut.TargetPath = $node
  $shortcut.Arguments = $shortcutArgs
  $shortcut.WorkingDirectory = $workingDirectory
  $shortcut.IconLocation = $iconLocation
  $shortcut.Description = $description
  $shortcut.WindowStyle = 7
  $shortcut.Save()
} else { Write-Output '桌面入口检查通过，直接复用。' }
if (-not $SkipPageLauncher) {
  $homeData = if ($env:MEDIA_REVIEW_DATA_DIR) { $env:MEDIA_REVIEW_DATA_DIR } else { Join-Path $HOME '.media-review-desk' }
  Assert-OrdinaryDirectory (Join-Path $homeData 'data')
  & (Join-Path $target 'scripts/page-launcher.ps1') -AppRoot (Join-Path $target 'app') -DataRoot $homeData -Node $node -ReplaceExisting:$ReplacePageLauncher
} else { Write-Output '已跳过Windows页面启动协议；仍可使用桌面入口。' }
Write-Output ('Skill已就绪：' + $target)
Write-Output ('桌面入口：' + $shortcutPath)
Write-Output '双击图标会按需启动服务；不会开机自启、上传素材或自动执行用户意见。'
