Set shell = CreateObject("WScript.Shell")
command = "cmd.exe /c cd /d ""C:\Users\111\Desktop\monitor"" && start ""monitor-server"" /b ""C:\Program Files\nodejs\node.exe"" server.js 1>>""C:\Users\111\Desktop\monitor\data\server.stdout.log"" 2>>""C:\Users\111\Desktop\monitor\data\server.stderr.log"" && start ""monitor-gateway"" /b ""C:\Program Files\nodejs\node.exe"" maintenance-gateway.js 1>>""C:\Users\111\Desktop\monitor\data\gateway.stdout.log"" 2>>""C:\Users\111\Desktop\monitor\data\gateway.stderr.log"""
shell.Run command, 0, False
