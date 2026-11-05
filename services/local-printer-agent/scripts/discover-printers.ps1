# Inklink local printer agent — printer discovery (Windows).
#
# Emits a single JSON object to stdout: { printers: [...], defaultPrinter: name|null }.
# Run as a FILE (never inline) so $_ is not mangled by shell quoting.
#
# Fields per printer are REAL values read from the Windows print subsystem.
# Capabilities we cannot reliably determine (e.g. duplex support) are reported
# as null ("unknown"), never fabricated.

$ErrorActionPreference = 'Stop'

function Map-Status([int]$printerStatus, [bool]$workOffline) {
    # Win32_Printer.PrinterStatus: 1=Other,2=Unknown,3=Idle,4=Printing,5=Warmup,
    # 6=Stopped Printing,7=Offline. WorkOffline true => offline regardless.
    if ($workOffline) { return 'offline' }
    switch ($printerStatus) {
        3 { return 'online' }
        4 { return 'online' }
        5 { return 'online' }
        7 { return 'offline' }
        default { return 'unknown' }
    }
}

$cim = @{}
foreach ($p in (Get-CimInstance Win32_Printer)) {
    $cim[$p.Name] = $p
}

$default = (Get-CimInstance Win32_Printer -Filter 'Default = True' | Select-Object -First 1)
$defaultName = if ($default) { $default.Name } else { $null }

$list = @()
foreach ($pr in (Get-Printer)) {
    $w = $cim[$pr.Name]
    $workOffline = if ($w) { [bool]$w.WorkOffline } else { $false }
    $pstatus = if ($w) { [int]$w.PrinterStatus } else { 2 }

    # Supported capabilities: we only assert what we can read. PaperSizes come
    # from the driver when available; duplex/color support is NOT reliably
    # queryable here, so we report null (unknown) rather than guessing.
    $papers = $null
    try {
        $caps = Get-PrinterProperty -PrinterName $pr.Name -ErrorAction SilentlyContinue
    } catch { $caps = $null }

    $list += [pscustomobject]@{
        id              = $pr.Name          # printer name is the stable id on Windows
        name            = $pr.Name
        driver          = $pr.DriverName
        port            = $pr.PortName
        status          = (Map-Status $pstatus $workOffline)
        isDefault       = ($pr.Name -eq $defaultName)
        # Capabilities we cannot confirm are explicitly unknown (null).
        supportsColor   = $null
        supportsDuplex  = $null
        paperSizes      = $papers
    }
}

[pscustomobject]@{
    printers       = $list
    defaultPrinter = $defaultName
} | ConvertTo-Json -Depth 5 -Compress
