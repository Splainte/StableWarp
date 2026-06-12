# StableWarp

Extension Adobe Premiere Pro : appliquer la Stabilisation de déformation (Warp Stabilizer)
sur des clips à vitesse modifiée, sans imbrication manuelle — retiming et retrim libres,
sans recalcul ni bannière à l'export.

Voir [DESIGN.md](DESIGN.md) pour l'architecture (« nest inversé » à deux pistes) et
[spike/README.md](spike/README.md) pour le panneau de validation API (terminé, 4/4 validés).

## Installation (dev)

Copier `extension/com.splainte.stablewarp` dans `%APPDATA%\Adobe\CEP\extensions\`
(macOS : `~/Library/Application Support/Adobe/CEP/extensions/`), PlayerDebugMode activé
(voir spike/README.md), puis `Fenêtre > Extensions > StableWarp`.

## Utilisation

1. Sélectionner un ou plusieurs clips vidéo dans la timeline (vitesse modifiée ou non) ;
2. Cliquer **Stabiliser la sélection** → chaque clip est remplacé par son nest `<rush>_stab`
   (rangé dans le chutier du rush), l'analyse du Warp démarre toute seule ;
3. Ensuite tout est natif : vitesse via clic droit > Vitesse/Durée (zéro recalcul),
   trim libre — si on étire au-delà de la zone stabilisée, l'image non stabilisée (V1)
   s'affiche et la surveillance auto étend la zone + relance l'analyse.
