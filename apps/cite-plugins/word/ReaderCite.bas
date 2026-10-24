Attribute VB_Name = "ReaderCite"
' Reader citation plugin for Microsoft Word on Windows and macOS.
'
' A ribbon button sends a command to Reader. Reader answers with document
' operations, one at a time, until it completes the command; this module only
' executes them. Keep the operations in step with
' apps/cite-plugins/wps/js/word-document.js and the line format in
' apps/web/src/cite/vba.ts.
'
' This file stays ASCII: Word reads VBA modules in the system code page, so
' Chinese messages are written as \u escapes and decoded by T().
Option Explicit

#If Mac Then
#ElseIf VBA7 Then
Private Declare PtrSafe Sub Sleep Lib "kernel32" (ByVal milliseconds As Long)
#Else
Private Declare Sub Sleep Lib "kernel32" (ByVal milliseconds As Long)
#End If

Private Const BASE_URL As String = "http://127.0.0.1:17841"
Private Const READER_PREFIX As String = "READER_"
Private Const PREF_PREFIX As String = "READER_PREF_"
Private Const PREF_CHUNK As Long = 255
Private Const STYLE_BIBLIOGRAPHY As Long = -266
Private Const PROPERTY_STRING As Long = 4

Private mDocument As Document
Private mSelection As Range
Private mRunning As Boolean
Private mCount As Long
Private mFields() As Variant
Private mCodes() As String
Private mNotes() As Long
Private mAnchors() As Long
Private mOffsets() As Long

' ---------------------------------------------------------------- commands

Public Sub ReaderCiteAction(control As Object)
    RunCommand control.ID
End Sub

Public Sub ReaderAddEditCitation()
    RunCommand "addEditCitation"
End Sub

Public Sub ReaderAddEditBibliography()
    RunCommand "addEditBibliography"
End Sub

Public Sub ReaderRefresh()
    RunCommand "refresh"
End Sub

Public Sub ReaderDocumentPreferences()
    RunCommand "setDocPrefs"
End Sub

Public Sub ReaderUnlinkCitations()
    RunCommand "removeCodes"
End Sub

Private Sub RunCommand(ByVal command As String)
    If mRunning Then Exit Sub
    If Documents.Count = 0 Then
        Notify T("\u8bf7\u5148\u6253\u5f00\u4e00\u4efd\u6587\u6863\u3002"), vbInformation
        Exit Sub
    End If
    mRunning = True
    On Error GoTo Failed
    BindDocument
    Dim reply As String
    Dim opName As String
    Dim transaction As String
    Dim failure As String
    Dim result As String
    reply = Post("/v1/cite/execCommand", "{""command"":" & Q(command) & _
        ",""documentId"":" & Q(mDocument.FullName) & _
        ",""client"":" & Q(ClientName()) & "}")
    Do
        opName = JsonString(reply, "op")
        transaction = JsonString(reply, "transaction")
        If opName = "Document.complete" Or Len(opName) = 0 Then Exit Do
        If opName = "Document.wait" Then
            ' Reader is waiting for the user; ask again.
            reply = Post("/v1/cite/next", "{""transaction"":" & Q(transaction) & "}")
        Else
            failure = ""
            result = ExecuteOperation(JsonString(reply, "vba"), failure)
            If Len(failure) > 0 Then
                reply = Post("/v1/cite/respond", "{""transaction"":" & Q(transaction) & _
                    ",""error"":" & Q(failure) & "}")
            Else
                reply = Post("/v1/cite/respond", "{""transaction"":" & Q(transaction) & _
                    ",""result"":" & result & "}")
            End If
        End If
    Loop
    mRunning = False
    If JsonBool(reply, "activate") Then ActivateWord
    Set mDocument = Nothing
    Set mSelection = Nothing
    If Len(JsonString(reply, "error")) > 0 Then Notify JsonString(reply, "error"), vbExclamation
    Exit Sub
Failed:
    mRunning = False
    Set mDocument = Nothing
    Set mSelection = Nothing
    Notify Err.Description, vbExclamation
End Sub

' Keep the document and insertion range stable while HTTP yields to Word.
Private Sub BindDocument()
    Set mDocument = ActiveDocument
    Set mSelection = Selection.Range.Duplicate
    mCount = 0
End Sub

Private Sub EnsureDocumentOpen()
    Dim doc As Document
    For Each doc In Documents
        If doc Is mDocument Then Exit Sub
    Next
    Err.Raise vbObjectError + 517, "Reader", T("\u539f\u6587\u6863\u5df2\u5173\u95ed\uff0c\u672c\u6b21\u5f15\u7528\u64cd\u4f5c\u5df2\u53d6\u6d88\u3002")
End Sub

' Indexes refer to the fields returned by getState, never to the active window.
Private Sub ValidateFields()
    EnsureDocumentOpen
    Dim i As Long
    For i = 1 To mCount
        If Not (mFields(i).Code.Document Is mDocument) Then
            Err.Raise vbObjectError + 518, "Reader", T("\u6587\u6863\u4e2d\u7684\u5f15\u6ce8\u5df2\u6539\u53d8\uff0c\u8bf7\u91cd\u8bd5\u3002")
        End If
        If ReaderCode(mFields(i).Code.Text) <> mCodes(i) Then
            Err.Raise vbObjectError + 518, "Reader", T("\u6587\u6863\u4e2d\u7684\u5f15\u6ce8\u5df2\u6539\u53d8\uff0c\u8bf7\u91cd\u8bd5\u3002")
        End If
    Next
End Sub

Private Function ExecuteOperation(ByVal encoded As String, ByRef failure As String) As String
    On Error GoTo Failed
    EnsureDocumentOpen
    If Len(encoded) = 0 Then
        failure = T("\u63d2\u4ef6\u7248\u672c\u8fc7\u65e7\uff0c\u8bf7\u5728 Reader \u8bbe\u7f6e\u4e2d\u91cd\u65b0\u5b89\u88c5 Word \u63d2\u4ef6\u3002")
        Exit Function
    End If
    Dim lines() As String
    lines = Split(encoded, vbLf)
    Select Case Part(lines(0), 1)
    Case "Document.getState"
        ExecuteOperation = GetState()
    Case "Document.insertField"
        ExecuteOperation = InsertField(lines)
    Case "Document.updateFields"
        UpdateFields lines
        ExecuteOperation = "{}"
    Case "Document.removeFields"
        RemoveFields lines
        ExecuteOperation = "{}"
    Case "Document.setData"
        SetData lines
        ExecuteOperation = "{}"
    Case Else
        failure = T("\u63d2\u4ef6\u7248\u672c\u8fc7\u65e7\uff0c\u8bf7\u5728 Reader \u8bbe\u7f6e\u4e2d\u91cd\u65b0\u5b89\u88c5 Word \u63d2\u4ef6\u3002")
    End Select
    Exit Function
Failed:
    failure = Err.Description
    If Len(failure) = 0 Then failure = T("\u6587\u6863\u64cd\u4f5c\u5931\u8d25\u3002")
End Function

' -------------------------------------------------------------- operations

Private Function GetState() As String
    CollectFields
    Dim parts() As String
    Dim i As Long
    Dim f As Object
    Dim cursor As String
    Dim before As Long
    Dim anchor As Long
    anchor = SelectionAnchor()
    cursor = "null"
    ReDim parts(0 To IIf(mCount > 0, mCount - 1, 0))
    For i = 1 To mCount
        Set f = mFields(i)
        parts(i - 1) = "{""code"":" & Q(mCodes(i)) & ",""text"":" & Q(f.Result.Text) & _
            ",""noteIndex"":" & mNotes(i) & "}"
        If f.Result.StoryType = mSelection.StoryType And f.Code.Start - 1 <= mSelection.Start _
            And mSelection.End <= f.Result.End + 1 Then cursor = CStr(i - 1)
        If mAnchors(i) < anchor Then before = before + 1
    Next
    Dim list As String
    If mCount > 0 Then list = Join(parts, ",")
    GetState = "{""fields"":[" & list & "],""cursor"":" & cursor & _
        ",""fieldsBefore"":" & before & ",""data"":" & Q(ReadData()) & _
        ",""canInsert"":" & IIf(mDocument.ReadOnly, "false", "true") & "}"
End Function

Private Function InsertField(lines() As String) As String
    Dim kind As String
    Dim noteType As Long
    Dim i As Long
    For i = 1 To UBound(lines)
        Select Case Part(lines(i), 0)
        Case "kind"
            kind = Part(lines(i), 1)
        Case "noteType"
            noteType = CLng(Val(Part(lines(i), 1)))
        End Select
    Next
    Dim target As Range
    Set target = mSelection.Duplicate
    target.Collapse wdCollapseEnd
    Dim note As Object
    If noteType = 1 Then
        Set note = mDocument.Footnotes.Add(Range:=target)
        Set target = note.Range
    ElseIf noteType = 2 Then
        Set note = mDocument.Endnotes.Add(Range:=target)
        Set target = note.Range
    End If
    Dim f As Field
    Set f = mDocument.Fields.Add(Range:=target, Type:=wdFieldEmpty, _
        Text:="ADDIN READER_TEMP", PreserveFormatting:=False)
    If kind = "bibliography" Then
        f.Result.Text = "{Bibliography}"
    Else
        f.Result.Text = "{Citation}"
    End If
    ' Continue typing after the citation, or after its note reference.
    If note Is Nothing Then
        f.Select
    Else
        note.Reference.Select
    End If
    Selection.Collapse wdCollapseEnd
    Set mSelection = Selection.Range.Duplicate
    CollectFields
    For i = 1 To mCount
        If mCodes(i) = "READER_TEMP" Then
            InsertField = "{""index"":" & (i - 1) & "}"
            Exit Function
        End If
    Next
    Err.Raise vbObjectError + 515, "Reader", T("\u63d2\u5165\u7684\u57df\u6ca1\u6709\u51fa\u73b0\u5728\u6587\u6863\u4e2d\u3002")
End Function

Private Sub UpdateFields(lines() As String)
    ValidateFields
    Dim i As Long
    Dim index As Long
    Dim f As Object
    Dim mode As String
    Dim texts() As String
    Dim flags() As String
    Dim count As Long
    Dim hanging As Boolean
    Dim align As String
    Dim maxOffset As Double
    Dim lineSpacing As Double
    Dim entrySpacing As Double
    Dim result As Range
    For i = 1 To UBound(lines)
        Select Case Part(lines(i), 0)
        Case "field"
            index = CLng(Val(Part(lines(i), 1))) + 1
            If index < 1 Or index > mCount Then
                Err.Raise vbObjectError + 516, "Reader", T("\u6587\u6863\u4e2d\u7684\u5f15\u6ce8\u5df2\u6539\u53d8\uff0c\u8bf7\u91cd\u8bd5\u3002")
            End If
            Set f = mFields(index)
            mode = ""
            count = 0
        Case "code"
            f.Code.Text = " ADDIN " & Part(lines(i), 1) & " "
        Case "text"
            mode = "text"
        Case "bibliography"
            mode = "bibliography"
            hanging = Part(lines(i), 1) = "1"
            align = Part(lines(i), 2)
            maxOffset = Val(Part(lines(i), 3))
            lineSpacing = Val(Part(lines(i), 4))
            entrySpacing = Val(Part(lines(i), 5))
        Case "para"
            AddRun texts, flags, count, "", vbCr
        Case "run"
            AddRun texts, flags, count, Part(lines(i), 1), Part(lines(i), 2)
        Case "end"
            If Len(mode) > 0 Then
                Set result = WriteRuns(f, texts, flags, count)
                If mode = "bibliography" Then
                    FormatBibliography result, hanging, align, maxOffset, lineSpacing, entrySpacing
                End If
            End If
            mode = ""
            count = 0
        End Select
    Next
End Sub

Private Sub RemoveFields(lines() As String)
    ValidateFields
    Dim keepText As Boolean
    Dim i As Long
    Dim index As Long
    ' Reader lists the indexes from the last field, so earlier ones stay valid.
    For i = 1 To UBound(lines)
        Select Case Part(lines(i), 0)
        Case "keepText"
            keepText = Part(lines(i), 1) = "1"
        Case "index"
            index = CLng(Val(Part(lines(i), 1))) + 1
            If index >= 1 And index <= mCount Then
                If keepText Then
                    mFields(index).Unlink
                Else
                    mFields(index).Delete
                End If
            End If
        End Select
    Next
End Sub

Private Sub SetData(lines() As String)
    Dim data As String
    Dim i As Long
    For i = 1 To UBound(lines)
        If Part(lines(i), 0) = "data" Then data = Part(lines(i), 1)
    Next
    Dim props As Object
    Set props = mDocument.CustomDocumentProperties
    For i = props.Count To 1 Step -1
        If Left$(props(i).Name, Len(PREF_PREFIX)) = PREF_PREFIX Then props(i).Delete
    Next
    ' A document property holds at most 255 characters.
    i = 0
    Do While i * PREF_CHUNK < Len(data)
        props.Add Name:=PREF_PREFIX & (i + 1), LinkToContent:=False, _
            Type:=PROPERTY_STRING, Value:=Mid$(data, i * PREF_CHUNK + 1, PREF_CHUNK)
        i = i + 1
    Loop
End Sub

Private Function ReadData() As String
    Dim props As Object
    Dim i As Long
    Dim out As String
    Set props = mDocument.CustomDocumentProperties
    On Error GoTo Done
    i = 1
    Do
        out = out & props(PREF_PREFIX & i).Value
        i = i + 1
    Loop
Done:
    ReadData = out
End Function

' ----------------------------------------------------------------- fields

' Reader fields in reading order; fields in notes sort by their reference.
Private Sub CollectFields()
    mCount = 0
    ReDim mFields(1 To 1)
    ReDim mCodes(1 To 1)
    ReDim mNotes(1 To 1)
    ReDim mAnchors(1 To 1)
    ReDim mOffsets(1 To 1)
    Dim f As Field
    For Each f In mDocument.Fields
        AddField f, 0, f.Code.Start
    Next
    Dim footNote As Footnote
    For Each footNote In mDocument.Footnotes
        For Each f In footNote.Range.Fields
            AddField f, footNote.Index, footNote.Reference.Start
        Next
    Next
    Dim lastNote As Endnote
    For Each lastNote In mDocument.Endnotes
        For Each f In lastNote.Range.Fields
            AddField f, lastNote.Index, lastNote.Reference.Start
        Next
    Next
    Dim i As Long
    Dim j As Long
    For i = 2 To mCount
        j = i
        Do While j > 1
            If mAnchors(j - 1) < mAnchors(j) Then Exit Do
            If mAnchors(j - 1) = mAnchors(j) And mOffsets(j - 1) <= mOffsets(j) Then Exit Do
            SwapFields j - 1, j
            j = j - 1
        Loop
    Next
End Sub

Private Sub AddField(ByVal f As Object, ByVal noteIndex As Long, ByVal anchor As Long)
    Dim code As String
    code = ReaderCode(f.Code.Text)
    If Len(code) = 0 Then Exit Sub
    mCount = mCount + 1
    ReDim Preserve mFields(1 To mCount)
    ReDim Preserve mCodes(1 To mCount)
    ReDim Preserve mNotes(1 To mCount)
    ReDim Preserve mAnchors(1 To mCount)
    ReDim Preserve mOffsets(1 To mCount)
    Set mFields(mCount) = f
    mCodes(mCount) = code
    mNotes(mCount) = noteIndex
    mAnchors(mCount) = anchor
    mOffsets(mCount) = f.Code.Start
End Sub

Private Sub SwapFields(ByVal a As Long, ByVal b As Long)
    Dim f As Object
    Dim text As String
    Dim number As Long
    Set f = mFields(a): Set mFields(a) = mFields(b): Set mFields(b) = f
    text = mCodes(a): mCodes(a) = mCodes(b): mCodes(b) = text
    number = mNotes(a): mNotes(a) = mNotes(b): mNotes(b) = number
    number = mAnchors(a): mAnchors(a) = mAnchors(b): mAnchors(b) = number
    number = mOffsets(a): mOffsets(a) = mOffsets(b): mOffsets(b) = number
End Sub

' " ADDIN READER_CITATION {...} " -> "READER_CITATION {...}"; "" for others.
Private Function ReaderCode(ByVal text As String) As String
    text = Trim$(text)
    If UCase$(Left$(text, 6)) = "ADDIN " Then text = Trim$(Mid$(text, 7))
    If Left$(text, Len(READER_PREFIX)) = READER_PREFIX Then ReaderCode = text
End Function

' Main-text position of the selection; inside a note, its reference.
Private Function SelectionAnchor() As Long
    SelectionAnchor = mSelection.Start
    If mSelection.StoryType = wdMainTextStory Then Exit Function
    Dim footNote As Footnote
    For Each footNote In mDocument.Footnotes
        If InNote(footNote.Range) Then
            SelectionAnchor = footNote.Reference.Start
            Exit Function
        End If
    Next
    Dim lastNote As Endnote
    For Each lastNote In mDocument.Endnotes
        If InNote(lastNote.Range) Then
            SelectionAnchor = lastNote.Reference.Start
            Exit Function
        End If
    Next
End Function

Private Function InNote(ByVal note As Range) As Boolean
    InNote = note.StoryType = mSelection.StoryType And note.Start <= mSelection.Start _
        And mSelection.End <= note.End
End Function

Private Sub AddRun(texts() As String, flags() As String, count As Long, _
    ByVal flag As String, ByVal text As String)
    count = count + 1
    ReDim Preserve texts(1 To count)
    ReDim Preserve flags(1 To count)
    texts(count) = text
    flags(count) = flag
End Sub

' Writes the runs as the field result, then formats each run in place.
' Flags: i italic, b bold, u underline, ^ superscript, _ subscript, c small caps.
Private Function WriteRuns(ByVal f As Object, texts() As String, flags() As String, _
    ByVal count As Long) As Range
    Dim i As Long
    Dim full As String
    Dim pieces() As String
    If count > 0 Then
        ReDim pieces(1 To count)
        For i = 1 To count
            pieces(i) = texts(i)
        Next
        full = Join(pieces, "")
    End If
    f.Result.Text = full
    Dim result As Range
    Set result = f.Result
    With result.Font
        .Italic = False
        .Bold = False
        .Underline = wdUnderlineNone
        .Superscript = False
        .Subscript = False
        .SmallCaps = False
    End With
    Dim offset As Long
    Dim piece As Range
    offset = result.Start
    For i = 1 To count
        If Len(flags(i)) > 0 And Len(texts(i)) > 0 Then
            Set piece = result.Duplicate
            piece.SetRange offset, offset + Len(texts(i))
            If InStr(flags(i), "i") > 0 Then piece.Font.Italic = True
            If InStr(flags(i), "b") > 0 Then piece.Font.Bold = True
            If InStr(flags(i), "u") > 0 Then piece.Font.Underline = wdUnderlineSingle
            If InStr(flags(i), "^") > 0 Then piece.Font.Superscript = True
            If InStr(flags(i), "_") > 0 Then piece.Font.Subscript = True
            If InStr(flags(i), "c") > 0 Then piece.Font.SmallCaps = True
        End If
        offset = offset + Len(texts(i))
    Next
    Set WriteRuns = result
End Function

Private Sub FormatBibliography(ByVal result As Range, ByVal hanging As Boolean, _
    ByVal align As String, ByVal maxOffset As Double, ByVal lineSpacing As Double, _
    ByVal entrySpacing As Double)
    On Error Resume Next
    ' Documents without the built-in style keep their paragraph style.
    result.Style = mDocument.Styles(STYLE_BIBLIOGRAPHY)
    On Error GoTo 0
    Dim size As Single
    Dim indent As Single
    size = result.Font.Size
    If size <= 0 Or size > 100 Then size = 10.5
    With result.ParagraphFormat
        If align = "flush" Or align = "margin" Then
            If maxOffset < 1 Then maxOffset = 1
            indent = maxOffset * size * 0.55 + size
            .TabStops.ClearAll
            .TabStops.Add Position:=indent
            .LeftIndent = indent
            .FirstLineIndent = -indent
        ElseIf hanging Then
            .LeftIndent = size * 2
            .FirstLineIndent = -size * 2
        Else
            .LeftIndent = 0
            .FirstLineIndent = 0
        End If
        If lineSpacing > 0 And lineSpacing <> 1 Then
            .LineSpacingRule = wdLineSpaceMultiple
            .LineSpacing = LinesToPoints(lineSpacing)
        End If
        .SpaceAfter = size * entrySpacing
    End With
End Sub

' ---------------------------------------------------------------- transport

Private Function ClientName() As String
#If Mac Then
    ClientName = "word-mac"
#Else
    ClientName = "word-windows"
#End If
End Function

Private Function Post(ByVal path As String, ByVal body As String) As String
    Dim status As Long
    Dim text As String
#If Mac Then
    ' Word is sandboxed on macOS; ReaderCite.scpt sends the request and
    ' appends the HTTP status as the last line.
    Dim raw As String
    Dim cut As Long
    raw = AppleScriptTask("ReaderCite.scpt", "post", path & vbLf & body)
    cut = InStrRev(raw, vbLf)
    If cut > 0 Then
        status = CLng(Val(Mid$(raw, cut + 1)))
        text = Left$(raw, cut - 1)
    End If
#Else
    text = WindowsPost(path, body, status)
#End If
    If status = 200 Then
        Post = text
        Exit Function
    End If
    If status = 0 Then Err.Raise vbObjectError + 513, "Reader", Unreachable()
    Dim message As String
    message = JsonString(text, "error")
    If Len(message) = 0 Then message = T("Reader \u8fd4\u56de\u4e86\u9519\u8bef ") & status
    Err.Raise vbObjectError + 514, "Reader", message
End Function

#If Mac Then
#Else
Private Function WindowsPost(ByVal path As String, ByVal body As String, ByRef status As Long) As String
    On Error GoTo Failed
    Dim http As Object
    Set http = CreateObject("MSXML2.XMLHTTP.6.0")
    http.Open "POST", BASE_URL & path, True
    http.setRequestHeader "Content-Type", "application/json; charset=utf-8"
    http.setRequestHeader "Authorization", "Bearer " & Credential()
    http.send body
    ' Keep Word responsive while Reader shows a dialog.
    Do While http.readyState <> 4
        DoEvents
        Sleep 15
    Loop
    status = http.Status
    ' WinINet reports connection failures as 12000-12999.
    If status >= 12000 Then status = 0
    WindowsPost = http.responseText
    Exit Function
Failed:
    status = 0
End Function

' Reader writes a new credential here each time it starts.
Private Function Credential() As String
    Dim path As String
    Dim handle As Integer
    Dim value As String
    path = Environ$("APPDATA") & "\Reader\cite-credential"
    If Len(Dir$(path)) = 0 Then Exit Function
    handle = FreeFile
    Open path For Input As #handle
    Line Input #handle, value
    Close #handle
    Credential = Trim$(value)
End Function
#End If

Private Function Unreachable() As String
    Unreachable = T("\u65e0\u6cd5\u8fde\u63a5 Reader\u3002\u8bf7\u5148\u542f\u52a8 Reader \u684c\u9762\u7248\uff0c\u518d\u91cd\u8bd5\u3002")
End Function

Private Sub ActivateWord()
    On Error Resume Next
    mDocument.ActiveWindow.Activate
    Application.Activate
End Sub

Private Sub Notify(ByVal message As String, ByVal style As VbMsgBoxStyle)
    MsgBox message, style, "Reader"
End Sub

' --------------------------------------------------------------------- text

' One tab-separated part of a line, unescaped (\\ \t \r \n).
Private Function Part(ByVal line As String, ByVal index As Long) As String
    Dim parts() As String
    parts = Split(line, vbTab)
    If index > UBound(parts) Then Exit Function
    Dim value As String
    value = parts(index)
    If InStr(value, "\") = 0 Then
        Part = value
        Exit Function
    End If
    Const SLASH As String = "\\"
    Dim marker As String
    marker = ChrW(&HFFFF&)
    value = Replace(value, SLASH, marker)
    value = Replace(value, "\t", vbTab)
    value = Replace(value, "\r", vbCr)
    value = Replace(value, "\n", vbLf)
    Part = Replace(value, marker, "\")
End Function

' A JSON string literal.
Private Function Q(ByVal value As String) As String
    Dim code As Long
    value = Replace(value, "\", "\\")
    value = Replace(value, """", "\""")
    value = Replace(value, vbCr, "\r")
    value = Replace(value, vbLf, "\n")
    value = Replace(value, vbTab, "\t")
    For code = 0 To 31
        If InStr(value, ChrW(code)) > 0 Then
            value = Replace(value, ChrW(code), "\u" & Right$("000" & Hex$(code), 4))
        End If
    Next
    Q = """" & value & """"
End Function

' Position just after "key": in a flat JSON object, or 0.
Private Function ValueStart(ByVal json As String, ByVal key As String) As Long
    Dim at As Long
    at = InStr(json, """" & key & """:")
    If at > 0 Then ValueStart = at + Len(key) + 3
End Function

Private Function JsonBool(ByVal json As String, ByVal key As String) As Boolean
    Dim at As Long
    at = ValueStart(json, key)
    If at > 0 Then JsonBool = Mid$(json, at, 4) = "true"
End Function

Private Function JsonString(ByVal json As String, ByVal key As String) As String
    Dim at As Long
    at = ValueStart(json, key)
    If at = 0 Then Exit Function
    If Mid$(json, at, 1) <> """" Then Exit Function
    JsonString = DecodeString(json, at)
End Function

' Decodes the JSON string literal that starts at `at`, writing into a
' preallocated buffer so long operations decode in linear time.
Private Function DecodeString(ByVal json As String, ByVal at As Long) As String
    Dim buffer As String
    Dim length As Long
    Dim position As Long
    Dim quote As Long
    Dim slash As Long
    Dim piece As String
    buffer = Space$(Len(json))
    position = at + 1
    Do
        quote = InStr(position, json, """")
        If quote = 0 Then Exit Function
        slash = InStr(position, json, "\")
        If slash = 0 Or slash > quote Then
            Append buffer, length, Mid$(json, position, quote - position)
            Exit Do
        End If
        Append buffer, length, Mid$(json, position, slash - position)
        piece = Mid$(json, slash + 1, 1)
        position = slash + 2
        Select Case piece
        Case "n"
            Append buffer, length, vbLf
        Case "r"
            Append buffer, length, vbCr
        Case "t"
            Append buffer, length, vbTab
        Case "b"
            Append buffer, length, ChrW(8)
        Case "f"
            Append buffer, length, ChrW(12)
        Case "u"
            Append buffer, length, ChrW(CLng("&H" & Mid$(json, slash + 2, 4) & "&"))
            position = slash + 6
        Case Else
            Append buffer, length, piece
        End Select
    Loop
    DecodeString = Left$(buffer, length)
End Function

Private Sub Append(buffer As String, length As Long, ByVal piece As String)
    If Len(piece) = 0 Then Exit Sub
    Mid$(buffer, length + 1, Len(piece)) = piece
    length = length + Len(piece)
End Sub

' Decodes a message written with \u escapes.
Private Function T(ByVal escaped As String) As String
    T = DecodeString("""" & escaped & """", 1)
End Function
