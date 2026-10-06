FROM --platform=linux/amd64 mcr.microsoft.com/dotnet/runtime:10.0
COPY appout /app
ENV DOTNET_TieredCompilation=0 DOTNET_TieredPGO=0 DOTNET_ReadyToRun=0 DOTNET_TC_QuickJitForLoops=0 DOTNET_gcServer=0 DOTNET_EnableWriteXorExecute=0 DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1
CMD ["sh","-c","DOTNET_JitStdOutFile=/dev/stdout DOTNET_JitDisasm=Add dotnet /app/app.dll"]
