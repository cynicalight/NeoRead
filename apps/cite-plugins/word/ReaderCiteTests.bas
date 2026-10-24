Attribute VB_Name = "ReaderCiteTests"
Option Explicit

Private Sub Check(ByVal value As Boolean, ByVal message As String)
    If Not value Then Err.Raise vbObjectError + 900, "ReaderCiteTests", message
End Sub

Private Function Op(ByVal encoded As String) As String
    Op = ReaderCite.TestOperation("op" & vbTab & encoded)
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
    Set fb = b.Fields.Add(b.Range(0, 0), wdFieldEmpty, "ADDIN READER_CITATION B", False)
    fb.Result.Text = "B"

    a.Activate
    a.Range(a.Content.End - 1, a.Content.End - 1).Select
    ReaderCite.TestBind
    ignored = Op("Document.getState")
    b.Activate
    bText = b.Content.Text
    ignored = Op("Document.updateFields" & vbLf & "field" & vbTab & "0" & vbLf & _
        "code" & vbTab & "READER_CITATION updated" & vbLf & "text" & vbLf & _
        "run" & vbTab & vbTab & "updated A" & vbLf & "end")
    Check InStr(fa.Code.Text, "updated") > 0, "A was not updated"
    Check InStr(fb.Code.Text, "READER_CITATION B") > 0, "B code was overwritten"
    Check b.Content.Text = bText, "B text was overwritten"

    ' Preferences must also stay on A while B is active.
    ignored = Op("Document.setData" & vbLf & "data" & vbTab & "original-document")
    Check a.CustomDocumentProperties("READER_PREF_1").Value = "original-document", "Preferences left A"
    Check b.CustomDocumentProperties.Count = 0, "Preferences were written to B"

    ' Moving the cursor in A after starting must not move the insertion point.
    a.Activate
    Dim savedPosition As Long
    savedPosition = a.Content.End - 1
    a.Range(savedPosition, savedPosition).Select
    ReaderCite.TestBind
    a.Range(0, 0).Select
    b.Activate
    ignored = Op("Document.insertField" & vbLf & "kind" & vbTab & "citation" & vbLf & "noteType" & vbTab & "0")
    Check a.Fields.Count = 2, "Citation was not inserted into A"
    Check a.Fields(2).Code.Start - 1 = savedPosition, "Insertion followed the changed cursor"
    Check b.Fields.Count = 1, "Citation was inserted into B"

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
