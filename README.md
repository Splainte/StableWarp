# StableWarp

Extension Adobe Premiere Pro : appliquer la Stabilisation de déformation (Warp Stabilizer)
sur des clips à vitesse modifiée, sans imbrication manuelle — retiming et retrim libres,
sans recalcul ni bannière à l'export.

## Installation

### Windows

Télécharge **[StableWarp-Setup.exe](https://github.com/Splainte/StableWarp/releases/latest)**,
double-clique, suis l'assistant (pas de droits administrateur nécessaires). Puis redémarre
Premiere et ouvre **Fenêtre > Extensions > StableWarp**.

> À la première installation, Windows peut afficher un avertissement SmartScreen (l'app
> n'est pas signée) : clique sur « Informations complémentaires » puis « Exécuter quand même ».

### macOS

Ouvre le **Terminal** (Applications ▸ Utilitaires) et colle cette ligne, puis Entrée :

```bash
curl -fsSL https://raw.githubusercontent.com/Splainte/StableWarp/main/install/install-macos.sh | bash
```

Ça installe StableWarp sans aucun avertissement. Redémarre ensuite Premiere et ouvre
**Fenêtre > Extensions > StableWarp**.

### Mises à jour

Sur les deux systèmes, le bouton **« Mise à jour disponible »** en bas du panneau (visible
seulement quand une nouvelle version existe) télécharge et installe la dernière version tout
seul. Il suffit de redémarrer Premiere ensuite.

Compatibilité : Premiere Pro 2020 (14.0) et versions ultérieures.

## Utilisation

1. Sélectionner un ou plusieurs clips vidéo dans la timeline (vitesse modifiée ou non) ;
2. Cliquer **Stabiliser la sélection** — le bouton s'adapte à chaque clip :
   vitesse 100 % → le Warp est posé directement dessus, comme à la main ;
   vitesse modifiée (y compris inversée) → le clip est remplacé par son nest `<rush>_stab`
   (rangé dans le chutier du rush). L'analyse démarre toute seule dans les deux cas ;
3. Ensuite tout est natif : vitesse via clic droit > Vitesse/Durée (zéro recalcul),
   trim libre — si on étire au-delà de la zone stabilisée, l'image non stabilisée (V1)
   s'affiche et la surveillance auto étend la zone + relance l'analyse.

Le bouton **Dé-stabiliser** restaure le rush d'origine (vitesse et position conservées) et
nettoie le nest `_stab` s'il n'est plus utilisé ailleurs.

Les sous-éléments techniques (`<rush>_stab_zone`) sont rangés dans un chutier racine
`_StableWarp` ; les onglets des séquences `_stab` se referment automatiquement.

## Développement

Installation en local sans passer par l'installeur :

- **Windows** : `install\install-windows.bat` (active PlayerDebugMode + copie le panneau) ;
- **macOS** : `bash install/install-macos.sh`.

Le code du panneau vit dans `extension/com.splainte.stablewarp/`. Une release se déclenche en
taguant `vX.Y.Z` (après avoir aligné `ExtensionBundleVersion` dans le manifest et `SW_VERSION`
dans `index.html`) : GitHub Actions compile l'installeur Inno et publie la release.
