// Prepares wwwroot/lazy (the IntelliSense assemblies fetched after first paint). The work is shared with csharp/: ../shared/tools/PrepareLazy.cs.
// Usage: dotnet run tools/PrepareLazy.cs
using System.Diagnostics;
var psi = new ProcessStartInfo("dotnet", "run ../shared/tools/PrepareLazy.cs src/SharpLab.Wasm/wwwroot/lazy SharpLab.Core.dll");
using var p = Process.Start(psi)!;
p.WaitForExit();
return p.ExitCode;
