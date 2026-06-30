param(
  [string]$OutDir = ""
)

$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if ([string]::IsNullOrWhiteSpace($OutDir)) {
  $OutDir = Join-Path $projectRoot "dist\store-assets"
}

New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
Add-Type -AssemblyName System.Drawing

function New-Bitmap([int]$Width, [int]$Height) {
  $bitmap = New-Object System.Drawing.Bitmap $Width, $Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
  return @($bitmap, $graphics)
}

function New-Font([float]$Size, [System.Drawing.FontStyle]$Style = [System.Drawing.FontStyle]::Regular) {
  return New-Object System.Drawing.Font("Segoe UI", $Size, $Style, [System.Drawing.GraphicsUnit]::Pixel)
}

function Save-Png($bitmap, $graphics, [string]$Path) {
  $graphics.Dispose()
  $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()
}

function Draw-RoundedRect($graphics, [System.Drawing.RectangleF]$Rect, [float]$Radius, $Brush, $Pen = $null) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $diameter = $Radius * 2
  $path.AddArc($Rect.X, $Rect.Y, $diameter, $diameter, 180, 90)
  $path.AddArc($Rect.Right - $diameter, $Rect.Y, $diameter, $diameter, 270, 90)
  $path.AddArc($Rect.Right - $diameter, $Rect.Bottom - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($Rect.X, $Rect.Bottom - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  if ($Brush) { $graphics.FillPath($Brush, $path) }
  if ($Pen) { $graphics.DrawPath($Pen, $path) }
  $path.Dispose()
}

function Draw-QuietMark($graphics, [float]$X, [float]$Y, [float]$Size) {
  $accent = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255,217,255,118))
  $teal = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255,103,211,192))
  $bookmark = @(
    (New-Object System.Drawing.PointF ($X + $Size * 0.30), ($Y + $Size * 0.18)),
    (New-Object System.Drawing.PointF ($X + $Size * 0.70), ($Y + $Size * 0.18)),
    (New-Object System.Drawing.PointF ($X + $Size * 0.70), ($Y + $Size * 0.78)),
    (New-Object System.Drawing.PointF ($X + $Size * 0.50), ($Y + $Size * 0.62)),
    (New-Object System.Drawing.PointF ($X + $Size * 0.30), ($Y + $Size * 0.78))
  )
  $graphics.FillPolygon($accent, $bookmark)
  $graphics.FillEllipse($teal, ($X + $Size * 0.42), ($Y + $Size * 0.34), ($Size * 0.16), ($Size * 0.16))
  $accent.Dispose()
  $teal.Dispose()
}

function Draw-Text($graphics, [string]$Text, [float]$X, [float]$Y, [float]$W, [float]$H, $Font, $Brush) {
  $format = New-Object System.Drawing.StringFormat
  $format.Trimming = [System.Drawing.StringTrimming]::EllipsisWord
  $format.FormatFlags = [System.Drawing.StringFormatFlags]::LineLimit
  $graphics.DrawString($Text, $Font, $Brush, (New-Object System.Drawing.RectangleF $X,$Y,$W,$H), $format)
  $format.Dispose()
}

$ink = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255,246,241,231))
$muted = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255,169,176,170))
$subtle = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255,112,122,118))
$panel = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255,29,33,29))
$field = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255,13,16,14))
$accent = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255,217,255,118))
$teal = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255,103,211,192))
$line = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(38,246,241,231)), 1

$fontTitle = New-Font 68 ([System.Drawing.FontStyle]::Bold)
$fontH2 = New-Font 30 ([System.Drawing.FontStyle]::Bold)
$fontBody = New-Font 26
$fontSmall = New-Font 18
$fontTiny = New-Font 15 ([System.Drawing.FontStyle]::Bold)

$pair = New-Bitmap 1280 800
$bmp = $pair[0]
$g = $pair[1]
$bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Rectangle 0,0,1280,800),
  [System.Drawing.Color]::FromArgb(255,20,23,20),
  [System.Drawing.Color]::FromArgb(255,33,43,35),
  [System.Drawing.Drawing2D.LinearGradientMode]::ForwardDiagonal
)
$g.FillRectangle($bg, 0, 0, 1280, 800)
Draw-QuietMark $g 74 76 126
Draw-Text $g "QuietMarks" 220 88 520 84 $fontTitle $ink
Draw-Text $g "Private bookmark sync through your own WebDAV storage." 224 184 500 92 $fontBody $muted

Draw-RoundedRect $g (New-Object System.Drawing.RectangleF 780,72,410,610) 12 $panel $line
Draw-Text $g "Synced" 822 118 220 40 $fontH2 $ink
Draw-Text $g "Last sync 9:42 AM" 824 170 260 32 $fontSmall $muted
Draw-RoundedRect $g (New-Object System.Drawing.RectangleF 824,226,312,46) 7 $field $line
Draw-Text $g "WebDAV root URL" 844 239 190 26 $fontTiny $muted
Draw-RoundedRect $g (New-Object System.Drawing.RectangleF 824,296,312,46) 7 $field $line
Draw-Text $g "QuietMarks/state.json" 844 309 240 26 $fontSmall $ink
Draw-RoundedRect $g (New-Object System.Drawing.RectangleF 824,388,142,48) 7 $field $line
Draw-Text $g "Save" 868 402 90 26 $fontSmall $ink
Draw-RoundedRect $g (New-Object System.Drawing.RectangleF 986,388,150,48) 7 $accent $null
$darkText = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255,20,23,20))
Draw-Text $g "Sync now" 1013 402 110 26 $fontSmall $darkText
Draw-RoundedRect $g (New-Object System.Drawing.RectangleF 824,494,312,88) 8 $field $line
Draw-Text $g "Local 128, cloud 130, merged 132" 846 514 270 26 $fontSmall $ink
Draw-Text $g "Applied 132, missing 0" 846 548 250 24 $fontSmall $teal

Draw-RoundedRect $g (New-Object System.Drawing.RectangleF 96,326,560,84) 10 $panel $line
Draw-Text $g "Auto merge safely" 130 344 420 36 $fontH2 $ink
Draw-Text $g "Three-way merge keeps local and cloud changes together." 132 386 460 28 $fontSmall $muted
Draw-RoundedRect $g (New-Object System.Drawing.RectangleF 96,438,560,84) 10 $panel $line
Draw-Text $g "Encrypted remote state" 130 456 420 36 $fontH2 $ink
Draw-Text $g "Use a passphrase so your WebDAV file stays private." 132 498 460 28 $fontSmall $muted
Draw-RoundedRect $g (New-Object System.Drawing.RectangleF 96,550,560,84) 10 $panel $line
Draw-Text $g "Post-apply verification" 130 568 420 36 $fontH2 $ink
Draw-Text $g "Reports missing bookmarks instead of silent success." 132 610 460 28 $fontSmall $muted
Save-Png $bmp $g (Join-Path $OutDir "screenshot-1280x800.png")
$bg.Dispose()

$pair = New-Bitmap 440 280
$bmp = $pair[0]
$g = $pair[1]
$bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Rectangle 0,0,440,280),
  [System.Drawing.Color]::FromArgb(255,20,23,20),
  [System.Drawing.Color]::FromArgb(255,34,43,35),
  [System.Drawing.Drawing2D.LinearGradientMode]::ForwardDiagonal
)
$g.FillRectangle($bg, 0, 0, 440, 280)
Draw-QuietMark $g 34 42 84
Draw-Text $g "QuietMarks" 134 50 260 54 (New-Font 44 ([System.Drawing.FontStyle]::Bold)) $ink
Draw-Text $g "Private WebDAV bookmark sync with automatic merge." 136 110 250 70 (New-Font 20) $muted
Draw-RoundedRect $g (New-Object System.Drawing.RectangleF 44,190,352,42) 8 $panel $line
Draw-Text $g "Local + cloud + merged + verified" 70 202 300 26 (New-Font 18 ([System.Drawing.FontStyle]::Bold)) $teal
Save-Png $bmp $g (Join-Path $OutDir "promo-440x280.png")
$bg.Dispose()

$ink.Dispose(); $muted.Dispose(); $subtle.Dispose(); $panel.Dispose(); $field.Dispose(); $accent.Dispose(); $teal.Dispose(); $line.Dispose()
$fontTitle.Dispose(); $fontH2.Dispose(); $fontBody.Dispose(); $fontSmall.Dispose(); $fontTiny.Dispose(); $darkText.Dispose()

Get-ChildItem -LiteralPath $OutDir | Select-Object Name,Length
