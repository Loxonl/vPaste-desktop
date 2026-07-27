[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory,
    [Parameter(Mandatory = $true)]
    [string]$Version
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null

function New-RoundedPath {
    param(
        [Parameter(Mandatory = $true)]
        [System.Drawing.RectangleF]$Rectangle,
        [Parameter(Mandatory = $true)]
        [float]$Radius
    )

    $diameter = $Radius * 2
    $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $path.AddArc($Rectangle.X, $Rectangle.Y, $diameter, $diameter, 180, 90)
    $path.AddArc($Rectangle.Right - $diameter, $Rectangle.Y, $diameter, $diameter, 270, 90)
    $path.AddArc(
        $Rectangle.Right - $diameter,
        $Rectangle.Bottom - $diameter,
        $diameter,
        $diameter,
        0,
        90
    )
    $path.AddArc($Rectangle.X, $Rectangle.Bottom - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    return $path
}

function Save-Png {
    param(
        [Parameter(Mandatory = $true)]
        [System.Drawing.Bitmap]$Bitmap,
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    $Bitmap.Save(
        (Join-Path $OutputDirectory $Name),
        [System.Drawing.Imaging.ImageFormat]::Png
    )
}

function New-InstallerBackground {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [bool]$Dark
    )

    if ($Dark) {
        $bodyTopColor = [System.Drawing.ColorTranslator]::FromHtml("#202B3D")
        $bodyColor = [System.Drawing.ColorTranslator]::FromHtml("#1B2230")
        $circuitColor = [System.Drawing.Color]::FromArgb(105, 79, 132, 206)
        $dotColor = [System.Drawing.Color]::FromArgb(92, 92, 150, 229)
        $glowColor = [System.Drawing.Color]::FromArgb(88, 66, 139, 255)
    }
    else {
        $bodyTopColor = [System.Drawing.ColorTranslator]::FromHtml("#FBFDFF")
        $bodyColor = [System.Drawing.ColorTranslator]::FromHtml("#F1F6FF")
        $circuitColor = [System.Drawing.Color]::FromArgb(130, 159, 196, 241)
        $dotColor = [System.Drawing.Color]::FromArgb(92, 143, 186, 239)
        $glowColor = [System.Drawing.Color]::FromArgb(190, 255, 255, 255)
    }

    $bitmap = [System.Drawing.Bitmap]::new(
        1000,
        1040,
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
    )
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.Clear($bodyColor)

        $bodyGradient = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
            [System.Drawing.Rectangle]::new(0, 0, 1000, 800),
            $bodyTopColor,
            $bodyColor,
            90
        )
        try {
            $graphics.FillRectangle($bodyGradient, 0, 0, 1000, 800)
        }
        finally {
            $bodyGradient.Dispose()
        }

        $glowPath = [System.Drawing.Drawing2D.GraphicsPath]::new()
        $glowPath.AddEllipse(190, 25, 620, 390)
        $glowBrush = [System.Drawing.Drawing2D.PathGradientBrush]::new($glowPath)
        try {
            $glowBrush.CenterColor = $glowColor
            $glowBrush.SurroundColors = [System.Drawing.Color[]]@(
                [System.Drawing.Color]::FromArgb(0, $glowColor.R, $glowColor.G, $glowColor.B)
            )
            $graphics.FillPath($glowBrush, $glowPath)
        }
        finally {
            $glowBrush.Dispose()
            $glowPath.Dispose()
        }

        $circuitPen = [System.Drawing.Pen]::new($circuitColor, 3)
        $dotBrush = [System.Drawing.SolidBrush]::new($dotColor)
        try {
            foreach ($line in @(
                    @(195, 220, 260, 220, 295, 185, 390, 185),
                    @(175, 270, 260, 270, 300, 230, 390, 230),
                    @(215, 320, 280, 320, 320, 280, 400, 280),
                    @(805, 220, 740, 220, 705, 185, 610, 185),
                    @(825, 270, 740, 270, 700, 230, 610, 230),
                    @(785, 320, 720, 320, 680, 280, 600, 280)
                )) {
                $graphics.DrawLines(
                    $circuitPen,
                    [System.Drawing.Point[]]@(
                        [System.Drawing.Point]::new($line[0], $line[1]),
                        [System.Drawing.Point]::new($line[2], $line[3]),
                        [System.Drawing.Point]::new($line[4], $line[5]),
                        [System.Drawing.Point]::new($line[6], $line[7])
                    )
                )
                $graphics.FillEllipse($dotBrush, $line[0] - 7, $line[1] - 7, 14, 14)
            }

            foreach ($x in 320, 350, 650, 680) {
                foreach ($y in 135, 155, 345, 365) {
                    $graphics.FillEllipse($dotBrush, $x, $y, 5, 5)
                }
            }
        }
        finally {
            $circuitPen.Dispose()
            $dotBrush.Dispose()
        }

        Save-Png -Bitmap $bitmap -Name $Name
    }
    finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

function Draw-ActionIcon {
    param(
        [Parameter(Mandatory = $true)]
        [System.Drawing.Graphics]$Graphics,
        [Parameter(Mandatory = $true)]
        [string]$Kind,
        [Parameter(Mandatory = $true)]
        [int]$CenterX
    )

    $pen = [System.Drawing.Pen]::new(
        [System.Drawing.Color]::White,
        5
    )
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    try {
        if ($Kind -eq "run") {
            $playPath = [System.Drawing.Drawing2D.GraphicsPath]::new()
            $playPath.AddPolygon(
                [System.Drawing.Point[]]@(
                    [System.Drawing.Point]::new($CenterX - 11, 36),
                    [System.Drawing.Point]::new($CenterX - 11, 78),
                    [System.Drawing.Point]::new($CenterX + 22, 57)
                )
            )
            $playBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
            try {
                $Graphics.FillPath($playBrush, $playPath)
            }
            finally {
                $playBrush.Dispose()
                $playPath.Dispose()
            }
        }
        elseif ($Kind -eq "finish") {
            $Graphics.DrawLines(
                $pen,
                [System.Drawing.Point[]]@(
                    [System.Drawing.Point]::new($CenterX - 25, 57),
                    [System.Drawing.Point]::new($CenterX - 6, 76),
                    [System.Drawing.Point]::new($CenterX + 31, 36)
                )
            )
        }
        elseif ($Kind -eq "uninstall") {
            $Graphics.DrawRectangle($pen, $CenterX - 15, 45, 30, 36)
            $Graphics.DrawLine($pen, $CenterX - 20, 40, $CenterX + 20, 40)
            $Graphics.DrawLine($pen, $CenterX - 7, 32, $CenterX + 7, 32)
        }
        else {
            $Graphics.DrawLine($pen, $CenterX, 34, $CenterX, 60)
            $Graphics.DrawLines(
                $pen,
                [System.Drawing.Point[]]@(
                    [System.Drawing.Point]::new($CenterX - 12, 51),
                    [System.Drawing.Point]::new($CenterX, 63),
                    [System.Drawing.Point]::new($CenterX + 12, 51)
                )
            )
            $Graphics.DrawLines(
                $pen,
                [System.Drawing.Point[]]@(
                    [System.Drawing.Point]::new($CenterX - 20, 72),
                    [System.Drawing.Point]::new($CenterX - 20, 84),
                    [System.Drawing.Point]::new($CenterX + 20, 84),
                    [System.Drawing.Point]::new($CenterX + 20, 72)
                )
            )
        }
    }
    finally {
        $pen.Dispose()
    }
}

function New-ActionButton {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [string]$Text,
        [Parameter(Mandatory = $true)]
        [string]$Kind,
        [Parameter(Mandatory = $true)]
        [string]$FontFamily
    )

    $bitmap = [System.Drawing.Bitmap]::new(
        744,
        128,
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
    )
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
        $graphics.Clear([System.Drawing.Color]::Transparent)

        foreach ($shadow in @(
                @{ Y = 20; Alpha = 22 },
                @{ Y = 16; Alpha = 34 },
                @{ Y = 12; Alpha = 45 }
            )) {
            $shadowPath = New-RoundedPath `
                -Rectangle ([System.Drawing.RectangleF]::new(10, $shadow.Y, 724, 100)) `
                -Radius 24
            $shadowBrush = [System.Drawing.SolidBrush]::new(
                [System.Drawing.Color]::FromArgb($shadow.Alpha, 16, 70, 170)
            )
            try {
                $graphics.FillPath($shadowBrush, $shadowPath)
            }
            finally {
                $shadowBrush.Dispose()
                $shadowPath.Dispose()
            }
        }

        $buttonPath = New-RoundedPath `
            -Rectangle ([System.Drawing.RectangleF]::new(8, 4, 728, 104)) `
            -Radius 24
        $buttonBrush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
            [System.Drawing.Rectangle]::new(8, 4, 728, 104),
            [System.Drawing.ColorTranslator]::FromHtml("#37B6FF"),
            [System.Drawing.ColorTranslator]::FromHtml("#0956EA"),
            12
        )
        try {
            $graphics.FillPath($buttonBrush, $buttonPath)
        }
        finally {
            $buttonBrush.Dispose()
            $buttonPath.Dispose()
        }

        $font = [System.Drawing.Font]::new(
            $FontFamily,
            34,
            [System.Drawing.FontStyle]::Regular,
            [System.Drawing.GraphicsUnit]::Pixel
        )
        $textBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
        $format = [System.Drawing.StringFormat]::new()
        try {
            $format.Alignment = [System.Drawing.StringAlignment]::Center
            $format.LineAlignment = [System.Drawing.StringAlignment]::Center
            $textWidth = [Math]::Ceiling(
                $graphics.MeasureString($Text, $font).Width
            )
            $iconWidth = 44
            $gap = 22
            $groupWidth = $iconWidth + $gap + $textWidth
            $groupLeft = [Math]::Floor((744 - $groupWidth) / 2)
            $iconCenter = $groupLeft + [Math]::Floor($iconWidth / 2)
            Draw-ActionIcon `
                -Graphics $graphics `
                -Kind $Kind `
                -CenterX $iconCenter
            $graphics.DrawString(
                $Text,
                $font,
                $textBrush,
                [System.Drawing.RectangleF]::new(
                    $groupLeft + $iconWidth + $gap,
                    4,
                    $textWidth,
                    104
                ),
                $format
            )
        }
        finally {
            $format.Dispose()
            $textBrush.Dispose()
            $font.Dispose()
        }

        Save-Png -Bitmap $bitmap -Name $Name
    }
    finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

function New-CustomRow {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [string]$Text,
        [Parameter(Mandatory = $true)]
        [bool]$Expanded,
        [Parameter(Mandatory = $true)]
        [string]$FontFamily
    )

    $brand = [System.Drawing.ColorTranslator]::FromHtml("#1769E8")
    $lineColor = [System.Drawing.ColorTranslator]::FromHtml("#C9D9F0")
    $bitmap = [System.Drawing.Bitmap]::new(
        744,
        80,
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
    )
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
        $graphics.Clear([System.Drawing.Color]::Transparent)

        $linePen = [System.Drawing.Pen]::new($lineColor, 2)
        try {
            $graphics.DrawLine($linePen, 0, 40, 174, 40)
            $graphics.DrawLine($linePen, 570, 40, 744, 40)
        }
        finally {
            $linePen.Dispose()
        }

        $gearFont = [System.Drawing.Font]::new(
            "Segoe UI Symbol",
            31,
            [System.Drawing.FontStyle]::Regular,
            [System.Drawing.GraphicsUnit]::Pixel
        )
        $textFont = [System.Drawing.Font]::new(
            $FontFamily,
            28,
            [System.Drawing.FontStyle]::Regular,
            [System.Drawing.GraphicsUnit]::Pixel
        )
        $brush = [System.Drawing.SolidBrush]::new($brand)
        $format = [System.Drawing.StringFormat]::new()
        try {
            $format.Alignment = [System.Drawing.StringAlignment]::Center
            $format.LineAlignment = [System.Drawing.StringAlignment]::Center
            $graphics.DrawString(
                [char]0x2699,
                $gearFont,
                $brush,
                [System.Drawing.RectangleF]::new(196, 4, 58, 72),
                $format
            )
            $graphics.DrawString(
                $Text,
                $textFont,
                $brush,
                [System.Drawing.RectangleF]::new(250, 2, 270, 76),
                $format
            )
        }
        finally {
            $format.Dispose()
            $brush.Dispose()
            $textFont.Dispose()
            $gearFont.Dispose()
        }

        $chevronPen = [System.Drawing.Pen]::new($brand, 5)
        $chevronPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $chevronPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        try {
            if ($Expanded) {
                $graphics.DrawLines(
                    $chevronPen,
                    [System.Drawing.Point[]]@(
                        [System.Drawing.Point]::new(530, 47),
                        [System.Drawing.Point]::new(542, 35),
                        [System.Drawing.Point]::new(554, 47)
                    )
                )
            }
            else {
                $graphics.DrawLines(
                    $chevronPen,
                    [System.Drawing.Point[]]@(
                        [System.Drawing.Point]::new(530, 34),
                        [System.Drawing.Point]::new(542, 46),
                        [System.Drawing.Point]::new(554, 34)
                    )
                )
            }
        }
        finally {
            $chevronPen.Dispose()
        }

        Save-Png -Bitmap $bitmap -Name $Name
    }
    finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

function New-BrowseButton {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [string]$Text,
        [Parameter(Mandatory = $true)]
        [bool]$Dark,
        [Parameter(Mandatory = $true)]
        [string]$FontFamily
    )

    if ($Dark) {
        $surface = [System.Drawing.ColorTranslator]::FromHtml("#2A3C5B")
        $border = [System.Drawing.ColorTranslator]::FromHtml("#3D5680")
        $foreground = [System.Drawing.ColorTranslator]::FromHtml("#DCE9FF")
    }
    else {
        $surface = [System.Drawing.ColorTranslator]::FromHtml("#DDE9FF")
        $border = [System.Drawing.ColorTranslator]::FromHtml("#C7D9F7")
        $foreground = [System.Drawing.ColorTranslator]::FromHtml("#165FCF")
    }

    $bitmap = [System.Drawing.Bitmap]::new(
        172,
        64,
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
    )
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
        $graphics.Clear([System.Drawing.Color]::Transparent)

        $path = New-RoundedPath `
            -Rectangle ([System.Drawing.RectangleF]::new(1, 1, 170, 62)) `
            -Radius 14
        $surfaceBrush = [System.Drawing.SolidBrush]::new($surface)
        $borderPen = [System.Drawing.Pen]::new($border, 2)
        try {
            $graphics.FillPath($surfaceBrush, $path)
            $graphics.DrawPath($borderPen, $path)
        }
        finally {
            $borderPen.Dispose()
            $surfaceBrush.Dispose()
            $path.Dispose()
        }

        $font = [System.Drawing.Font]::new(
            $FontFamily,
            22,
            [System.Drawing.FontStyle]::Regular,
            [System.Drawing.GraphicsUnit]::Pixel
        )
        $brush = [System.Drawing.SolidBrush]::new($foreground)
        $format = [System.Drawing.StringFormat]::new()
        try {
            $format.Alignment = [System.Drawing.StringAlignment]::Center
            $format.LineAlignment = [System.Drawing.StringAlignment]::Center
            $graphics.DrawString(
                $Text,
                $font,
                $brush,
                [System.Drawing.RectangleF]::new(0, 0, 172, 64),
                $format
            )
        }
        finally {
            $format.Dispose()
            $brush.Dispose()
            $font.Dispose()
        }

        Save-Png -Bitmap $bitmap -Name $Name
    }
    finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

function New-CloseButton {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [bool]$Dark
    )

    $foreground = if ($Dark) {
        [System.Drawing.ColorTranslator]::FromHtml("#DCE9FF")
    }
    else {
        [System.Drawing.ColorTranslator]::FromHtml("#475569")
    }

    $bitmap = [System.Drawing.Bitmap]::new(
        68,
        68,
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
    )
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $pen = [System.Drawing.Pen]::new($foreground, 4)
        $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        try {
            $graphics.DrawLine($pen, 24, 24, 44, 44)
            $graphics.DrawLine($pen, 44, 24, 24, 44)
        }
        finally {
            $pen.Dispose()
        }

        Save-Png -Bitmap $bitmap -Name $Name
    }
    finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

New-InstallerBackground -Name "installer-background-light.png" -Dark $false
New-InstallerBackground -Name "installer-background-dark.png" -Dark $true
New-CloseButton -Name "close-light.png" -Dark $false
New-CloseButton -Name "close-dark.png" -Dark $true

$zhQuickInstall = ConvertFrom-Json '"\u5feb\u901f\u5b89\u88c5"'
$zhRepair = ConvertFrom-Json '"\u4fee\u590d\u5b89\u88c5"'
$zhUpdateTo = ConvertFrom-Json '"\u66f4\u65b0\u5230"'
$zhRun = ConvertFrom-Json '"\u8fd0\u884c vPaste"'
$zhUninstall = ConvertFrom-Json '"\u5378\u8f7d"'
$zhCustomInstall = ConvertFrom-Json '"\u81ea\u5b9a\u4e49\u5b89\u88c5"'
$zhHideOptions = ConvertFrom-Json '"\u6536\u8d77\u9009\u9879"'
$zhBrowse = ConvertFrom-Json '"\u6d4f\u89c8"'

$actions = @(
    @{ Name = "action-quick-zh.png"; Text = $zhQuickInstall; Kind = "install"; Font = "Microsoft YaHei UI" },
    @{ Name = "action-quick-en.png"; Text = "Quick Install"; Kind = "install"; Font = "Segoe UI" },
    @{ Name = "action-repair-zh.png"; Text = $zhRepair; Kind = "install"; Font = "Microsoft YaHei UI" },
    @{ Name = "action-repair-en.png"; Text = "Repair"; Kind = "install"; Font = "Segoe UI" },
    @{ Name = "action-update-zh.png"; Text = "$zhUpdateTo $Version"; Kind = "install"; Font = "Microsoft YaHei UI" },
    @{ Name = "action-update-en.png"; Text = "Update to $Version"; Kind = "install"; Font = "Segoe UI" },
    @{ Name = "action-finish-zh.png"; Text = $zhRun; Kind = "run"; Font = "Microsoft YaHei UI" },
    @{ Name = "action-finish-en.png"; Text = "Run vPaste"; Kind = "run"; Font = "Segoe UI" },
    @{ Name = "action-uninstall-zh.png"; Text = $zhUninstall; Kind = "uninstall"; Font = "Microsoft YaHei UI" },
    @{ Name = "action-uninstall-en.png"; Text = "Uninstall"; Kind = "uninstall"; Font = "Segoe UI" }
)
foreach ($action in $actions) {
    New-ActionButton `
        -Name $action.Name `
        -Text $action.Text `
        -Kind $action.Kind `
        -FontFamily $action.Font
}

New-CustomRow `
    -Name "custom-collapsed-zh.png" `
    -Text $zhCustomInstall `
    -Expanded $false `
    -FontFamily "Microsoft YaHei UI"
New-CustomRow `
    -Name "custom-expanded-zh.png" `
    -Text $zhHideOptions `
    -Expanded $true `
    -FontFamily "Microsoft YaHei UI"
New-CustomRow `
    -Name "custom-collapsed-en.png" `
    -Text "Custom Install" `
    -Expanded $false `
    -FontFamily "Segoe UI"
New-CustomRow `
    -Name "custom-expanded-en.png" `
    -Text "Hide Options" `
    -Expanded $true `
    -FontFamily "Segoe UI"

foreach ($dark in $false, $true) {
    $suffix = if ($dark) { "-dark" } else { "" }
    New-BrowseButton `
        -Name "browse-zh$suffix.png" `
        -Text $zhBrowse `
        -Dark $dark `
        -FontFamily "Microsoft YaHei UI"
    New-BrowseButton `
        -Name "browse-en$suffix.png" `
        -Text "Browse" `
        -Dark $dark `
        -FontFamily "Segoe UI"
}
