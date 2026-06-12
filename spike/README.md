# StableWarp Spike — installation & protocole de test

Panneau CEP minimal pour valider les 4 appels API critiques avant de développer la vraie
extension (voir `../DESIGN.md`, section « Risques techniques »).

## Installation

1. Copier le dossier `com.splainte.stablewarp.spike` dans le dossier d'extensions CEP :
   - **Windows** : `%APPDATA%\Adobe\CEP\extensions\`
   - **macOS** : `~/Library/Application Support/Adobe/CEP/extensions/`
2. Activer le mode debug (panneau non signé) — comme pour Sauron en dev :
   - **Windows** (à faire pour `CSXS.11` ET `CSXS.12`) :
     ```
     reg add HKCU\Software\Adobe\CSXS.11 /v PlayerDebugMode /t REG_SZ /d 1
     reg add HKCU\Software\Adobe\CSXS.12 /v PlayerDebugMode /t REG_SZ /d 1
     ```
   - **macOS** :
     ```
     defaults write com.adobe.CSXS.11 PlayerDebugMode 1
     defaults write com.adobe.CSXS.12 PlayerDebugMode 1
     ```
3. (Re)lancer Premiere → `Fenêtre > Extensions > StableWarp Spike`.

## Protocole

Préparer : un projet de test, un rush dans un chutier, le rush posé dans une séquence,
**vitesse passée à 50 %** (clic droit > Vitesse/Durée), clip sélectionné dans la timeline.

Dérouler les boutons **dans l'ordre** et noter/copier la sortie du log à chaque étape :

| Test | Ce qu'on valide | Résultat attendu |
|------|-----------------|------------------|
| 0 | ExtendScript répond | version Premiere + nom du projet |
| 1 | Nom exact du Warp Stabilizer (localisé FR ?) | une liste contenant « Stabilisation de déformation » ou similaire → recopier le nom exact dans le champ si différent |
| 2 | Lecture in/out/vitesse/chutier du clip | vitesse = 50, chutier parent correct |
| 3 | Création de `<rush>_stab` dans le même chutier, à 2 pistes : V1 = rush entier témoin, V2 = plage dérushée calée au timecode source (risque n°3) | séquence créée au bon endroit, ligne « calage OK » |
| 4 | Pose du Warp par script sur la V2 (risque n°1) | `→ true` sur la piste V2, et en ouvrant la séquence `_stab` l'analyse tourne toute seule, sur la plage dérushée uniquement |
| 5 | Swap de source en conservant la vitesse (risque n°2, plan A) | « vitesse CONSERVÉE ✔ » et l'image de la timeline vient du nest |
| 6 | QE setSpeed (risque n°2, plan B — seulement si le test 5 échoue) | vitesse lue = 50 après l'appel |

Après le test 5, vérifier à la main dans la timeline :
- l'image est bien celle du nest stabilisé (une fois l'analyse finie) ;
- changer la vitesse (75 %, 25 %…) ne fait **pas** réapparaître de bannière d'analyse ;
- raccourcir le clip fonctionne ; l'étirer au-delà de la plage dérushée affiche l'image
  **non stabilisée** (piste V1 témoin) et non du noir — c'est le watcher de la vraie
  extension qui étendra la V2 stabilisée automatiquement.

Renvoyer le contenu du log complet (copier-coller) + ces trois observations.
