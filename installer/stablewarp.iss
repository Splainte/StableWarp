; StableWarp — installeur Windows en un seul fichier, sans droits admin.
; Compilé par GitHub Actions à chaque release (version injectée via /DAppVersion).
; Il fait exactement ce que install/install-windows.bat fait en dev :
; PlayerDebugMode (CSXS 9→12) + copie du panneau dans les extensions CEP utilisateur.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{8F3B1C7A-2E9D-4B61-A0F2-7C4D9E5B81A3}
AppName=StableWarp
AppVersion={#AppVersion}
AppPublisher=Splainte
AppPublisherURL=https://github.com/Splainte/StableWarp
; Tout vit dans le profil utilisateur (AppData + HKCU) → pas d'élévation.
PrivilegesRequired=lowest
DefaultDirName={userappdata}\Adobe\CEP\extensions\com.splainte.stablewarp
DisableDirPage=yes
DisableProgramGroupPage=yes
OutputDir=Output
OutputBaseFilename=StableWarp-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
; Premiere peut tourner pendant une mise à jour : les fichiers du panneau
; ne sont pas verrouillés, inutile de forcer la fermeture d'applications.
CloseApplications=no

[Languages]
Name: "french"; MessagesFile: "compiler:Languages\French.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Messages]
french.FinishedLabel=StableWarp est installé.%n%nRedémarrez Premiere Pro puis ouvrez Fenêtre > Extensions > StableWarp.
english.FinishedLabel=StableWarp is installed.%n%nRestart Premiere Pro, then open Window > Extensions > StableWarp.

[Files]
; Le panneau vit dans extension\com.splainte.stablewarp → on copie son contenu à la racine de {app}.
Source: "..\extension\com.splainte.stablewarp\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion

[Registry]
; Panneaux CEP non signés : PlayerDebugMode pour toutes les versions CSXS visées.
Root: HKCU; Subkey: "Software\Adobe\CSXS.9"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"
Root: HKCU; Subkey: "Software\Adobe\CSXS.10"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"
Root: HKCU; Subkey: "Software\Adobe\CSXS.11"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"
Root: HKCU; Subkey: "Software\Adobe\CSXS.12"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"
