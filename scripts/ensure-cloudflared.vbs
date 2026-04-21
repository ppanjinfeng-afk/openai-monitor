Set shell = CreateObject("WScript.Shell")
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""C:\Users\111\Desktop\monitor\scripts\ensure-cloudflared.ps1""", 0, False
