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

## Risques techniques (à valider par le spike)

| # | Point | Plan A | Plan B |
|---|-------|--------|--------|
| 1 | Poser le Warp par script | QE DOM `addVideoEffect` (non documenté mais éprouvé) | matchName `AE.ADBE SubspaceStabilizer` via UXP `insertComponent` |
| 2 | Swap source en gardant vitesse/in/out | réassignation `trackItem.projectItem` | QE `setSpeed` (douteux) ; sinon message « réapplique ta vitesse » à la création |
| 3 | Construire le nest 2 pistes (V2 + trim) par script | `track.overwriteClip` + `trackItem.inPoint/outPoint/start` writables (API ≥ v13) ; piste V2 via QE `addTracks` si absente | recréer la séquence |
| 4 | Nom d'effet localisé FR | découverte via `getVideoEffectList()` | — |

## Plateforme

CEP est en fin de vie (UXP GA depuis Premiere 25.6, déc. 2025 ; CEP coupé ~fin 2026).
Le QE DOM (clé pour le risque 1) n'existe qu'en CEP ; l'API UXP n'a pas de `setSpeed` non plus.
→ Spike d'abord en CEP (rapide à valider, expérience Sauron), décision CEP vs UXP ensuite
selon les résultats et la version de Premiere utilisée par l'équipe.
