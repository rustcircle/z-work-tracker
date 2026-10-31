; Installer hooks. A running copy, even one hidden in the tray, is asked to quit through its normal
; exit path first, so an open segment is closed cleanly before the generic process check runs.

!macro LT_QUIT_RUNNING_APP
  IfFileExists "$INSTDIR\${MAINBINARYNAME}.exe" 0 +3
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --quit'
    Sleep 1500
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; WebView2 ships with Windows 11. It is the one deliberate system dependency and is never downloaded.
  ClearErrors
  ReadRegStr $0 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  StrCmp $0 "" 0 lt_webview_ok
  ReadRegStr $0 HKCU "Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  StrCmp $0 "" 0 lt_webview_ok
  MessageBox MB_OK|MB_ICONEXCLAMATION "Microsoft Edge WebView2 Runtime was not found. It normally comes with Windows 11.$\r$\n$\r$\nLabor Tracker needs it and will show this message again when opened. Run Windows Update or reinstall the WebView2 Runtime from Microsoft."
  lt_webview_ok:
  !insertmacro LT_QUIT_RUNNING_APP
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro LT_QUIT_RUNNING_APP
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Removes the "Start with Windows" entry, if the user turned it on.
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}"
!macroend
