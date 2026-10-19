# Shared by installed copies. A shortcut belongs to a data library, not an Agent or package path.
function Set-ReviewDesktopEntry {
  param([string]$Target, [string]$Node, [string]$DesktopDirectory, [string]$DataRoot,
    [string]$Name, [switch]$SkipPageLauncher)
  $defaultData = [IO.Path]::GetFullPath((Join-Path $HOME '.media-review-desk')).TrimEnd('\','/')
  $library = [IO.Path]::GetFullPath($DataRoot).TrimEnd('\','/')
  if (-not $Name) {
    if ($library -ne $defaultData) {
      Write-Output '独立资料库已保留；未请求专用桌面入口，不新增图标。'
      return
    }
    $Name = 'Media Review'
  }
  if ($Name -match '[<>:"/\\|?*\x00-\x1f]' -or $Name -match '[. ]$' -or $Name -in @('.','..')) { throw '桌面入口名称无效。' }
  if ($Name -eq 'Media Review' -and $library -ne $defaultData) { throw '独立资料库不能占用默认桌面入口。' }
  Assert-OrdinaryDirectory $DesktopDirectory
  $desktop = [IO.Path]::GetFullPath($DesktopDirectory).TrimEnd('\','/')
  $key = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($desktop.ToLowerInvariant())))
  $mutex = [Threading.Mutex]::new($false, ('Local\MediaReviewDesktop-' + $key))
  $held = $false
  try {
    try { $held = $mutex.WaitOne(30000) } catch [Threading.AbandonedMutexException] { $held = $true }
    if (-not $held) { throw '另一个入口更新仍在进行，请稍后重试；未创建额外图标。' }
    $file = Join-Path $desktop ($Name + '.lnk')
    $shell = New-Object -ComObject WScript.Shell
    $chosen = $Target
    $chosenNode = $Node
    $skip = [bool]$SkipPageLauncher
    if (Test-Path -LiteralPath $file) {
      Assert-OrdinaryFile $file
      $old = $shell.CreateShortcut($file)
      # Only recognize our exact legacy/current command grammar; never replace an unrelated shortcut.
      $pattern = '^"(?<script>[^"\r\n]+\\(?:scripts\\setup|app\\server\\open)\.mjs)"(?: --desktop-dir "[^"\r\n]+")?(?: --data-dir "(?<data>[^"\r\n]+)")?(?: --desktop-name "[^"\r\n]+")?(?<skip> --skip-page-launcher)?$'
      if ($old.Description -notlike '启动 Media Review*' -or $old.Arguments -notmatch $pattern) { throw '同名图标不是可识别的 Media Review 入口，已保留；未新增随机图标。' }
      $parts = $Matches.Clone()
      $oldData = if ($parts.data) { [IO.Path]::GetFullPath($parts.data).TrimEnd('\','/') } else { $defaultData }
      if ($oldData -ne $library) { throw '同名入口属于另一资料库，原样保留；请为专用入口使用清楚且不同的名称。' }
      $oldRoot = $parts.script -replace '\\(?:scripts\\setup|app\\server\\open)\.mjs$', ''
      $oldManifest = Join-Path $oldRoot 'skill-package.json'
      if ((Test-Path -LiteralPath $oldManifest) -and (Test-Path -LiteralPath $old.TargetPath) -and (Test-Path -LiteralPath (Join-Path $oldRoot 'scripts/setup.mjs'))) {
        Assert-OrdinaryFile $oldManifest
        $before = Get-Content -LiteralPath $oldManifest -Raw | ConvertFrom-Json
        $after = Get-Content -LiteralPath (Join-Path $Target 'skill-package.json') -Raw | ConvertFrom-Json
        if ($before.name -ne 'media-review' -or $before.skill_id -ne $after.skill_id) { throw '旧入口的安装身份无法确认，原样保留。' }
        # A remaining setup script alone does not make a partly deleted runtime usable.
        $healthy = @($before.files).Count -gt 0
        foreach ($entry in $before.files) {
          if (-not $entry.path -or $entry.path -match '(^|[\\/])\.\.([\\/]|$)' -or [IO.Path]::IsPathRooted($entry.path)) { throw '旧入口清单路径无效，原样保留。' }
          $owned = Join-Path $oldRoot $entry.path
          if (-not (Test-Path -LiteralPath $owned)) { $healthy = $false; break }
          Assert-OrdinaryFile $owned
          if ((Get-FileHash -LiteralPath $owned -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256) { $healthy = $false; break }
        }
        # Equal versions keep a complete working location. Older callers cannot downgrade a healthy entry.
        if ($healthy -and [System.Management.Automation.SemanticVersion]$before.version -ge [System.Management.Automation.SemanticVersion]$after.version) {
          $chosen = $oldRoot; $chosenNode = $old.TargetPath; $skip = [bool]$parts.skip
        }
      }
    }
    function Quote-ReviewArgument([string]$value) {
      if ($value -match '["\r\n\x00]') { throw '入口路径含无效字符。' }
      return '"' + ($value -replace '(\\+)$','$1$1') + '"'
    }
    $args = (Quote-ReviewArgument (Join-Path $chosen 'scripts/setup.mjs')) + ' --desktop-dir ' + (Quote-ReviewArgument $desktop) + ' --data-dir ' + (Quote-ReviewArgument $library)
    if ($Name -ne 'Media Review') { $args += ' --desktop-name ' + (Quote-ReviewArgument $Name) }
    if ($skip) { $args += ' --skip-page-launcher' }
    $link = $shell.CreateShortcut($file)
    $icon = (Join-Path $chosen 'app/dist/brand/media-review-launcher.ico') + ',0'
    $working = Join-Path $chosen 'app'
    $description = '启动 Media Review：先检查已有工具，仅补缺项；按需启动或复用本机服务'
    if ($link.TargetPath -ne $chosenNode -or $link.Arguments -ne $args -or $link.WorkingDirectory -ne $working -or $link.IconLocation -ne $icon -or $link.Description -ne $description -or $link.WindowStyle -ne 7) {
      $link.TargetPath = $chosenNode; $link.Arguments = $args; $link.WorkingDirectory = $working
      $link.IconLocation = $icon; $link.Description = $description; $link.WindowStyle = 7
      $link.Save()
    }
    Write-Output ('桌面入口已就绪（同一资料库复用）：' + $file)
  } finally {
    if ($held) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
}
