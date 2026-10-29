Option Explicit
' Starts AgentManager without a console window. Kept next to AgentManager.exe in release/.
Dim fso, shell, here, exe
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
exe = fso.BuildPath(here, "AgentManager.exe")
If Not fso.FileExists(exe) Then
  MsgBox "找不到 AgentManager.exe。" & vbCrLf & "请先运行 npm run build:exe。", vbExclamation, "AgentManager"
  WScript.Quit 1
End If
shell.CurrentDirectory = here
shell.Run Chr(34) & exe & Chr(34), 0, False
