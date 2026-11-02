; Lists NeoRead under "Open with" for PDF and EPUB. The builder's own file
; associations also set each extension's default type and leave it dangling
; after uninstall, so only ProgIDs and OpenWithProgids are written here; users
; choose the default app in Windows.

!macro neoreadRegisterType EXT PROGID DESCRIPTION
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PROGID}" "" "${DESCRIPTION}"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PROGID}\DefaultIcon" "" "$appExe,0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PROGID}\shell\open\command" "" '"$appExe" "%1"'
  WriteRegNone SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "${PROGID}"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".${EXT}" ""
!macroend

!macro neoreadUnregisterType EXT PROGID
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "${PROGID}"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\${PROGID}"
!macroend

!macro customInstall
  !insertmacro neoreadRegisterType "pdf" "NeoRead.pdf" "PDF Document"
  !insertmacro neoreadRegisterType "epub" "NeoRead.epub" "EPUB Book"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\shell\open\command" "" '"$appExe" "%1"'
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  !insertmacro neoreadUnregisterType "pdf" "NeoRead.pdf"
  !insertmacro neoreadUnregisterType "epub" "NeoRead.epub"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
