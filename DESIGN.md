# StableWarp — Design

Extension Premiere Pro qui permet d'appliquer la Stabilisation de déformation (Warp Stabilizer)
sur des clips à vitesse modifiée, sans imbrication manuelle, avec retiming et retrim libres après coup.

## Problème

Premiere interdit nativement le Warp Stabilizer sur un clip dont la vitesse ≠ 100 %.
Le contournement manuel (imbriquer, stab sur le nest) est pénible :

- changer la vitesse après coup invalide l'analyse (bannière bleue à l'export si oubli) ;
- bouger le in/out oblige à rentrer dans la séquence imbriquée ;
- les nests s'accumulent en vrac à la racine du projet.

## Principe : le « nest inversé »

Le workflow manuel met la vitesse *dans* le nest et la stab *dessus*. StableWarp fait l'inverse :

- la stab vit **à l'intérieur** d'une séquence `<rush>_stab`, appliquée sur le rush **à 100 %** ;
- la vitesse se règle **sur l'instance du nest** dans la timeline, via le clic droit →
  Vitesse/Durée natif.

Comme la stab est calculée en amont du retiming, **changer la vitesse ne déclenche jamais de
recalcul** et ne produit jamais de bannière.

## Structure de la séquence `_stab` (deux pistes)

- **Durée totale = durée du rush entier**, mappage 1:1 : le timecode du nest correspond au
  timecode source. L'instance dans la timeline peut donc toujours être étirée (le média existe).
- **V1 (dessous)** : le rush entier, sans aucun effet — piste « témoin ». En étirant le clip
  au-delà de la plage stabilisée, on voit l'image non stabilisée plutôt que du noir, ce qui
  permet de viser où l'on étire.
- **V2 (dessus)** : le clip couvrant uniquement la plage dérushée (in/out utilisés dans la
  timeline), positionné à son offset source réel, avec le Warp Stabilizer →
  - l'analyse ne porte que sur la plage utile (ressources maîtrisées) ;
  - les débuts/fins de rush où la caméra part en cacahuète ne polluent pas l'analyse.
- Caveat mineur : à la frontière V2/V1 il y a un saut visuel (le Warp zoome légèrement l'image),
  visible seulement le temps que le watcher étende la V2 et relance l'analyse.
- La séquence est rangée **dans le même chutier que le rush**, nommée `<nom du rush>_stab`.
- Pas de marges par défaut (le dérush colle déjà aux parties utilisables) ; option marges ±N s
  dans le panneau pour qui en veut.

## Bouton « Stabiliser »

Sur le(s) clip(s) sélectionné(s) dans la timeline :

1. Si `<rush>_stab` existe déjà : réutilisation (étendue si besoin, voir watcher). Sinon création.
2. Application du Warp Stabilizer sur le clip intérieur (l'analyse démarre seule).
3. Remplacement de la source du clip timeline par la séquence `_stab`, en **conservant
   position, in/out, vitesse et effets** déjà posés.

L'interception du drag & drop de l'effet est impossible (aucun event hook dans l'API Premiere,
et le blocage stab+vitesse est dans le moteur de rendu) → le bouton est le seul point d'entrée.

## Watcher : adaptation automatique du in/out

Le panneau scanne périodiquement (~2 s) les séquences ouvertes à la recherche d'instances de
nests `_stab` dont le in/out déborde de la plage couverte par le clip intérieur :

- **Extension détectée** → le clip V2 est étendu pour couvrir exactement la nouvelle plage,
  puis le Warp est ré-appliqué (suppression + ré-ajout pour forcer la ré-analyse, en recopiant
  les paramètres modifiés par l'utilisateur). Pendant l'analyse : image non stabilisée (V1) sur
  la partie étendue, puis image stabilisée. Zéro action manuelle.
- **Réduction** → aucune action (une analyse légèrement plus large que nécessaire est
  inoffensive). Bouton « Optimiser » optionnel pour resserrer et ré-analyser au plus juste.

Limitation assumée : le watcher ne tourne que si le panneau est ouvert (même contrainte que
Sauron). Panneau fermé → la partie étendue reste non stabilisée (image V1) jusqu'à réouverture.

## Risques techniques — tous VALIDÉS par le spike (Premiere 26.2.2, 2026-06-12)

| # | Point | Solution validée |
|---|-------|------------------|
| 1 | Poser le Warp par script | QE DOM `addVideoEffect` sur la séquence ACTIVE, vérifié par matchName `AE.ADBE SubspaceStabilizer` |
| 2 | Swap source en gardant vitesse/in/out | `trackItem.projectItem =` conserve la vitesse et la position ; remet le in/out à zéro → réécriture des valeurs d'origine après coup |
| 3 | Construire le nest 2 pistes | V1 : in/out source posés sur 0 → durée réelle (lue via XMP, `setOutPoint` ne se clampe pas) ; V2 : sous-élément borné `createSubClip` (vidéo seule) car `overwriteClip` ignore les in/out source ; QE `addTracks`/`removeEmptyVideo+AudioTracks` |
| 4 | Nom d'effet localisé | noms candidats FR/EN + balayage + vérification post-pose par matchName (indépendant de la locale) |

Découverte clé : les in/out d'un trackItem à vitesse modifiée sont exprimés en **temps étiré**
par la vitesse (in 9.910 s constaté sur un média de 7.508 s à 50 %) →
temps source = in/out × |vitesse|. Conversion appliquée partout.

## Limitations v0.2 (à traiter ensuite)

- Clips en lecture inversée : ignorés (message).
- Remappage temporel par images clés : non détecté, plage potentiellement fausse.
- Ré-analyse après extension : le Warp est re-posé à neuf (paramètres personnalisés perdus).
- Watcher actif uniquement panneau ouvert (contrainte CEP, comme Sauron).
- MàJ : vérification GitHub Releases + ouverture du navigateur ; nécessite un repo public
  (ou des releases publiques) et un installeur, comme Sauron — à mettre en place à la 1.0.
- **Annuler (Ctrl+Z)** : chaque appel API crée sa propre entrée d'historique (~12 par
  stabilisation) et CEP/ExtendScript n'a AUCUN mécanisme de regroupement. L'API UXP, elle,
  a des transactions (actions composées = une seule entrée d'annulation) → c'est l'argument
  décisif pour faire de la **migration UXP le chantier de la 1.0**, d'autant que CEP est
  coupé fin 2026. À vérifier lors du portage : équivalents UXP de createSubClip,
  createNewSequenceFromClips, close d'onglet, et pose d'effet par matchName (insertComponent
  — qui réglerait aussi la question des locales encore plus proprement).

Réglés en v0.2 : les sous-éléments `_zone` vivent dans un chutier racine `_StableWarp`
(plus dans les chutiers de travail), l'ancienne zone est supprimée à chaque extension
(déplacement dans un chutier temporaire supprimé avec son contenu), et l'onglet de la
séquence `_stab` est refermé automatiquement après traitement.

## Portage UXP — bloqué au 2026-06-12 (API Premiere 26.2)

Enquête complète sur la référence UXP (AdobeDocs/uxp-premiere-pro). Disponible :
`Project.executeTransaction` (Ctrl+Z groupé ✔), `Project.closeSequence` ✔,
`ClipProjectItem.getMedia().duration` ✔ (plus besoin de XMP),
`createSetInOutPointsAction`/`createClearInOutPointsAction` ✔,
`VideoFilterFactory.createComponent(matchName)` ✔ (locale réglée),
`SequenceEditor.createOverwriteItemAction`/`createRemoveItemsAction` ✔.

**Manquant — bloquant** : aucune action de vitesse (pas de `createSetSpeedAction`,
`getSpeed` est en lecture seule) et aucun moyen de remplacer la source d'un trackItem
(le `trackItem.projectItem =` validé en CEP n'a pas d'équivalent). Sans ça, impossible
de swapper le clip vers le nest en conservant la vitesse → la fonctionnalité cœur saute.
Piste Time Remapping (ComponentParam) écartée : vitesse composée illisible pour le monteur.

**Décision** : la 1.0 reste en CEP. Surveiller le changelog UXP
(developer.adobe.com/premiere-pro/uxp/changelog/) à chaque version de Premiere ;
porter dès qu'une API de vitesse ou de remplacement de source apparaît.
En attendant, le Ctrl+Z est compensé par le bouton « Dé-stabiliser la sélection »
(restaure le rush d'origine en un clic, vitesse/position conservées).

## Plateforme

CEP est en fin de vie (UXP GA depuis Premiere 25.6, déc. 2025 ; CEP coupé ~fin 2026).
Le QE DOM (clé pour le risque 1) n'existe qu'en CEP ; l'API UXP n'a pas de `setSpeed` non plus.
→ Spike d'abord en CEP (rapide à valider, expérience Sauron), décision CEP vs UXP ensuite
selon les résultats et la version de Premiere utilisée par l'équipe.
