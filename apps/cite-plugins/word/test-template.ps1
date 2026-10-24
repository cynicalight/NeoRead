# Runs document-isolation regression tests in a separate Word instance.
# Requires the same VBA project access as build-template.ps1.
param([string]$Source = (Join-Path $PSScriptRoot "ReaderCite.bas"))
$ErrorActionPreference = "Stop"
$work = Join-Path ([IO.Path]::GetTempPath()) ("neoread-word-test-" + [Guid]::NewGuid())
$null = New-Item -ItemType Directory $work
try {
  $sourceText = [IO.File]::ReadAllText($Source)
  # Test wrappers expose private operations only in this unsaved test project.
  $bind = if ($sourceText.Contains("Private Sub BindDocument()")) { "BindDocument" } else { "' Legacy module has no document binding." }
  $sourceText += @"

Public Sub TestBind()
    $bind
End Sub
Public Function TestOperation(ByVal encoded As String) As String
    Dim failure As String
    TestOperation = ExecuteOperation(encoded, failure)
    If Len(failure) > 0 Then Err.Raise vbObjectError + 902, "ReaderCiteTests", failure
End Function
"@
  $module = Join-Path $work "ReaderCite.bas"
  $sourceText = [regex]::Replace($sourceText, "\r?\n", "`r`n")
  [IO.File]::WriteAllText($module, $sourceText, [Text.Encoding]::ASCII)
  # IDispatch avoids broken Office interop registrations left by other suites.
  $runner = Join-Path $work "run.vbs"
  [IO.File]::WriteAllText($runner, @'
On Error Resume Next
Set word = CreateObject("Word.Application")
word.Visible = False
word.DisplayAlerts = 0
Set doc = word.Documents.Add()
If Err.Number = 0 Then Set component = doc.VBProject.VBComponents.Import(WScript.Arguments(0))
If Err.Number = 0 Then Set component = doc.VBProject.VBComponents.Import(WScript.Arguments(1))
If Err.Number = 0 Then result = word.Run("ReaderCiteTests.RunIsolationTests")
failure = Err.Description
code = Err.Number
On Error Resume Next
doc.Close 0
word.Quit 0
If code <> 0 Then
  WScript.Echo "FAIL: " & failure
  WScript.Quit 1
End If
WScript.Echo result
If Left(result, 5) <> "PASS:" Then WScript.Quit 1
'@, [Text.Encoding]::ASCII)
  & cscript.exe //nologo $runner $module (Join-Path $PSScriptRoot "ReaderCiteTests.bas")
  if ($LASTEXITCODE -ne 0) { throw "Word document-isolation regression failed." }
} finally {
  Remove-Item -Recurse -Force $work
}
