Option Explicit

If WScript.Arguments.Count <> 3 Then
  WScript.Quit 2
End If

Dim shell, nodePath, watchdogPath, workingDirectory, command, exitCode
Set shell = CreateObject("WScript.Shell")

nodePath = WScript.Arguments(0)
watchdogPath = WScript.Arguments(1)
workingDirectory = WScript.Arguments(2)
shell.CurrentDirectory = workingDirectory

command = QuoteArgument(nodePath) & " " & QuoteArgument(watchdogPath)
exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode

Function QuoteArgument(value)
  QuoteArgument = Chr(34) & Replace(CStr(value), Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
