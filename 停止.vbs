' Stops a running Pi-buddy server (the windowless launcher leaves no console).
' Reads the port the server recorded in data\port.txt.
Option Explicit

Dim fso, here, pf, port, http
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
pf = here & "\data\port.txt"

If Not fso.FileExists(pf) Then
  MsgBox "Pi-buddy does not look like it is running.", vbInformation, "Pi-buddy"
  WScript.Quit 0
End If

port = Trim(fso.OpenTextFile(pf, 1).ReadAll)
If port = "" Then port = "7788"

On Error Resume Next
Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
http.open "POST", "http://127.0.0.1:" & port & "/api/quit", False
http.send ""
If Err.Number <> 0 Then
  MsgBox "Could not reach Pi-buddy on port " & port & "." & vbCrLf & _
         "It may already be stopped.", vbExclamation, "Pi-buddy"
  WScript.Quit 1
End If
On Error GoTo 0

If http.status = 200 Then
  MsgBox "Pi-buddy has stopped.", vbInformation, "Pi-buddy"
Else
  MsgBox "Unexpected response: " & http.status, vbExclamation, "Pi-buddy"
End If
