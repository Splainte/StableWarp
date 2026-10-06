#!/bin/bash
# StableWarp — installation du BUILD DIAGNOSTIC (branche diag-warp-banner) sur macOS.
# Remplace la version installée par le build de test avec le bouton « Diagnostic
# bandeau ». Ne touche pas au canal public. Lancer :
#   bash install-diag-macos.sh
set -e

REPO="Splainte/StableWarp"
BRANCH="diag-warp-banner"
EXT_ID="com.splainte.stablewarp"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/$EXT_ID"

echo "StableWarp — installation du build DIAGNOSTIC ($BRANCH)"

# 1. Autoriser les panneaux CEP non signés (CSXS 9 à 12)
for V in 9 10 11 12; do
  defaults write "com.adobe.CSXS.$V" PlayerDebugMode 1 2>/dev/null || true
done

# 2. Télécharger la branche
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
echo "Téléchargement de la branche $BRANCH…"
curl -fsSL "https://github.com/$REPO/archive/refs/heads/$BRANCH.tar.gz" -o "$TMP/src.tar.gz"
tar -xzf "$TMP/src.tar.gz" -C "$TMP"

SRC=$(find "$TMP" -maxdepth 3 -type d -path "*/extension/$EXT_ID" | head -1)
if [ -z "$SRC" ]; then
  echo "Erreur : dossier d'extension introuvable dans l'archive." >&2
  exit 1
fi

# 3. Installer (remplace proprement la version précédente)
rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$SRC"/. "$DEST"/

echo ""
echo "Build DIAGNOSTIC installé dans :"
echo "    $DEST"
echo "Redémarre Premiere Pro (Fenêtre > Extensions > StableWarp), version v1.1.3-test7."
echo "Au prochain bandeau bleu : sélectionne le clip, clique « Diagnostic bandeau »,"
echo "et envoie le fichier stablewarp-diag.txt (sur ton Bureau) à Claude."
