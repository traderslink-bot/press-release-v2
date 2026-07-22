Option Explicit

Dim shell, fileSystem, projectRoot, levelsRoot, supervisorPath, command
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

projectRoot = fileSystem.GetParentFolderName(WScript.ScriptFullName)
levelsRoot = fileSystem.GetAbsolutePathName(fileSystem.BuildPath(projectRoot, "..\..\levels"))
supervisorPath = fileSystem.BuildPath(levelsRoot, "run_both_levels_bots_forever.bat")

If Not fileSystem.FileExists(supervisorPath) Then
  WScript.Quit 2
End If

shell.CurrentDirectory = levelsRoot
command = QuoteArgument(shell.ExpandEnvironmentStrings("%ComSpec%")) & " /d /c " & QuoteArgument(supervisorPath)
shell.Run command, 0, False
WScript.Quit 0

Function QuoteArgument(value)
  QuoteArgument = Chr(34) & Replace(CStr(value), Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
