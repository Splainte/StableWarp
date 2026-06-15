@echo off
REM StableWarp — installation dev sur Windows
REM 1. Active PlayerDebugMode (panneaux CEP non signes)
REM 2. Copie le panneau dans le dossier extensions CEP utilisateur

for %%V in (9 10 11 12) do (
  reg add "HKCU\Software\Adobe\CSXS.%%V" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul
)

set DEST=%APPDATA%\Adobe\CEP\extensions\com.splainte.stablewarp
robocopy "%~dp0..\extension\com.splainte.stablewarp" "%DEST%" /MIR >nul

echo.
echo StableWarp installe dans %DEST%
echo Redemarre Premiere Pro puis : Fenetre ^> Extensions ^> StableWarp
pause
