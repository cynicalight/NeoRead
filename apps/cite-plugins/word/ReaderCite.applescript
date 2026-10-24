-- Transport for the Word template on macOS. Word's VBA runs in a sandbox and
-- cannot open network connections; AppleScriptTask runs this handler outside
-- it. Installed by Reader as
-- ~/Library/Application Scripts/com.microsoft.Word/ReaderCite.scpt.
--
-- The argument is "<path>\n<JSON body>". The result is the response body with
-- the HTTP status appended as the last line ("000" when Reader is not running).
on post(argument)
	set newline to ASCII character 10
	set splitAt to offset of newline in argument
	set requestPath to text 1 thru (splitAt - 1) of argument
	set requestBody to text (splitAt + 1) thru -1 of argument
	set supportFolder to POSIX path of (path to application support folder from user domain)
	set credentialFile to supportFolder & "Reader/cite-credential"
	set bodyFile to POSIX path of (path to temporary items from user domain) & "reader-cite-request.json"
	set handle to open for access (POSIX file bodyFile) with write permission
	try
		set eof of handle to 0
		write requestBody to handle as «class utf8»
		close access handle
	on error message
		close access handle
		error message
	end try
	set command to "token=$(cat " & quoted form of credentialFile & " 2>/dev/null); " & ¬
		"curl -sS --max-time 60 -X POST -H 'Content-Type: application/json; charset=utf-8' " & ¬
		"-H \"Authorization: Bearer $token\" --data-binary @" & quoted form of bodyFile & ¬
		" -w '\\n%{http_code}' " & quoted form of ("http://127.0.0.1:17841" & requestPath) & ¬
		" 2>/dev/null || printf '\\n000'"
	return do shell script command without altering line endings
end post
