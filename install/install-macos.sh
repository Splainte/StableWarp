#!/bin/bash
# StableWarp — installation et mise à jour pour Adobe Premiere Pro (macOS)
#
# Première installation (sans avertissement Gatekeeper : le contenu récupéré
# par curl n'est pas mis en quarantaine) :
#
#   curl -fsSL https://raw.githubusercontent.com/Splainte/StableWarp/main/install/install-macos.sh | bash
#
# Le bouton « Mise à jour disponible » du panneau relance ce même script
# pour passer à la dernière version.
set -e

REPO="Splainte/StableWarp"
EXT_ID="com.splainte.stablewarp"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/$EXT_ID"

echo "StableWarp — installation pour Premiere Pro"

# 1. Autoriser les panneaux CEP non signés (PlayerDebugMode), CSXS 9 à 12.
for V in 9 10 11 12; do
  defaults write "com.adobe.CSXS.$V" PlayerDebugMode 1 2>/dev/null || true
done

# 2. Récupérer la dernière version publiée (ou la branche main à défaut).
TAG=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
  | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

if [ -n "$TAG" ]; then
  echo "Téléchargement de StableWarp $TAG…"
  URL="https://github.com/$REPO/archive/refs/tags/$TAG.tar.gz"
else
  echo "Téléchargement de StableWarp (dernière version)…"
  URL="https://github.com/$REPO/archive/refs/heads/main.tar.gz"
fi
curl -fsSL "$URL" -o "$TMP/stablewarp.tar.gz"
tar -xzf "$TMP/stablewarp.tar.gz" -C "$TMP"
SRC=$(find "$TMP" -maxdepth 2 -type d -path "*/extension/$EXT_ID" | head -1)

# 3. Installer le panneau (remplace proprement la version précédente).
rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$SRC"/. "$DEST"/

echo ""
echo "StableWarp installé dans :"
echo "    $DEST"
echo "Redémarre Premiere Pro, puis : Fenêtre > Extensions > StableWarp"
