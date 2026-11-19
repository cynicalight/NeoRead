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

; Native prompts also display during an in-app update (--updated /S). Do not
; change the silent flag: electron-builder uses it for --force-run after install.
!ifmacrondef neoreadLibraryPrompt
  !macro neoreadLibraryPrompt PURPOSE TEXT FLAGS
    StrCpy $1 "${TEXT}"
    System::Call 'user32::MessageBoxW(p $HWNDPARENT, w r1, w "NeoRead", i ${FLAGS}) i .r0'
  !macroend
!endif

!ifmacrondef neoreadLibraryPickParent
  !macro neoreadLibraryPickParent
    nsDialogs::SelectFolderDialog "选择安装目录之外的文件夹。安装程序将在其中新建 NeoRead Library。" ""
    Pop $0
  !macroend
!endif

!macro neoreadReadUninstallerRoot HIVE RESULT
  ReadRegStr $0 ${HIVE} "${UNINSTALL_REGISTRY_KEY}" UninstallString
  !ifdef UNINSTALL_REGISTRY_KEY_2
    ${If} $0 == ""
      ReadRegStr $0 ${HIVE} "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
    ${EndIf}
  !endif
  Push $0
  Call GetInQuotes
  Pop $0
  ${If} $0 != ""
    Push $0
    Call GetFileParent
    Pop $0
  ${EndIf}
  Push $0
  Call neoreadCheckInstallation
  Pop "${RESULT}"
!macroend

!macro neoreadMigrationArg ARG
  Push "${ARG}"
  Call neoreadAppendMigrationArg
  IfErrors migration_failed
!macroend

; nsExec captures arbitrary bytes from stdout and stderr. Compare ordinally
; and keep the literal token, never the captured text, for diagnostics.
!macro neoreadMatchMigrationReason REASON TIP
  System::Call 'kernel32::CompareStringOrdinal(w r2, i -1, w "${REASON}", i -1, i 0) i .r3'
  ${If} $3 == 2 ; CSTR_EQUAL
    StrCpy $neoreadMigrationReason "${REASON}"
    StrCpy $neoreadMigrationTip "${TIP}"
    Goto migration_failed
  ${EndIf}
!macroend

; This section precedes electron-builder's install section, including silent
; installs. customInstall/customUnInstall run too late to protect old data.
!macro customHeader
!ifndef BUILD_UNINSTALLER
  !include FileFunc.nsh
  !ifndef NEOREAD_INSTALL_MIGRATION_EXE
    ; PROJECT_DIR is the builder project directory (apps/desktop in package.mjs).
    !define NEOREAD_INSTALL_MIGRATION_EXE "${PROJECT_DIR}/bin/neoread-server.exe"
  !endif

  Var neoreadNewRoot
  Var neoreadUserRoot
  Var neoreadMachineRoot
  Var neoreadUserUninstallRoot
  Var neoreadMachineUninstallRoot
  Var neoreadUnsafeLibrary
  Var neoreadOtherLibrary
  Var neoreadMigrationDestination
  Var neoreadMigrationUserData
  Var neoreadMigrationCommand
  Var neoreadMigrationExe
  Var neoreadMigrationReason
  Var neoreadMigrationTip

  Function neoreadFoundLibrary
    Exch $0
    GetFullPathName $0 "$0"
    ${If} $neoreadUnsafeLibrary == ""
      StrCpy $neoreadUnsafeLibrary $0
    ${ElseIf} $0 != $neoreadUnsafeLibrary
      StrCpy $neoreadOtherLibrary $0
    ${EndIf}
    Pop $0
  FunctionEnd

  ; Stack argument: directory. Preserve registers across recursive calls.
  Function neoreadScanLibraries
    Exch $0
    Push $1
    Push $2
    Push $3
    Push $4
    IfFileExists "$0\neoread.sqlite" root_library
    IfFileExists "$0\reader.sqlite" root_library
    Goto scan_directory
    root_library:
      Push $0
      Call neoreadFoundLibrary
      ${If} $neoreadOtherLibrary != ""
        Goto scan_return
      ${EndIf}
    scan_directory:
      ClearErrors
      FindFirst $1 $2 "$0\*"
      IfErrors scan_failed scan_next
    scan_failed:
      DetailPrint "library.install_scan_skipped: could not enumerate directory"
      Goto scan_return
    scan_next:
      ${If} $2 == ""
        Goto scan_done
      ${EndIf}
      ${If} $2 != "."
      ${AndIf} $2 != ".."
        StrCpy $4 "$0\$2"
        System::Call 'kernel32::GetFileAttributesW(w r4) i .r3'
        ${If} $3 != -1
          IntOp $4 $3 & 0x10
          ${If} $4 != 0
            ; Check the link root but do not recursively follow links.
            IntOp $4 $3 & 0x400
            ${If} $4 != 0
              IfFileExists "$0\$2\neoread.sqlite" link_library
              IfFileExists "$0\$2\reader.sqlite" link_library
              DetailPrint "library.install_scan_skipped: directory link"
            ${Else}
              Push "$0\$2"
              Call neoreadScanLibraries
            ${EndIf}
          ${EndIf}
        ${EndIf}
      ${EndIf}
      Goto scan_advance
    link_library:
      Push "$0\$2"
      Call neoreadFoundLibrary
    scan_advance:
      ${If} $neoreadOtherLibrary != ""
        Goto scan_done
      ${EndIf}
      ClearErrors
      FindNext $1 $2
      IfErrors scan_done scan_next
    scan_done:
      FindClose $1
    scan_return:
      Pop $4
      Pop $3
      Pop $2
      Pop $1
      Pop $0
  FunctionEnd

  ; Return each normalized root for use in the migration's destination guard.
  Function neoreadCheckInstallation
    Exch $0
    Push $1
    ${If} $0 != ""
      GetFullPathName $0 "$0"
      StrCpy $1 $0 1 -1
      ${If} $1 == "\"
        StrLen $1 $0
        ${If} $1 > 3
          StrCpy $0 $0 -1
        ${EndIf}
      ${EndIf}
      ${If} $0 != ""
      ${AndIf} $neoreadOtherLibrary == ""
      ${AndIf} $0 != $neoreadNewRoot
      ${AndIf} $0 != $neoreadUserRoot
      ${AndIf} $0 != $neoreadMachineRoot
      ${AndIf} $0 != $neoreadUserUninstallRoot
      ${AndIf} $0 != $neoreadMachineUninstallRoot
        Push $0
        Call neoreadScanLibraries
      ${EndIf}
    ${EndIf}
    Pop $1
    Exch $0
  FunctionEnd

  !ifndef NEOREAD_INSTALL_USER_DATA
  Function neoreadGetRoamingAppData
    ; Do not activate another administrator's profile when this executable
    ; was launched under different credentials without an outer UAC instance.
    StrCpy $0 ""
    StrCpy $4 ${NSIS_MAX_STRLEN}
    System::Call 'secur32::GetUserNameExW(i 2, w .r1, *i r4) i .r4' ; NameSamCompatible
    IntOp $4 $4 & 255 ; BOOLEAN
    ${If} $4 == 0
      Return
    ${EndIf}
    ; Query the logged-on user and domain of this Windows session.
    System::Call 'wtsapi32::WTSQuerySessionInformationW(p 0, i -1, i 5, *p .r2, *i .r4) i .r3'
    ${If} $3 == 0
      Return
    ${EndIf}
    System::Call 'kernel32::lstrcpynW(w .r3, p r2, i ${NSIS_MAX_STRLEN}) p'
    System::Call 'wtsapi32::WTSFreeMemory(p r2)'
    System::Call 'wtsapi32::WTSQuerySessionInformationW(p 0, i -1, i 7, *p .r2, *i .r4) i .r4'
    ${If} $4 == 0
      Return
    ${EndIf}
    System::Call 'kernel32::lstrcpynW(w .r4, p r2, i ${NSIS_MAX_STRLEN}) p'
    System::Call 'wtsapi32::WTSFreeMemory(p r2)'
    ${If} $3 == ""
    ${OrIf} $4 == ""
    ${OrIf} $1 != "$4\$3"
      Return
    ${EndIf}
    ; CSIDL_APPDATA is per-account, regardless of SetShellVarContext.
    System::Call 'shell32::SHGetFolderPathW(p 0, i 0x001a, p 0, i 0, w .r0) i .r1'
    ${If} $1 != 0
      StrCpy $0 ""
    ${EndIf}
  FunctionEnd
  !endif

  ; Encode one Windows argument. Reject bogus quotes and command truncation.
  Function neoreadAppendMigrationArg
    Exch $0
    Push $1
    Push $2
    System::Call 'shlwapi::StrChrW(w r0, i 34) p .r1'
    ${If} $1 != 0
      Goto invalid_arg
    ${EndIf}
    StrLen $1 $neoreadMigrationCommand
    StrLen $2 $0
    IntOp $1 $1 + $2
    IntOp $1 $1 + 4 ; quotes, separator, and at most one escaped backslash
    ${If} $1 >= ${NSIS_MAX_STRLEN}
      Goto invalid_arg
    ${EndIf}
    StrCpy $1 $0 1 -1
    ${If} $1 == "\"
      StrCpy $0 "$0\"
    ${EndIf}
    ${If} $neoreadMigrationCommand == ""
      StrCpy $neoreadMigrationCommand '"$0"'
    ${Else}
      StrCpy $neoreadMigrationCommand '$neoreadMigrationCommand "$0"'
    ${EndIf}
    ClearErrors
    Goto arg_done
    invalid_arg:
      SetErrors
    arg_done:
      Pop $2
      Pop $1
      Pop $0
  FunctionEnd

  Section "-Check NeoRead libraries"
    ; The assisted build's silent per-machine flow elevates in the following
    ; section and reruns this guard. Handle that case only in the inner process.
    !ifdef UAC_SYNCREGISTERS
      !ifndef INSTALL_MODE_PER_ALL_USERS
        !ifndef ONE_CLICK
          ${If} $hasPerMachineInstallation == "1"
          ${AndIf} ${Silent}
          ${AndIfNot} ${UAC_IsAdmin}
            Goto guard_done
          ${EndIf}
        !endif
      !endif
    !endif
    Push $INSTDIR
    Call neoreadCheckInstallation
    Pop $neoreadNewRoot
    ; Old uninstallers may run even when a different new location was selected.
    ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    Push $0
    Call neoreadCheckInstallation
    Pop $neoreadUserRoot
    ReadRegStr $0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
    Push $0
    Call neoreadCheckInstallation
    Pop $neoreadMachineRoot
    !insertmacro neoreadReadUninstallerRoot HKCU $neoreadUserUninstallRoot
    !insertmacro neoreadReadUninstallerRoot HKLM $neoreadMachineUninstallRoot

    ${If} $neoreadUnsafeLibrary == ""
      Goto guard_done
    ${EndIf}
    DetailPrint "library.install_warning: library found inside installation"
    ${If} ${Silent}
      ${GetParameters} $0
      ClearErrors
      ${GetOptions} $0 "--updated" $1
      IfErrors guard_done
    ${EndIf}

    StrCpy $2 ""
    ${If} $neoreadOtherLibrary != ""
      StrCpy $2 "$\r$\n另一处书库：$neoreadOtherLibrary"
    ${EndIf}
    ; MB_SETFOREGROUND | MB_ICONEXCLAMATION | MB_DEFBUTTON3 | MB_YESNOCANCEL
    !insertmacro neoreadLibraryPrompt "CHOICE" "安装目录内检测到书库，继续安装可能删除论文和阅读数据。$\r$\n$\r$\n是：在安装目录外新建书库并迁移旧数据（完整复制并启用）。$\r$\n否：不复制，另行确认是否承担风险并继续。$\r$\n取消：停止安装。$\r$\n$\r$\n书库位置：$neoreadUnsafeLibrary$2" 0x10233
    ${If} $0 == 7 ; IDNO
      ; MB_YESNO, default NO
      !insertmacro neoreadLibraryPrompt "RISK" "不复制书库就继续安装，可能永久删除论文和阅读数据。确定要继续吗？" 0x10134
      ${If} $0 == 6 ; IDYES
        DetailPrint "library.install_risk_accepted: continuing without migration"
        Goto guard_done
      ${EndIf}
      Goto guard_cancelled
    ${ElseIf} $0 != 6
      Goto guard_cancelled
    ${EndIf}
    ${If} $neoreadOtherLibrary != ""
      DetailPrint "library.install_migration_refused: multiple libraries"
      !insertmacro neoreadLibraryPrompt "AMBIGUOUS" "发现多个书库，无法安全地自动选择。安装已停止。请先将所有书库完整备份到安装目录之外，再重新运行安装程序。" 0x10030
      Goto guard_cancelled
    ${EndIf}

    retry_migration:
      StrCpy $neoreadMigrationReason "unknown"
      StrCpy $neoreadMigrationTip "无法完成书库迁移。请选择安装目录之外有足够空间的可写文件夹重试；若仍失败，请取消安装并联系支持。"
      !insertmacro neoreadLibraryPickParent
      ${If} $0 == "error"
      ${OrIf} $0 == ""
        Goto guard_cancelled
      ${EndIf}
      StrLen $1 $0
      IntOp $1 $1 + 16 ; "\NeoRead Library"
      ${If} $1 >= ${NSIS_MAX_STRLEN}
        Goto migration_failed
      ${EndIf}
      StrCpy $1 $0 1 -1
      ${If} $1 == "\"
        StrCpy $neoreadMigrationDestination "$0NeoRead Library"
      ${Else}
        StrCpy $neoreadMigrationDestination "$0\NeoRead Library"
      ${EndIf}
      !ifdef NEOREAD_INSTALL_USER_DATA
        StrCpy $neoreadMigrationUserData "${NEOREAD_INSTALL_USER_DATA}"
      !else
        StrCpy $0 ""
        ; A credential-elevated installer can have a different account.
        !ifdef UAC_SYNCREGISTERS
          ${If} ${UAC_IsInnerInstance}
            !insertmacro UAC_AsUser_Call Function neoreadGetRoamingAppData ${UAC_SYNCREGISTERS}
          ${Else}
            Call neoreadGetRoamingAppData
          ${EndIf}
        !else
          Call neoreadGetRoamingAppData
        !endif
        ${If} $0 == ""
          DetailPrint "library.install_migration_refused: current user's AppData could not be determined"
          !insertmacro neoreadLibraryPrompt "PROFILE" "无法确定当前登录用户的 NeoRead 设置目录，安装已停止。请以当前登录用户的身份重新运行安装程序。" 0x10030
          SetErrorLevel 2
          Quit
        ${EndIf}
        StrCpy $neoreadMigrationUserData "$0\NeoRead"
      !endif

      ; Use the new bundled program, with a private working directory.
      InitPluginsDir
      ClearErrors
      SetOutPath "$PLUGINSDIR"
      IfErrors migration_failed
      ${If} $neoreadMigrationExe == ""
        File /oname=neoread-install-library.exe "${NEOREAD_INSTALL_MIGRATION_EXE}"
        IfErrors migration_failed
        StrCpy $neoreadMigrationExe "$PLUGINSDIR\neoread-install-library.exe"
      ${EndIf}
      StrCpy $neoreadMigrationCommand ""
      !insertmacro neoreadMigrationArg $neoreadMigrationExe
      !insertmacro neoreadMigrationArg "--data"
      !insertmacro neoreadMigrationArg $neoreadUnsafeLibrary
      !insertmacro neoreadMigrationArg "--install-library-to"
      !insertmacro neoreadMigrationArg $neoreadMigrationDestination
      !insertmacro neoreadMigrationArg "--install-user-data"
      !insertmacro neoreadMigrationArg $neoreadMigrationUserData
      !insertmacro neoreadMigrationArg "--"
      !insertmacro neoreadMigrationArg $neoreadNewRoot
      !insertmacro neoreadMigrationArg $neoreadUserRoot
      !insertmacro neoreadMigrationArg $neoreadMachineRoot
      !insertmacro neoreadMigrationArg $neoreadUserUninstallRoot
      !insertmacro neoreadMigrationArg $neoreadMachineUninstallRoot
      DetailPrint "library.install_migration_started: copying complete library"
      !ifndef NEOREAD_INSTALL_USER_DATA
        Banner::show /set 76 "正在复制整个书库，请等待完成。" "NeoRead"
      !endif
      ; Never stream helper output to the installer log. The only supported
      ; failure output is one ASCII token without a newline.
      ClearErrors
      nsExec::ExecToStack /OEM "$neoreadMigrationCommand"
      Pop $0 ; exit status (or plugin error)
      Pop $2 ; captured stdout/stderr
      !ifndef NEOREAD_INSTALL_USER_DATA
        Banner::destroy
      !endif
      IfErrors migration_failed
      StrLen $3 $2
      ${If} $0 S== "0"
      ${AndIf} $3 == 0
        DetailPrint "library.install_migrated: copied and activated library"
        Goto guard_done
      ${EndIf}
      ; A plugin error, invalid status or unrecognized output uses the safe
      ; fallback. Only exact whitelisted tokens may select text or be logged.
      IntCmp $0 0 migration_failed
      !insertmacro neoreadMatchMigrationReason "busy" "旧书库正在使用。请完全退出 NeoRead（包括托盘中的实例），再重试。"
      !insertmacro neoreadMatchMigrationReason "invalid_library" "无法读取旧书库，书库可能损坏或不完整。请取消安装，确认备份可用或联系支持后再安装。"
      !insertmacro neoreadMatchMigrationReason "no_space" "可用磁盘空间不足。请释放空间，或选择有足够空间的其他磁盘后重试。"
      !insertmacro neoreadMatchMigrationReason "settings_write" "无法保存当前用户的书库设置。请检查当前用户的 NeoRead 设置目录是否可写、磁盘空间是否充足，再重试。"
      !insertmacro neoreadMatchMigrationReason "unsafe_location" "所选位置不安全。请选择安装目录和旧书库之外的文件夹后重试。"
      !insertmacro neoreadMatchMigrationReason "destination_exists" "所选位置已有 NeoRead Library。请保留现有书库，选择其他文件夹后重试。"
      !insertmacro neoreadMatchMigrationReason "permission_denied" "迁移所需的读取或写入权限不足。请确认当前用户可以读取旧书库、写入 NeoRead 设置目录，并选择可写的目标文件夹后重试。"
      !insertmacro neoreadMatchMigrationReason "copy_failed" "无法完整复制或启用书库。请检查旧书库是否可读，并选择安装目录之外有足够空间的可写文件夹重试。"
    migration_failed:
      StrCpy $2 ""
      DetailPrint "library.install_migration_failed: $neoreadMigrationReason"
      ; MB_RETRYCANCEL, default CANCEL. Never fall through to old uninstall.
      !insertmacro neoreadLibraryPrompt "RETRY" "安装尚未继续。$\r$\n$\r$\n$neoreadMigrationTip" 0x10135
      ${If} $0 == 4 ; IDRETRY
        Goto retry_migration
      ${EndIf}
      SetErrorLevel 2
      Quit
    guard_cancelled:
      DetailPrint "library.install_cancelled: stopped before uninstall"
      SetErrorLevel 1
      Quit
    guard_done:
      ClearErrors
  SectionEnd
!endif
!macroend
