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

function _findQESequence(name) {
    for (var i = 0; i < qe.project.numSequences; i++) {
        if (qe.project.getSequenceAt(i).name === name) return qe.project.getSequenceAt(i);
    }
    return null;
}

function _fmt(t) {
    try { return t.seconds.toFixed(3) + "s"; } catch (e) { return String(t); }
}

function _t(sec) {
    var t = new Time();
    t.seconds = sec;
    return t;
}

// Durée réelle du média (setOutPoint ne se clampe PAS à la fin du média — constaté
// sur Premiere 26 : 999999 s acceptés → séquence de 3 jours).
function _getMediaDurationSec(pi, log) {
    // 1) XMP du média : xmpDM:duration (value en frames, scale du type "1/25")
    try {
        var xmp = pi.getXMPMetadata();
        var block = xmp.match(/xmpDM:duration[\s\S]{0,300}/);
        if (block) {
            var v = block[0].match(/xmpDM:value[="'\s>]+(\d+)/);
            var s = block[0].match(/xmpDM:scale[="'\s>]+(\d+)\/(\d+)/);
            if (v) {
                var sec = s ? Number(v[1]) * Number(s[1]) / Number(s[2]) : Number(v[1]);
                if (sec > 0 && sec < 360000) {
                    log.push("durée média (XMP) : " + sec.toFixed(3) + "s");
                    return sec;
                }
            }
        }
    } catch (e1) {}
    // 2) métadonnées projet : Column.Intrinsic.MediaDuration (ticks ou timecode)
    try {
        var pm = pi.getProjectMetadata();
        var m = pm.match(/Column\.Intrinsic\.MediaDuration[^>]*>([^<]+)</);
        if (m) {
            var raw = m[1];
            var tc = raw.match(/(\d+)[:;](\d+)[:;](\d+)[:;](\d+)/);
            if (tc) {
                var fps = 25;
                try { fps = pi.getFootageInterpretation().frameRate; } catch (eF) {}
                var sec3 = Number(tc[1]) * 3600 + Number(tc[2]) * 60 + Number(tc[3]) + Number(tc[4]) / fps;
                log.push("durée média (métadonnées, " + raw + " @ " + fps + " i/s) : " + sec3.toFixed(3) + "s");
                return sec3;
            }
            var digits = raw.replace(/[^\d]/g, "");
            if (digits.length >= 11) { // ticks Premiere (254016000000 par seconde)
                var sec2 = Number(digits) / 254016000000;
                log.push("durée média (métadonnées, ticks) : " + sec2.toFixed(3) + "s");
                return sec2;
            }
            log.push("MediaDuration illisible : " + raw);
        }
    } catch (e2) {}
    return null;
}

// Pose les in/out "moniteur source" sur un projectItem (essaie secondes puis Time).
function _setPiInOut(pi, inSec, outSec) {
    try { pi.setInPoint(inSec, 4); pi.setOutPoint(outSec, 4); return "OK (secondes)"; }
    catch (e1) {
        try {
            pi.setInPoint(_t(inSec), 4); pi.setOutPoint(_t(outSec), 4);
            return "OK (Time)";
        } catch (e2) { return "ECHEC (" + e1 + " / " + e2 + ")"; }
    }
}

function _overwriteAt(track, pi, sec) {
    try { track.overwriteClip(pi, sec); return "OK (secondes)"; }
    catch (e1) {
        try { track.overwriteClip(pi, _t(sec)); return "OK (Time)"; }
        catch (e2) { return "ECHEC (" + e1 + " / " + e2 + ")"; }
    }
}

// Les in/out d'un trackItem ralenti sont exprimés en temps étiré par la vitesse
// (constaté : in 9.910s sur un média de 7.508s à 50 %) → conversion vers le temps source.
function _sourceRange(item) {
    var spd = 1;
    try { spd = Math.abs(item.getSpeed()) || 1; } catch (e) {}
    return { inSec: item.inPoint.seconds * spd, outSec: item.outPoint.seconds * spd, speed: spd };
}

// removeEmptyTracks n'existe pas sur QESequence en 26.x → essais + sonde des méthodes dispo.
function _removeEmptyTracks(qeSeq) {
    try { qeSeq.removeEmptyTracks(); return "OK (removeEmptyTracks)"; } catch (e1) {}
    try {
        qeSeq.removeEmptyVideoTracks();
        qeSeq.removeEmptyAudioTracks();
        return "OK (removeEmptyVideoTracks + removeEmptyAudioTracks)";
    } catch (e2) {}
    var names = [];
    try {
        var ms = qeSeq.reflect.methods;
        for (var i = 0; i < ms.length; i++) {
            var n = String(ms[i].name);
            if (n.toLowerCase().indexOf("track") >= 0 || n.toLowerCase().indexOf("remove") >= 0) names.push(n);
        }
    } catch (e3) {}
    return "ECHEC — méthodes QESequence candidates : " + (names.length ? names.join(", ") : "réflexion impossible");
}

// Trouve l'effet Warp Stabilizer quel que soit la langue de Premiere : noms candidats
// connus, puis balayage de la liste d'effets. La vérification définitive se fait après
// pose, via le matchName (identifiant interne indépendant de la locale).
var SW_WARP_MATCHNAME = "AE.ADBE SubspaceStabilizer";

function _findStabEffect(preferredName) {
    var candidates = [];
    if (preferredName) candidates.push(preferredName);
    candidates.push("Stabilisation", "Warp Stabilizer", "Stabilisation de déformation");
    for (var i = 0; i < candidates.length; i++) {
        try {
            var fx = qe.project.getVideoEffectByName(candidates[i]);
            if (fx) return { fx: fx, name: candidates[i] };
        } catch (e) {}
    }
    var list = qe.project.getVideoEffectList();
    for (var j = 0; j < list.length; j++) {
        if (/warp|stabil/i.test(list[j])) {
            try {
                var fx2 = qe.project.getVideoEffectByName(list[j]);
                if (fx2) return { fx: fx2, name: list[j] };
            } catch (e2) {}
        }
    }
    return null;
}

// Sous-élément vidéo seul, borné à la plage donnée (essaie Time, ticks, secondes).
function _createSubclipRange(pi, name, inSec, outSec) {
    var sub = null, note = "";
    try { sub = pi.createSubClip(name, _t(inSec), _t(outSec), 0, 1, 0); note = "OK (Time)"; }
    catch (e1) {
        try { sub = pi.createSubClip(name, _t(inSec).ticks, _t(outSec).ticks, 0, 1, 0); note = "OK (ticks)"; }
        catch (e2) {
            try { sub = pi.createSubClip(name, inSec, outSec, 0, 1, 0); note = "OK (secondes)"; }
            catch (e3) { note = "ECHEC (" + e1 + " / " + e3 + ")"; }
        }
    }
    return { sub: sub, note: note };
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
    var rng = _sourceRange(item);
    out.push("plage source réelle : " + rng.inSec.toFixed(3) + "s → " + rng.outSec.toFixed(3) +
        "s (in/out × vitesse " + rng.speed + ")");
    var bin = _findParentBin(app.project.rootItem, item.projectItem);
    out.push("chutier parent : " + (bin ? bin.name : "NON TROUVÉ"));
    var dur = _getMediaDurationSec(item.projectItem, out);
    if (dur === null) out.push("durée média : INTROUVABLE (bloquant pour le test 3)");
    return out.join("\n");
}

// ---------- test 3 : séquence _stab à 2 pistes dans le bon chutier ----------
// V1 = rush entier sans effet (piste témoin), V2 = plage dérushée seule (recevra le Warp).
// V1 : in/out posés sur le projectItem source (0 → durée réelle du média) avant création.
// V2 : sous-élément vidéo borné à la plage (overwriteClip ignore les in/out source —
// constaté sur Premiere 26).

function SW_createStabSeq() {
    var item = _getSelectedVideoClip();
    if (!item) return "ECHEC aucun clip vidéo sélectionné";
    $.global._swItem = item; // la sélection saute quand Premiere change de séquence → référence gardée pour les tests 5/6
    var origSeq = app.project.activeSequence;
    var pi = item.projectItem;
    var bin = _findParentBin(app.project.rootItem, pi) || app.project.rootItem;
    var baseName = pi.name.replace(/\.[^.]+$/, "");
    var name = baseName + "_stab";

    if (_findSequenceByName(name)) return "ECHEC la séquence \"" + name + "\" existe déjà (la supprimer pour re-tester)";

    var out = [];

    var mediaDur = _getMediaDurationSec(pi, out);
    if (mediaDur === null) return out.join("\n") + "\nECHEC durée du média introuvable (XMP et métadonnées muets)";

    // mémoriser les in/out posés par l'utilisateur dans le moniteur source (restaurés à la fin)
    var savedIn = null, savedOut = null;
    try { savedIn = pi.getInPoint(4).seconds; savedOut = pi.getOutPoint(4).seconds; }
    catch (eS) { try { savedIn = pi.getInPoint().seconds; savedOut = pi.getOutPoint().seconds; } catch (eS2) {} }

    // V1 = rush entier : in/out source posés sur 0 → durée réelle
    out.push("source posée sur 0 → " + mediaDur.toFixed(3) + "s : " + _setPiInOut(pi, 0, mediaDur));

    var seq;
    try {
        seq = app.project.createNewSequenceFromClips(name, [pi], bin);
    } catch (e) {
        return out.join("\n") + "\nECHEC createNewSequenceFromClips : " + e;
    }
    if (!seq) return out.join("\n") + "\nECHEC createNewSequenceFromClips a renvoyé " + seq;

    // Premiere 26 ignore le nom passé en paramètre → renommage explicite
    if (seq.name !== name) {
        try { seq.name = name; out.push("séquence renommée : " + seq.name); }
        catch (eN) { out.push("ECHEC renommage en \"" + name + "\" : " + eN); }
    }
    out.push("séquence créée dans \"" + bin.name + "\"");

    // les opérations QE ciblent la séquence active → s'assurer que c'est la nôtre
    try { app.project.activeSequence = seq; } catch (eAct) {}

    try {
        var v1 = seq.videoTracks[0].clips[0];
        out.push("V1 : in " + _fmt(v1.inPoint) + " / out " + _fmt(v1.outPoint) +
            " (attendu : 0 → " + mediaDur.toFixed(3) + "s)");
    } catch (eV1) { out.push("lecture V1 impossible : " + eV1); }

    // s'assurer qu'une piste V2 existe
    if (seq.videoTracks.numTracks < 2) {
        try {
            app.enableQE();
            qe.project.getActiveSequence().addTracks(1);
            out.push("piste V2 ajoutée via QE addTracks → numTracks = " + seq.videoTracks.numTracks);
        } catch (eT) { out.push("ECHEC ajout piste V2 (QE addTracks) : " + eT); }
    }

    // V2 : sous-élément vidéo borné à la plage dérushée (en temps SOURCE, pas en temps
    // étiré par la vitesse), posé au timecode source
    if (seq.videoTracks.numTracks >= 2) {
        var rng = _sourceRange(item);
        var srcIn = rng.inSec;
        var srcOut = Math.min(rng.outSec, mediaDur);
        if (srcIn >= mediaDur) {
            out.push("ECHEC plage source incohérente : in " + srcIn.toFixed(3) + "s ≥ durée média " + mediaDur.toFixed(3) + "s");
        } else {
            out.push("plage source (vitesse " + rng.speed + ") : " + srcIn.toFixed(3) + " → " + srcOut.toFixed(3) + "s");
            var r = _createSubclipRange(pi, name + "_zone", srcIn, srcOut);
            out.push("sous-élément " + name + "_zone : " + r.note);
            if (r.sub) {
                try { r.sub.moveBin(bin); } catch (eMv) {}
                var v2 = seq.videoTracks[1];
                out.push("pose sur V2 à " + srcIn.toFixed(3) + "s : " + _overwriteAt(v2, r.sub, srcIn));
                try {
                    var inner = v2.clips[0];
                    out.push("V2 : start " + _fmt(inner.start) + " / end " + _fmt(inner.end) +
                        " (attendu : " + srcIn.toFixed(3) + " → " + srcOut.toFixed(3) + "s)");
                    var ok = Math.abs(inner.start.seconds - srcIn) < 0.05 &&
                        Math.abs(inner.end.seconds - srcOut) < 0.05;
                    out.push("→ calage V2 " + (ok ? "OK" : "À VÉRIFIER (comparer aux valeurs attendues)"));
                } catch (e2) { out.push("lecture V2 impossible : " + e2); }
            }
        }
    }

    // restaurer les in/out source de l'utilisateur
    if (savedIn !== null) out.push("restauration in/out source : " + _setPiInOut(pi, savedIn, savedOut));

    // ménage : supprimer les pistes vides (audio en trop notamment) — sur la séquence ACTIVE
    try {
        app.enableQE();
        out.push("suppression des pistes vides : " + _removeEmptyTracks(qe.project.getActiveSequence()));
    } catch (eR) { out.push("suppression des pistes vides ECHEC : " + eR); }

    // revenir à la séquence de montage
    try { app.project.activeSequence = origSeq; }
    catch (eA) {
        try { app.project.openSequence(origSeq.sequenceID); }
        catch (eA2) { out.push("retour à la séquence d'origine ECHEC : " + eA2); }
    }

    out.push("SEQ=" + seq.name);
    return out.join("\n");
}

// ---------- test 4 : application du Warp via QE dans la séquence _stab ----------
// QE est fiable sur la séquence ACTIVE → on ouvre la _stab avant d'opérer, et on la
// laisse ouverte pour voir l'analyse démarrer.

function SW_applyWarp(effectName, seqName) {
    if (!seqName) return "ECHEC nom de séquence vide (lancer le test 3 d'abord)";
    var seq = _findSequenceByName(seqName);
    if (!seq) return "ECHEC séquence \"" + seqName + "\" introuvable";
    try { app.project.activeSequence = seq; }
    catch (eA) { try { app.project.openSequence(seq.sequenceID); } catch (eA2) {} }

    try {
        app.enableQE();
        var qeSeq = qe.project.getActiveSequence();
        if (!qeSeq || qeSeq.name !== seqName) qeSeq = _findQESequence(seqName);
        if (!qeSeq) return "ECHEC séquence \"" + seqName + "\" introuvable côté QE";

        var found = _findStabEffect(effectName);
        if (!found) return "ECHEC aucun effet de stabilisation trouvé, quel que soit le nom (vérifier avec le test 1)";

        // Cibler la piste la plus haute qui contient un clip (V2 = plage dérushée).
        for (var t = qeSeq.numVideoTracks - 1; t >= 0; t--) {
            var track = qeSeq.getVideoTrackAt(t);
            for (var j = 0; j < track.numItems; j++) {
                var qeItem = track.getItemAt(j);
                if (qeItem && qeItem.type !== "Empty") {
                    var ok = qeItem.addVideoEffect(found.fx);
                    var out = ["addVideoEffect(\"" + found.name + "\") sur \"" + qeItem.name +
                        "\" (piste V" + (t + 1) + ") → " + ok];
                    // vérification indépendante de la langue : matchName du composant posé
                    try {
                        var domClip = seq.videoTracks[t].clips[0];
                        var comps = [], isWarp = false;
                        for (var c = 0; c < domClip.components.numItems; c++) {
                            var comp = domClip.components[c];
                            comps.push(comp.displayName + " [" + comp.matchName + "]");
                            if (comp.matchName === SW_WARP_MATCHNAME) isWarp = true;
                        }
                        out.push(isWarp
                            ? "→ Warp Stabilizer CONFIRMÉ (matchName " + SW_WARP_MATCHNAME + ") ✔"
                            : "→ ATTENTION matchName " + SW_WARP_MATCHNAME + " absent ! Composants : " + comps.join(" ; "));
                    } catch (eC) { out.push("vérification matchName impossible : " + eC); }
                    out.push("La séquence " + seqName + " est ouverte : l'analyse doit démarrer toute seule, sur la plage dérushée uniquement.");
                    return out.join("\n");
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
    var item = _getSelectedVideoClip() || $.global._swItem;
    if (!item) return "ECHEC aucun clip vidéo sélectionné (et aucune référence mémorisée par le test 3)";
    var seq = _findSequenceByName(seqName);
    if (!seq) return "ECHEC séquence \"" + seqName + "\" introuvable";

    var stabPI;
    try { stabPI = seq.projectItem; } catch (e0) { return "ECHEC sequence.projectItem inaccessible : " + e0; }
    if (!stabPI) return "ECHEC sequence.projectItem est " + stabPI;

    var before = [];
    try { before = [item.getSpeed(), item.inPoint.seconds, item.outPoint.seconds,
                    item.start.seconds, item.end.seconds]; } catch (eB) {}

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

        // Premiere remet le in/out à zéro en changeant de source → recalage sur les
        // valeurs d'origine (le nest mappe 1:1 le temps source, donc mêmes valeurs)
        if (Math.abs(item.inPoint.seconds - before[1]) > 0.05 ||
            Math.abs(item.outPoint.seconds - before[2]) > 0.05) {
            try {
                item.inPoint = _t(before[1]);
                item.outPoint = _t(before[2]);
                out.push("recalage in/out : in " + item.inPoint.seconds.toFixed(3) +
                    "s / out " + item.outPoint.seconds.toFixed(3) +
                    "s (attendu " + before[1].toFixed(3) + " / " + before[2].toFixed(3) + ")");
                out.push("position clip : start " + item.start.seconds.toFixed(3) + "s / end " +
                    item.end.seconds.toFixed(3) + "s (attendu " + before[3].toFixed(3) + " / " +
                    before[4].toFixed(3) + " — vérifier qu'il n'a pas bougé)");
            } catch (eFix) { out.push("ECHEC recalage in/out : " + eFix); }
        }
    } catch (e2) {
        out.push("lecture post-swap impossible : " + e2);
    }
    out.push("→ vérifier visuellement : image stabilisée du nest, vitesse conservée, clip pas déplacé.");
    return out.join("\n");
}

// ---------- test 6 : QE setSpeed (risque n°2, plan B) ----------

function SW_qeSetSpeed(pct) {
    var domItem = _getSelectedVideoClip() || $.global._swItem;
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
