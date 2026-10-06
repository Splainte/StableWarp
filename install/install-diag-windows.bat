@echo off
setlocal
REM StableWarp — installation du BUILD DIAGNOSTIC (branche diag-warp-banner)
REM Remplace la version installee par le build de test avec le bouton "Diagnostic
REM bandeau". Ne touche pas au canal public : c'est juste pour Robin.
REM Double-clique ce fichier sur le PC ou tourne Premiere Pro.

set REPO=Splainte/StableWarp
set BRANCH=diag-warp-banner
set EXTID=com.splainte.stablewarp
set DEST=%APPDATA%\Adobe\CEP\extensions\%EXTID%

echo StableWarp - installation du build DIAGNOSTIC (%BRANCH%)
echo.

REM 1. Autoriser les panneaux CEP non signes (CSXS 9 a 12)
for %%V in (9 10 11 12) do (
  reg add "HKCU\Software\Adobe\CSXS.%%V" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul
)

REM 2. Telecharger et deballer l'archive de la branche
set TMP=%TEMP%\stablewarp-diag
if exist "%TMP%" rmdir /s /q "%TMP%"
mkdir "%TMP%"

echo Telechargement de la branche %BRANCH%...
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/%REPO%/archive/refs/heads/%BRANCH%.zip' -OutFile '%TMP%\src.zip' } catch { exit 1 }"
if errorlevel 1 ( echo ECHEC telechargement & pause & exit /b 1 )

powershell -NoProfile -Command "Expand-Archive -Force -Path '%TMP%\src.zip' -DestinationPath '%TMP%'"

set SRC=%TMP%\StableWarp-%BRANCH%\extension\%EXTID%
if not exist "%SRC%" ( echo ECHEC dossier extension introuvable dans l'archive & pause & exit /b 1 )

REM 3. Installer (miroir : remplace proprement la version precedente)
robocopy "%SRC%" "%DEST%" /MIR >nul

echo.
echo Build DIAGNOSTIC installe dans :
echo     %DEST%
echo.
echo Redemarre Premiere Pro, puis : Fenetre ^> Extensions ^> StableWarp
echo Le panneau doit afficher la version v1.1.3-test2.
echo Quand un bandeau bleu non detecte apparait : selectionne le clip,
echo clique "Diagnostic bandeau", et envoie le fichier stablewarp-diag.txt
echo (sur ton Bureau) a Claude.
echo.
pause
