# Builds Reader.dotm from ReaderCite.bas and customUI14.xml with Word for Windows.
# Requires Word and, in Word, File > Options > Trust Center > Trust Center
# Settings > Macro Settings > "Trust access to the VBA project object model".
param([string]$Output = (Join-Path $PSScriptRoot "Reader.dotm"))
$ErrorActionPreference = "Stop"
$module = Join-Path $PSScriptRoot "ReaderCite.bas"
$ribbon = Join-Path $PSScriptRoot "customUI14.xml"
if (Test-Path $Output) { Remove-Item $Output }

$word = New-Object -ComObject Word.Application
try {
  $doc = $word.Documents.Add()
  $null = $doc.VBProject.VBComponents.Import($module)
  # 15 = wdFormatXMLTemplateMacroEnabled
  $doc.SaveAs2([ref]$Output, [ref]15)
  $doc.Close([ref]0)
} finally {
  $word.Quit([ref]0)
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($word)
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($Output, "Update")
try {
  $null = [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $ribbon, "customUI/customUI14.xml")
  $rels = $zip.GetEntry("_rels/.rels")
  $reader = New-Object System.IO.StreamReader($rels.Open())
  $xml = $reader.ReadToEnd()
  $reader.Close()
  $relation = '<Relationship Id="readerRibbon" Type="http://schemas.microsoft.com/office/2007/relationships/ui/extensibility" Target="customUI/customUI14.xml"/>'
  $xml = $xml.Replace("</Relationships>", "$relation</Relationships>")
  $rels.Delete()
  $writer = New-Object System.IO.StreamWriter($zip.CreateEntry("_rels/.rels").Open(), (New-Object System.Text.UTF8Encoding($false)))
  $writer.Write($xml)
  $writer.Close()
} finally {
  $zip.Dispose()
}
Write-Host "Built $Output"
