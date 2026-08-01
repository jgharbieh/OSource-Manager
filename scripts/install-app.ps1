#Requires -Version 5.1
<#
.SYNOPSIS
  Make OSource-Manager a clickable Windows app: Start Menu + Desktop shortcuts
  pointing at OSource-Manager.cmd, with a generated icon.

.DESCRIPTION
  No installer, no packaging, no admin rights -- the "app" is a .lnk to the
  launcher, which is what a packaged Electron shell would boil down to anyway.
  The shortcut runs minimized: the console window it owns IS the server, so
  closing that window stops OSM.

.PARAMETER NoDesktop
  Skip the Desktop shortcut (Start Menu only).

.PARAMETER Path
  Also append the repo folder to the *user* PATH so `osm <command>` works in any
  new terminal. Idempotent; never touches the machine PATH.

.PARAMETER Uninstall
  Remove the shortcuts, the generated icon, and the PATH entry.
#>
[CmdletBinding()]
param(
  [switch]$NoDesktop,
  [switch]$Path,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$repo     = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $repo 'OSource-Manager.cmd'
$iconPath = Join-Path $repo 'docs\osm.ico'
$linkName = 'OSource-Manager.lnk'
$startLnk = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\$linkName"
$deskLnk  = Join-Path ([Environment]::GetFolderPath('Desktop')) $linkName

function New-OsmIcon {
  param([Parameter(Mandatory)][string]$Destination)

  Add-Type -AssemblyName System.Drawing
  $size = 256
  $bmp  = New-Object System.Drawing.Bitmap($size, $size)
  $g    = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

  # Rounded dark tile (#0d1117), matching the README's GitHub-dark palette.
  $r = 52; $d = $r * 2
  $shape = New-Object System.Drawing.Drawing2D.GraphicsPath
  $shape.AddArc(0, 0, $d, $d, 180, 90)
  $shape.AddArc($size - $d, 0, $d, $d, 270, 90)
  $shape.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
  $shape.AddArc(0, $size - $d, $d, $d, 90, 90)
  $shape.CloseFigure()
  $bg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 13, 17, 23))
  $g.FillPath($bg, $shape)

  # "OSM" in the accent orange (#f0883e).
  $fg   = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 240, 136, 62))
  $font = New-Object System.Drawing.Font('Segoe UI', 78, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $fmt  = New-Object System.Drawing.StringFormat
  $fmt.Alignment     = [System.Drawing.StringAlignment]::Center
  $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
  $g.DrawString('OSM', $font, $fg, (New-Object System.Drawing.RectangleF(0, 0, $size, $size)), $fmt)
  $g.Dispose()

  # Vista+ ICO: a single 256x256 entry whose payload is a raw PNG.
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $png = $ms.ToArray()
  $bmp.Dispose()

  $dir = Split-Path -Parent $Destination
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $fs = [System.IO.File]::Create($Destination)
  $bw = New-Object System.IO.BinaryWriter($fs)
  $bw.Write([uint16]0)            # reserved
  $bw.Write([uint16]1)            # type: icon
  $bw.Write([uint16]1)            # image count
  $bw.Write([byte]0)              # width  (0 => 256)
  $bw.Write([byte]0)              # height (0 => 256)
  $bw.Write([byte]0)              # palette colors
  $bw.Write([byte]0)              # reserved
  $bw.Write([uint16]1)            # color planes
  $bw.Write([uint16]32)           # bits per pixel
  $bw.Write([uint32]$png.Length)  # payload size
  $bw.Write([uint32]22)           # payload offset (6 header + 16 entry)
  $bw.Write($png)
  $bw.Close()
  $fs.Dispose()
}

function New-OsmShortcut {
  param([Parameter(Mandatory)][string]$LinkPath)

  $shell = New-Object -ComObject WScript.Shell
  $sc = $shell.CreateShortcut($LinkPath)
  $sc.TargetPath       = $launcher
  $sc.WorkingDirectory = $repo
  $sc.IconLocation     = "$iconPath,0"
  $sc.Description      = 'OSource-Manager - local tool/source registry'
  $sc.WindowStyle      = 7   # minimized: the console is the server, not the UI
  $sc.Save()
  Write-Host "  + $LinkPath"
}

function Set-OsmPathEntry {
  param([switch]$Remove)

  $current = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts   = @($current -split ';' | Where-Object { $_ -ne '' })
  $present = $parts | Where-Object { $_.TrimEnd('\') -ieq $repo.TrimEnd('\') }

  if ($Remove) {
    if (-not $present) { return }
    $next = ($parts | Where-Object { $_.TrimEnd('\') -ine $repo.TrimEnd('\') }) -join ';'
    [Environment]::SetEnvironmentVariable('Path', $next, 'User')
    Write-Host "  - removed from user PATH: $repo"
    return
  }

  if ($present) { Write-Host "  = already on user PATH: $repo"; return }
  [Environment]::SetEnvironmentVariable('Path', (($parts + $repo) -join ';'), 'User')
  Write-Host "  + user PATH: $repo   (open a NEW terminal, then: osm tools)"
}

if ($Uninstall) {
  Write-Host 'Removing OSource-Manager app entries...'
  foreach ($lnk in @($startLnk, $deskLnk)) {
    if (Test-Path $lnk) { Remove-Item $lnk -Force; Write-Host "  - $lnk" }
  }
  if (Test-Path $iconPath) { Remove-Item $iconPath -Force; Write-Host "  - $iconPath" }
  Set-OsmPathEntry -Remove
  Write-Host 'Done. The repo itself was not touched.'
  return
}

if (-not (Test-Path $launcher)) { throw "Launcher not found: $launcher" }

Write-Host "Installing OSource-Manager as a Windows app"
Write-Host "  repo: $repo"

if (-not (Test-Path $iconPath)) { New-OsmIcon -Destination $iconPath; Write-Host "  + $iconPath" }
else { Write-Host "  = icon already present: $iconPath" }

New-OsmShortcut -LinkPath $startLnk
if (-not $NoDesktop) { New-OsmShortcut -LinkPath $deskLnk }
if ($Path) { Set-OsmPathEntry }

Write-Host ''
Write-Host 'Done. Press Win and type "OSource" to launch it, or use the Desktop icon.'
Write-Host 'Right-click the Start Menu result -> Pin to Start / Pin to taskbar to keep it handy.'
Write-Host 'The minimized console window IS the server - close it to stop OSM.'
