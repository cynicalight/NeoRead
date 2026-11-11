Attribute VB_Name = "NeoReadCiteTests"
Option Explicit

Private Sub Check(ByVal value As Boolean, ByVal message As String)
    If Not value Then Err.Raise vbObjectError + 900, "NeoReadCiteTests", message
End Sub

Private Function Op(ByVal encoded As String) As String
    Op = NeoReadCite.TestOperation("op" & vbTab & encoded)
End Function

Public Function RunIsolationTests() As String
    Dim a As Document, b As Document
    Dim fa As Field, fb As Field
    Dim ignored As String, failure As String, bText As String
    On Error GoTo Failed
    Set a = Documents.Add
    a.Content.Text = "A document text."
    Set fa = a.Fields.Add(a.Range(0, 0), wdFieldEmpty, "ADDIN READER_CITATION A", False)
    fa.Result.Text = "A"
    Set b = Documents.Add
    b.Content.Text = "B document text."
    Set fb = b.Fields.Add(b.Range(0, 0), wdFieldEmpty, "ADDIN NEOREAD_CITATION B", False)
    fb.Result.Text = "B"

    a.Activate
    a.Range(a.Content.End - 1, a.Content.End - 1).Select
    NeoReadCite.TestBind
    a.CustomDocumentProperties.Add Name:="READER_PREF_1", LinkToContent:=False, Type:=4, Value:="legacy-prefs"
    ignored = Op("Document.getState")
    Check InStr(ignored, "READER_CITATION A") > 0, "Legacy field code was normalized"
    Check InStr(ignored, "legacy-prefs") > 0, "Legacy preferences were not read"
    b.Activate
    bText = b.Content.Text
    ignored = Op("Document.updateFields" & vbLf & "field" & vbTab & "0" & vbLf & _
        "code" & vbTab & "NEOREAD_CITATION updated" & vbLf & "text" & vbLf & _
        "run" & vbTab & vbTab & "updated A" & vbLf & "end")
    Check InStr(fa.Code.Text, "updated") > 0, "A was not updated"
    Check InStr(fb.Code.Text, "NEOREAD_CITATION B") > 0, "B code was overwritten"
    Check b.Content.Text = bText, "B text was overwritten"

    ' Preferences must also stay on A while B is active.
    ignored = Op("Document.setData" & vbLf & "data" & vbTab & "original-document")
    Check a.CustomDocumentProperties("NEOREAD_PREF_1").Value = "original-document", "Preferences left A"
    Check b.CustomDocumentProperties.Count = 0, "Preferences were written to B"
    Check a.CustomDocumentProperties.Count = 1, "Legacy preferences were not removed"
    a.CustomDocumentProperties.Add Name:="READER_PREF_1", LinkToContent:=False, Type:=4, Value:="stale-prefs"
    ignored = Op("Document.getState")
    Check InStr(ignored, "original-document") > 0, "New preferences did not take precedence"
    Check InStr(ignored, "stale-prefs") = 0, "Legacy preferences were mixed into new preferences"

    ' Moving the cursor in A after starting must not move the insertion point.
    a.Activate
    Dim savedPosition As Long
    savedPosition = a.Content.End - 1
    a.Range(savedPosition, savedPosition).Select
    NeoReadCite.TestBind
    a.Range(0, 0).Select
    b.Activate
    ignored = Op("Document.insertField" & vbLf & "kind" & vbTab & "citation" & vbLf & "noteType" & vbTab & "0")
    Check a.Fields.Count = 2, "Citation was not inserted into A"
    Check a.Fields(2).Code.Start - 1 = savedPosition, "Insertion followed the changed cursor"
    Check b.Fields.Count = 1, "Citation was inserted into B"
    Check a.Fields(2).Result.Text = "{Citation}", "Placeholder was written outside the field"
    Check Not a.Fields(2).ShowCodes, "Inserted field shows its internal code"
    ignored = Op("Document.getState")
    ignored = Op("Document.updateFields" & vbLf & "field" & vbTab & "1" & vbLf & _
        "code" & vbTab & "NEOREAD_CITATION result-test" & vbLf & "text" & vbLf & _
        "run" & vbTab & vbTab & "[1]" & vbLf & "end")
    Check a.Fields(2).Result.Text = "[1]", "Citation result was written outside the field"
    Check InStr(a.Content.Text, "{Citation}") = 0, "Placeholder leaked into document text"
    ignored = Op("Document.getState")
    Check InStr(ignored, """text"":""[1]""") > 0, "State lost the written citation text"
    ignored = Op("Document.updateFields" & vbLf & "field" & vbTab & "1" & vbLf & _
        "text" & vbLf & "run" & vbTab & vbTab & "[2]" & vbLf & "end")
    Check a.Fields(2).Result.Text = "[2]", "Refresh did not replace the citation result"
    Check InStr(a.Content.Text, "[1]") = 0, "Previous citation leaked into document text"
    ignored = Op("Document.getState")
    Check InStr(ignored, """text"":""[2]""") > 0, "State lost the refreshed citation text"

    ignored = Op("Document.getState")
    b.Activate
    ignored = Op("Document.removeFields" & vbLf & "keepText" & vbTab & "0" & vbLf & "index" & vbTab & "1")
    Check a.Fields.Count = 1, "A field was not removed"
    Check b.Fields.Count = 1, "B field was removed"

    ' Closing A must reject writes, without falling back to B.
    a.Close wdDoNotSaveChanges
    Set a = Nothing
    b.Activate
    On Error Resume Next
    ignored = Op("Document.setData" & vbLf & "data" & vbTab & "must-not-write")
    failure = Err.Description
    Err.Clear
    On Error GoTo Failed
    Check Len(failure) > 0, "Closed document was accepted"
    Check b.CustomDocumentProperties.Count = 0, "Closed A redirected writes to B"
    b.Close wdDoNotSaveChanges
    RunIsolationTests = "PASS: update, preferences, captured insertion, removal, closed document"
    Exit Function
Failed:
    failure = Err.Description
    On Error Resume Next
    If Not a Is Nothing Then a.Close wdDoNotSaveChanges
    If Not b Is Nothing Then b.Close wdDoNotSaveChanges
    On Error GoTo 0
    RunIsolationTests = "FAIL: " & failure
End Function
