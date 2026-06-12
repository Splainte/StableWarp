// StableWarp Spike — validation des appels API critiques (ExtendScript, ES3).
// Chaque fonction renvoie une string lisible ; "ECHEC ..." en cas de problème.

function SW_ping() {
    return "ExtendScript OK — Premiere " + app.version + " — projet : " +
        (app.project ? app.project.name : "aucun");
}

// ---------- helpers ----------

function _getSelectedVideoClip() {
    var seq = app.project.activeSequence;
    if (!seq) return null;
    var sel = seq.getSelection();
    for (var i = 0; i < sel.length; i++) {
        if (sel[i].mediaType === "Video") return sel[i];
    }
    return null;
}

// Remonte l'arborescence du projet pour trouver le chutier parent d'un projectItem.
function _findParentBin(container, target) {
    for (var i = 0; i < container.children.numItems; i++) {
        var child = container.children[i];
        if (child.nodeId === target.nodeId) return container;
        if (child.type === ProjectItemType.BIN) {
            var found = _findParentBin(child, target);
            if (found) return found;
        }
    }
    return null;
}

function _findSequenceByName(name) {
    for (var i = 0; i < app.project.sequences.numSequences; i++) {
        if (app.project.sequences[i].name === name) return app.project.sequences[i];
    }
    return null;
}

function _fmt(t) {
    try { return t.seconds.toFixed(3) + "s"; } catch (e) { return String(t); }
}

// ---------- test 1 : noms d'effets ----------

function SW_listStabEffects() {
    try {
        app.enableQE();
        var list = qe.project.getVideoEffectList();
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var lower = list[i].toLowerCase();
            if (lower.indexOf("warp") >= 0 || lower.indexOf("stab") >= 0 ||
                lower.indexOf("formation") >= 0) {
                out.push(list[i]);
            }
        }
        if (out.length === 0) return "ECHEC aucun effet stab/warp trouvé (" + list.length + " effets au total)";
        return "Effets candidats :\n" + out.join("\n");
    } catch (e) {
        return "ECHEC QE : " + e;
    }
}

// ---------- test 2 : lecture du clip sélectionné ----------

function SW_inspectSelection() {
    var item = _getSelectedVideoClip();
    if (!item) return "ECHEC aucun clip vidéo sélectionné dans la timeline active";
    var out = [];
    out.push("clip : " + item.name);
    out.push("source : " + item.projectItem.name + " (nodeId " + item.projectItem.nodeId + ")");
    out.push("inPoint (média) : " + _fmt(item.inPoint));
    out.push("outPoint (média) : " + _fmt(item.outPoint));
    out.push("start (séquence) : " + _fmt(item.start));
    out.push("end (séquence) : " + _fmt(item.end));
    try { out.push("vitesse : " + item.getSpeed()); } catch (e) { out.push("vitesse : ERREUR " + e); }
    try { out.push("inversé : " + item.isSpeedReversed()); } catch (e2) { out.push("inversé : ERREUR " + e2); }
    var bin = _findParentBin(app.project.rootItem, item.projectItem);
    out.push("chutier parent : " + (bin ? bin.name : "NON TROUVÉ"));
    return out.join("\n");
}

// ---------- test 3 : séquence _stab à 2 pistes dans le bon chutier ----------
// V1 = rush entier sans effet (piste témoin), V2 = plage dérushée seule (recevra le Warp).

function SW_createStabSeq() {
    var item = _getSelectedVideoClip();
    if (!item) return "ECHEC aucun clip vidéo sélectionné";
    var pi = item.projectItem;
    var bin = _findParentBin(app.project.rootItem, pi) || app.project.rootItem;
    var name = pi.name + "_stab";

    if (_findSequenceByName(name)) return "ECHEC la séquence \"" + name + "\" existe déjà (la supprimer pour re-tester)";

    var seq;
    try {
        seq = app.project.createNewSequenceFromClips(name, [pi], bin);
    } catch (e) {
        return "ECHEC createNewSequenceFromClips : " + e;
    }
    if (!seq) return "ECHEC createNewSequenceFromClips a renvoyé " + seq;

    // V1 contient déjà le rush entier ; on n'y touche plus.
    var out = ["séquence créée : " + seq.name + " dans \"" + bin.name + "\" (V1 = rush entier)"];

    // S'assurer qu'une piste V2 existe (QE addTracks si besoin).
    if (seq.videoTracks.numTracks < 2) {
        try {
            app.enableQE();
            var qeSeq = null;
            for (var i = 0; i < qe.project.numSequences; i++) {
                if (qe.project.getSequenceAt(i).name === seq.name) { qeSeq = qe.project.getSequenceAt(i); break; }
            }
            qeSeq.addTracks(1);
            out.push("piste V2 ajoutée via QE addTracks → numTracks = " + seq.videoTracks.numTracks);
        } catch (eT) {
            out.push("ECHEC ajout piste V2 (QE addTracks) : " + eT);
            out.push("SEQ=" + seq.name);
            return out.join("\n");
        }
    }

    // Poser le rush sur V2 puis le caler sur la plage dérushée, au même timecode que la source
    // (writabilité de inPoint/outPoint/start = risque n°3).
    try {
        var v2 = seq.videoTracks[1];
        v2.overwriteClip(pi, 0);
        var inner = v2.clips[0];
        out.push("V2 avant calage : start " + _fmt(inner.start) + " / in " + _fmt(inner.inPoint) + " / out " + _fmt(inner.outPoint));
        inner.inPoint = item.inPoint;
        inner.outPoint = item.outPoint;
        inner.start = item.inPoint;
        out.push("V2 après calage : start " + _fmt(inner.start) + " / in " + _fmt(inner.inPoint) + " / out " + _fmt(inner.outPoint));
        var okTrim = Math.abs(inner.inPoint.seconds - item.inPoint.seconds) < 0.05 &&
            Math.abs(inner.start.seconds - item.inPoint.seconds) < 0.05;
        out.push("→ calage " + (okTrim ? "OK" : "INCOMPLET (in/out/start non writables ?) — comparer les valeurs ci-dessus"));
    } catch (e2) {
        out.push("ECHEC calage clip V2 : " + e2);
    }

    out.push("SEQ=" + seq.name);
    return out.join("\n");
}

// ---------- test 4 : application du Warp via QE dans la séquence _stab ----------

function SW_applyWarp(effectName, seqName) {
    if (!seqName) return "ECHEC nom de séquence vide (lancer le test 3 d'abord)";
    try {
        app.enableQE();
        var qeSeq = null;
        for (var i = 0; i < qe.project.numSequences; i++) {
            if (qe.project.getSequenceAt(i).name === seqName) { qeSeq = qe.project.getSequenceAt(i); break; }
        }
        if (!qeSeq) return "ECHEC séquence \"" + seqName + "\" introuvable côté QE";

        var effect = qe.project.getVideoEffectByName(effectName);
        if (!effect) return "ECHEC effet \"" + effectName + "\" introuvable (vérifier avec le test 1)";

        // Cibler la piste la plus haute qui contient un clip (V2 = plage dérushée).
        for (var t = qeSeq.numVideoTracks - 1; t >= 0; t--) {
            var track = qeSeq.getVideoTrackAt(t);
            for (var j = 0; j < track.numItems; j++) {
                var qeItem = track.getItemAt(j);
                if (qeItem && qeItem.type !== "Empty") {
                    var ok = qeItem.addVideoEffect(effect);
                    return "addVideoEffect(\"" + effectName + "\") sur \"" + qeItem.name +
                        "\" (piste V" + (t + 1) + ") → " + ok +
                        "\nOuvrir la séquence " + seqName +
                        " : l'analyse du Warp doit démarrer toute seule, sur la plage dérushée uniquement.";
                }
            }
        }
        return "ECHEC aucun clip trouvé sur les pistes vidéo de " + seqName;
    } catch (e) {
        return "ECHEC QE addVideoEffect : " + e;
    }
}

// ---------- test 5 : swap de la source du clip timeline (risque n°2, plan A) ----------

function SW_swapSource(seqName) {
    if (!seqName) return "ECHEC nom de séquence vide (lancer le test 3 d'abord)";
    var item = _getSelectedVideoClip();
    if (!item) return "ECHEC aucun clip vidéo sélectionné";
    var seq = _findSequenceByName(seqName);
    if (!seq) return "ECHEC séquence \"" + seqName + "\" introuvable";

    var stabPI;
    try { stabPI = seq.projectItem; } catch (e0) { return "ECHEC sequence.projectItem inaccessible : " + e0; }
    if (!stabPI) return "ECHEC sequence.projectItem est " + stabPI;

    var before = [];
    try { before = [item.getSpeed(), item.inPoint.seconds, item.outPoint.seconds]; } catch (eB) {}

    try {
        item.projectItem = stabPI;
    } catch (e) {
        return "ECHEC affectation trackItem.projectItem : " + e + "\n→ tester le plan B (test 6, QE setSpeed)";
    }

    var out = ["source du clip remplacée par : " + item.projectItem.name];
    try {
        out.push("vitesse avant " + before[0] + " → après " + item.getSpeed() +
            (before[0] === item.getSpeed() ? " (CONSERVÉE ✔)" : " (PERDUE ✘)"));
        out.push("in avant " + before[1].toFixed(3) + "s → après " + item.inPoint.seconds.toFixed(3) + "s");
        out.push("out avant " + before[2].toFixed(3) + "s → après " + item.outPoint.seconds.toFixed(3) + "s");
    } catch (e2) {
        out.push("lecture post-swap impossible : " + e2);
    }
    out.push("→ vérifier visuellement que l'image vient bien du nest et que la vitesse joue toujours.");
    return out.join("\n");
}

// ---------- test 6 : QE setSpeed (risque n°2, plan B) ----------

function SW_qeSetSpeed(pct) {
    var domItem = _getSelectedVideoClip();
    if (!domItem) return "ECHEC aucun clip vidéo sélectionné";
    try {
        app.enableQE();
        var qeSeq = qe.project.getActiveSequence();
        for (var t = 0; t < qeSeq.numVideoTracks; t++) {
            var track = qeSeq.getVideoTrackAt(t);
            for (var j = 0; j < track.numItems; j++) {
                var qeItem = track.getItemAt(j);
                if (!qeItem || qeItem.type === "Empty" || qeItem.name !== domItem.name) continue;
                var results = [];
                // signature non documentée : on tente les variantes connues
                try { results.push("setSpeed(" + pct + ") → " + qeItem.setSpeed(pct)); }
                catch (e1) {
                    results.push("setSpeed(" + pct + ") → ERREUR " + e1);
                    try { results.push("setSpeed(" + pct + ",'00;00;00;00',false,false,false) → " +
                        qeItem.setSpeed(pct, "00;00;00;00", false, false, false)); }
                    catch (e2) { results.push("variante 5 args → ERREUR " + e2); }
                }
                results.push("vitesse lue côté DOM après coup : " + domItem.getSpeed());
                return results.join("\n");
            }
        }
        return "ECHEC clip \"" + domItem.name + "\" introuvable côté QE";
    } catch (e) {
        return "ECHEC QE : " + e;
    }
}
