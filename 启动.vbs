' Pi-buddy launcher: starts the server with no console window.
' Logs go to data\server.log.
' IMPORTANT: keep this file ASCII-only. Windows Script Host reads .vbs files
' with the system ANSI code page; non-ASCII bytes, even inside comments,
' are decoded as garbage and can break the script.
Option Explicit

Dim fso, sh, here, logFile, cmd, q, rc
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = here

If Not fso.FolderExists(here & "\data") Then fso.CreateFolder(here & "\data")

rc = sh.Run("cmd /c where node >nul 2>nul", 0, True)
If rc <> 0 Then
  MsgBox "Node.js not found." & vbCrLf & vbCrLf & _
         "Pi-buddy needs Node.js 20 or newer." & vbCrLf & _
         "Download: https://nodejs.org" & vbCrLf & vbCrLf & _
         "Install it, then run this file again.", _
         vbExclamation, "Pi-buddy"
  WScript.Quit 1
End If

' Closing every browser page shuts the server down automatically.
' Chr(34) builds the quotes around the log path, avoiding triple-quote literals.
q = Chr(34)
logFile = here & "\data\server.log"
cmd = "cmd /c set PIBUDDY_QUIT_ON_CLOSE=1&& node server.js >> " & q & logFile & q & " 2>&1"

Err.Clear
On Error Resume Next
sh.Run cmd, 0, False
If Err.Number <> 0 Then
  MsgBox "Could not start Pi-buddy." & vbCrLf & vbCrLf & _
         "Error " & Err.Number & ": " & Err.Description & vbCrLf & vbCrLf & _
         "Command:" & vbCrLf & cmd, vbCritical, "Pi-buddy"
End If
On Error GoTo 0
