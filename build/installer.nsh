; Desktop shortcuts are created only when the user checks the finish-page box.
; Keep the normal launch checkbox and the installation-directory page.
!macro customHeader
  LangString lumaCreateDesktopShortcut ${LANG_SIMPCHINESE} "创建桌面快捷方式"
  LangString lumaCreateDesktopShortcut ${LANG_ENGLISH} "Create a desktop shortcut"
!macroend

!macro customFinishPage
  Function LumaStartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  Function LumaCreateDesktopShortcut
    ${ifNot} ${isNoDesktopShortcut}
      CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
      System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
    ${endif}
  FunctionEnd

  !ifndef HIDE_RUN_AFTER_FINISH
    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "LumaStartApp"
  !endif
  ; MUI's optional second checkbox invokes a function instead of opening a file.
  ; It is checked by default unless MUI_FINISHPAGE_SHOWREADME_NOTCHECKED is set.
  !define MUI_FINISHPAGE_SHOWREADME
  !define MUI_FINISHPAGE_SHOWREADME_TEXT "$(lumaCreateDesktopShortcut)"
  !define MUI_FINISHPAGE_SHOWREADME_FUNCTION "LumaCreateDesktopShortcut"
  !insertmacro MUI_PAGE_FINISH
!macroend

; Automatic desktop shortcut creation is disabled, so remove our shortcut here.
; Preserve shortcuts during upgrades, matching electron-builder's normal behavior.
!macro customUnInstall
  ${ifNot} ${isKeepShortcuts}
    WinShell::UninstShortcut "$oldDesktopLink"
    Delete "$oldDesktopLink"
  ${endif}
!macroend
