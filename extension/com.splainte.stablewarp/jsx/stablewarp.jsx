// StableWarp — cœur ExtendScript (ES3).
// Stabilisation de clips à vitesse modifiée via un « nest inversé » à deux pistes :
// V1 = rush entier témoin, V2 = plage dérushée + Warp Stabilizer à 100 %.
// Pièges Premiere 26 pris en compte (validés par le spike) :
//  - les in/out d'un trackItem ralenti sont en temps étiré → temps source = in/out × |vitesse|
//  - createNewSequenceFromClips ignore le nom passé et honore les in/out source
//  - setOutPoint ne se clampe pas à la fin du média → durée réelle lue via XMP/métadonnées
//  - overwriteClip ignore les in/out source → la V2 passe par un sous-élément borné
//  - les opérations QE exigent la séquence active
//  - affecter trackItem.projectItem remet le in/out à zéro → recalage après swap

var SW_WARP_MATCHNAME = "AE.ADBE SubspaceStabilizer";
var SW_SUFFIX = "_stab";
var SW_ZONE_BIN = "_StableWarp"; // chutier racine où sont rangés les sous-éléments _zone

// ---------- helpers génériques ----------

function _t(sec) {
    var t = new Time();
    t.seconds = sec;
    return t;
}

function _isStabName(name) {
    return name.length > SW_SUFFIX.length &&
        name.substr(name.length - SW_SUFFIX.length) === SW_SUFFIX;
}

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

function _zoneBin() {
    var root = app.project.rootItem;
    for (var i = 0; i < root.children.numItems; i++) {
        var c = root.children[i];
        if (c.type === ProjectItemType.BIN && c.name === SW_ZONE_BIN) return c;
    }
    try { return root.createBin(SW_ZONE_BIN); } catch (e) { return root; }
}

// Pas de suppression directe d'un élément dans l'API : on le déplace dans un chutier
// temporaire qu'on supprime avec son contenu.
function _deleteProjectItem(item) {
    try {
        var tmp = app.project.rootItem.createBin("_sw_tmp");
        item.moveBin(tmp);
        tmp.deleteBin();
        return true;
    } catch (e) { return false; }
}

// Ferme l'onglet de la séquence dans le panneau Montage (l'analyse Warp continue en fond).
// Comme les autres opérations QE, close() n'est fiable que sur la séquence ACTIVE →
// à appeler tant que la séquence est active, AVANT de revenir à la séquence de montage.
function _closeSequence(seq) {
    try {
        app.enableQE();
        var qeSeq = qe.project.getActiveSequence();
        if (qeSeq && qeSeq.name === seq.name) {
            try { qeSeq.close(); return true; } catch (e1) {}
        }
        for (var i = 0; i < qe.project.numSequences; i++) {
            var qs = qe.project.getSequenceAt(i);
            if (qs.name === seq.name) {
                try { qs.close(); return true; } catch (e2) {}
                try { qs.makeCurrent(); qe.project.getActiveSequence().close(); return true; } catch (e3) {}
            }
        }
    } catch (e) {}
    return false;
}

// Supprime les sous-éléments _zone dont la séquence _stab n'existe plus.
function _cleanOrphanZones() {
    try {
        var root = app.project.rootItem, binZ = null;
        for (var i = 0; i < root.children.numItems; i++) {
            var c = root.children[i];
            if (c.type === ProjectItemType.BIN && c.name === SW_ZONE_BIN) { binZ = c; break; }
        }
        if (!binZ) return "";
        var msgs = [];
        // itération à rebours : la suppression décale la collection
        for (var j = binZ.children.numItems - 1; j >= 0; j--) {
            var z = binZ.children[j];
            var m = z.name.match(/^(.*)_zone$/);
            if (!m) continue;
            if (!_findSequenceByName(m[1])) {
                if (_deleteProjectItem(z)) msgs.push("zone orpheline supprimée : " + z.name);
            }
        }
        return msgs.join("\n");
    } catch (e) { return ""; }
}

function _activate(seq) {
    try { app.project.activeSequence = seq; return true; }
    catch (e) {
        try { app.project.openSequence(seq.sequenceID); return true; }
        catch (e2) { return false; }
    }
}

// in/out d'un trackItem ralenti = temps étiré par la vitesse → conversion en temps source
function _sourceRange(item) {
    var spd = 1;
    try { spd = Math.abs(item.getSpeed()) || 1; } catch (e) {}
    return { inSec: item.inPoint.seconds * spd, outSec: item.outPoint.seconds * spd, speed: spd };
}

// durée réelle du média : XMP (xmpDM:duration), repli métadonnées projet
function _getMediaDurationSec(pi) {
    try {
        var xmp = pi.getXMPMetadata();
        var block = xmp.match(/xmpDM:duration[\s\S]{0,300}/);
        if (block) {
            var v = block[0].match(/xmpDM:value[="'\s>]+(\d+)/);
            var s = block[0].match(/xmpDM:scale[="'\s>]+(\d+)\/(\d+)/);
            if (v) {
                var sec = s ? Number(v[1]) * Number(s[1]) / Number(s[2]) : Number(v[1]);
                if (sec > 0 && sec < 360000) return sec;
            }
        }
    } catch (e1) {}
    try {
        var pm = pi.getProjectMetadata();
        var m = pm.match(/Column\.Intrinsic\.MediaDuration[^>]*>([^<]+)</);
        if (m) {
            var raw = m[1];
            var tc = raw.match(/(\d+)[:;](\d+)[:;](\d+)[:;](\d+)/);
            if (tc) {
                var fps = 25;
                try { fps = pi.getFootageInterpretation().frameRate; } catch (eF) {}
                return Number(tc[1]) * 3600 + Number(tc[2]) * 60 + Number(tc[3]) + Number(tc[4]) / fps;
            }
            var digits = raw.replace(/[^\d]/g, "");
            if (digits.length >= 11) return Number(digits) / 254016000000;
        }
    } catch (e2) {}
    return null;
}

function _setPiInOut(pi, inSec, outSec) {
    try { pi.setInPoint(inSec, 4); pi.setOutPoint(outSec, 4); return true; }
    catch (e1) {
        try { pi.setInPoint(_t(inSec), 4); pi.setOutPoint(_t(outSec), 4); return true; }
        catch (e2) { return false; }
    }
}

// Après un swap de source, Premiere peut laisser le clip noir jusqu'à un
// désactiver/réactiver — on automatise ce rafraîchissement (invisible).
function _refreshTrackItem(item) {
    try { item.disabled = true; item.disabled = false; } catch (e) {}
}

function _overwriteAt(track, pi, sec) {
    try { track.overwriteClip(pi, sec); return true; }
    catch (e1) {
        try { track.overwriteClip(pi, _t(sec)); return true; }
        catch (e2) { return false; }
    }
}

function _createSubclipRange(pi, name, inSec, outSec) {
    try { return pi.createSubClip(name, _t(inSec), _t(outSec), 0, 1, 0); }
    catch (e1) {
        try { return pi.createSubClip(name, _t(inSec).ticks, _t(outSec).ticks, 0, 1, 0); }
        catch (e2) {
            try { return pi.createSubClip(name, inSec, outSec, 0, 1, 0); }
            catch (e3) { return null; }
        }
    }
}

function _removeEmptyTracks(qeSeq) {
    try { qeSeq.removeEmptyVideoTracks(); qeSeq.removeEmptyAudioTracks(); return true; }
    catch (e) {
        try { qeSeq.removeEmptyTracks(); return true; } catch (e2) { return false; }
    }
}

// effet Warp Stabilizer quelle que soit la langue de Premiere
function _findStabEffect() {
    var candidates = ["Stabilisation", "Warp Stabilizer", "Stabilisation de déformation"];
    for (var i = 0; i < candidates.length; i++) {
        try {
            var fx = qe.project.getVideoEffectByName(candidates[i]);
            if (fx) return fx;
        } catch (e) {}
    }
    try {
        var list = qe.project.getVideoEffectList();
        for (var j = 0; j < list.length; j++) {
            if (/warp|stabil/i.test(list[j])) {
                var fx2 = qe.project.getVideoEffectByName(list[j]);
                if (fx2) return fx2;
            }
        }
    } catch (e2) {}
    return null;
}

// Pose le Warp sur le clipIdx-ième clip de la piste trackIdx de la séquence (rendue
// active), vérifié par matchName. Correspondance DOM↔QE : k-ième clip = k-ième item
// non vide. Renvoie "" si OK, sinon l'erreur.
function _applyWarpToClipAt(seq, trackIdx, clipIdx) {
    if (!_activate(seq)) return "activation de " + seq.name + " impossible";
    app.enableQE();
    var qeSeq = qe.project.getActiveSequence();
    if (!qeSeq || qeSeq.name !== seq.name) return "séquence " + seq.name + " introuvable côté QE";
    var fx = _findStabEffect();
    if (!fx) return "effet Warp Stabilizer introuvable";
    var qeTrack = qeSeq.getVideoTrackAt(trackIdx);
    var rank = -1;
    for (var j = 0; j < qeTrack.numItems; j++) {
        var qi = qeTrack.getItemAt(j);
        if (!qi || qi.type === "Empty") continue;
        rank++;
        if (rank !== clipIdx) continue;
        try { qi.addVideoEffect(fx); }
        catch (e) { return "addVideoEffect : " + e; }
        try {
            var domClip = seq.videoTracks[trackIdx].clips[clipIdx];
            return _hasWarp(domClip) ? "" : "effet posé mais matchName " + SW_WARP_MATCHNAME + " absent (mauvais effet ?)";
        } catch (eC) { return ""; } // pose OK, vérification impossible : on laisse passer
    }
    return "clip " + clipIdx + " introuvable sur la piste V" + (trackIdx + 1) + " côté QE";
}

// ---------- couverture de la zone stabilisée ----------

// S'assure que [wantIn, wantOut] (temps source) est couvert par UN segment de la V2.
// La V2 porte un segment (sous-élément + Warp) PAR extrait utilisé : deux extraits
// disjoints du même rush = deux analyses séparées, le rush entre les deux est ignoré.
// Si la plage demandée chevauche un ou plusieurs segments, ils fusionnent ; si elle est
// disjointe, un nouveau segment est ajouté. "" si déjà couvert, message sinon.
function _ensureCoverage(stabSeq, wantIn, wantOut) {
    try {
        if (stabSeq.videoTracks.numTracks < 2) return "ECHEC structure inattendue (pas de V2) dans " + stabSeq.name;
        var v1 = stabSeq.videoTracks[0].clips[0];
        var mediaDur = v1.end.seconds;
        wantIn = Math.max(0, wantIn);
        wantOut = Math.min(wantOut, mediaDur);
        if (wantOut - wantIn <= 0.001) return "ECHEC plage demandée invalide";
        var v2t = stabSeq.videoTracks[1];

        var EPS = 0.02;
        var newIn = wantIn, newOut = wantOut;
        var replaced = []; // zones des segments fusionnés, à supprimer après
        var merged = false;
        for (var i = 0; i < v2t.clips.numItems; i++) {
            var s = v2t.clips[i].start.seconds, e = v2t.clips[i].end.seconds;
            if (wantIn >= s - EPS && wantOut <= e + EPS) return ""; // déjà couvert par ce segment
            if (wantIn < e + EPS && wantOut > s - EPS) { // chevauchement → fusion
                merged = true;
                if (s < newIn) newIn = s;
                if (e > newOut) newOut = e;
                try { replaced.push(v2t.clips[i].projectItem); } catch (eP) {}
            }
        }

        var pi = v1.projectItem;
        var sub = _createSubclipRange(pi, stabSeq.name + "_zone", newIn, newOut);
        if (!sub) return "ECHEC création du sous-élément de segment";
        try { sub.moveBin(_zoneBin()); } catch (eMv) {}

        var orig = app.project.activeSequence;
        _activate(stabSeq);
        // la fusion couvre les segments chevauchés : l'overwrite les remplace intégralement,
        // les segments disjoints ne sont pas touchés
        if (!_overwriteAt(v2t, sub, newIn)) { if (orig) _activate(orig); return "ECHEC pose du segment"; }

        var k = -1;
        for (var i2 = 0; i2 < v2t.clips.numItems; i2++) {
            if (Math.abs(v2t.clips[i2].start.seconds - newIn) < EPS) { k = i2; break; }
        }
        var warpErr = k >= 0 ? _applyWarpToClipAt(stabSeq, 1, k) : "nouveau segment introuvable sur V2";

        _closeSequence(stabSeq); // pendant qu'elle est encore active
        if (orig) _activate(orig);

        // les zones fusionnées ne sont plus référencées → suppression (garde-fou : jamais le rush)
        for (var r = 0; r < replaced.length; r++) {
            var z = replaced[r];
            if (z && z.name.indexOf("_zone") >= 0 && z.nodeId !== pi.nodeId) _deleteProjectItem(z);
        }

        return (merged ? "segment stabilisé étendu : " : "nouveau segment stabilisé : ") +
            newIn.toFixed(2) + "s → " + newOut.toFixed(2) + "s" +
            (warpErr ? " MAIS Warp : " + warpErr : ", analyse lancée");
    } catch (e) {
        return "ECHEC couverture : " + e;
    }
}

// Pose le Warp directement sur un clip de montage à vitesse 100 % (pas besoin de nest).
// Correspondance DOM↔QE : le k-ième clip DOM d'une piste = le k-ième item non vide QE.
function _applyWarpDirect(item, montageSeq) {
    try {
        for (var c0 = 0; c0 < item.components.numItems; c0++) {
            if (item.components[c0].matchName === SW_WARP_MATCHNAME) return "déjà stabilisé (Warp présent)";
        }
    } catch (e0) {}
    _activate(montageSeq);
    app.enableQE();
    var qeSeq = qe.project.getActiveSequence();
    if (!qeSeq) return "ECHEC séquence introuvable côté QE";
    var fx = _findStabEffect();
    if (!fx) return "ECHEC effet Warp Stabilizer introuvable";
    for (var t = 0; t < montageSeq.videoTracks.numTracks; t++) {
        var tr = montageSeq.videoTracks[t];
        for (var k = 0; k < tr.clips.numItems; k++) {
            var c2 = tr.clips[k];
            if (c2.name !== item.name || Math.abs(c2.start.seconds - item.start.seconds) > 0.001) continue;
            var qeTrack = qeSeq.getVideoTrackAt(t);
            var rank = -1;
            for (var j = 0; j < qeTrack.numItems; j++) {
                var qi = qeTrack.getItemAt(j);
                if (!qi || qi.type === "Empty") continue;
                rank++;
                if (rank !== k) continue;
                try { qi.addVideoEffect(fx); } catch (eA) { return "ECHEC addVideoEffect : " + eA; }
                try {
                    for (var v = 0; v < item.components.numItems; v++) {
                        if (item.components[v].matchName === SW_WARP_MATCHNAME) return "";
                    }
                    return "effet posé mais matchName non vérifié (mauvais effet ?)";
                } catch (eV) { return ""; }
            }
        }
    }
    return "ECHEC clip introuvable côté QE";
}

function _hasWarp(item) {
    try {
        for (var c = 0; c < item.components.numItems; c++) {
            if (item.components[c].matchName === SW_WARP_MATCHNAME) return true;
        }
    } catch (e) {}
    return false;
}

// Composants autres que les intrinsèques (Opacité/Trajectoire/Remappage…) et le Warp.
// Renvoie la liste des matchNames inconnus (vide = rien d'autre que le Warp).
function _userEffects(item) {
    var intrinsics = { "AE.ADBE Opacity": 1, "PR.ADBE Motion": 1, "AE.ADBE Motion": 1,
                       "AE.ADBE Vector Motion": 1, "PR.ADBE Vector Motion": 1,
                       "AE.ADBE Time Remapping": 1, "AE.ADBE Audio Levels": 1,
                       "AE.ADBE Sound Levels": 1, "PR.ADBE Audio Channel Mapper": 1,
                       "PR.ADBE Audio Channel Volume": 1, "PR.ADBE Channel Volume": 1 };
    var out = [];
    try {
        for (var c = 0; c < item.components.numItems; c++) {
            var mn = item.components[c].matchName;
            if (!intrinsics[mn] && mn !== SW_WARP_MATCHNAME) out.push(mn);
        }
    } catch (e) {}
    return out;
}

// Retire le Warp posé directement sur un clip de montage. "" si OK, message sinon.
// 1) component.remove() ciblé (sans risque pour les autres effets) ;
// 2) QE removeEffects, uniquement si le clip n'a AUCUN autre effet utilisateur
//    (sémantique incertaine — on ne risque pas un Lumetri) ; sonde sinon.
function _removeWarpDirect(item, montageSeq) {
    var compProbe = [];
    try {
        for (var c = 0; c < item.components.numItems; c++) {
            var comp = item.components[c];
            if (comp.matchName !== SW_WARP_MATCHNAME) continue;
            try { comp.remove(); } catch (e1) {
                try {
                    var cms = comp.reflect.methods;
                    for (var cm = 0; cm < cms.length; cm++) {
                        if (/remove|delete/i.test(String(cms[cm].name))) compProbe.push(String(cms[cm].name));
                    }
                } catch (e1b) {}
            }
            if (!_hasWarp(item)) return "";
        }
    } catch (e0) {}

    var others = _userEffects(item);
    if (others.length > 0) {
        return "ECHEC suppression auto du Warp — effets non identifiés sur le clip : " + others.join(", ") +
            (compProbe.length ? " ; méthodes composant : " + compProbe.join(", ") : "") +
            " — supprimer l'effet Stabilisation à la main puis cliquer Stabiliser";
    }
    try {
        _activate(montageSeq);
        app.enableQE();
        var qeSeq = qe.project.getActiveSequence();
        for (var t = 0; t < montageSeq.videoTracks.numTracks; t++) {
            var tr = montageSeq.videoTracks[t];
            for (var k = 0; k < tr.clips.numItems; k++) {
                var c2 = tr.clips[k];
                if (c2.name !== item.name || Math.abs(c2.start.seconds - item.start.seconds) > 0.001) continue;
                var qeTrack = qeSeq.getVideoTrackAt(t);
                var rank = -1;
                for (var j = 0; j < qeTrack.numItems; j++) {
                    var qi = qeTrack.getItemAt(j);
                    if (!qi || qi.type === "Empty") continue;
                    rank++;
                    if (rank !== k) continue;
                    try { qi.removeEffects(0, 0, true, false, false); } catch (e2) {}
                    if (!_hasWarp(item)) return "";
                    try { qi.removeEffects(); } catch (e3) {}
                    if (!_hasWarp(item)) return "";
                    var names = [];
                    try {
                        var ms = qi.reflect.methods;
                        for (var m = 0; m < ms.length; m++) {
                            var n = String(ms[m].name);
                            if (/remove|effect|component/i.test(n)) names.push(n);
                        }
                    } catch (e4) {}
                    return "ECHEC suppression du Warp — méthodes QE candidates : " + (names.length ? names.join(", ") : "réflexion impossible");
                }
            }
        }
    } catch (e5) {}
    return "ECHEC suppression du Warp (clip introuvable côté QE)";
}

// Cas « stab directe puis vitesse changée » : retire le Warp direct puis refait une
// stabilisation nest — appelé par le watcher pour une transparence totale.
function _migrateDirectToNest(item, montageSeq) {
    var rm = _removeWarpDirect(item, montageSeq);
    if (rm !== "") return rm;
    return _stabilizeOne(item, 0);
}

// ---------- stabilisation d'un clip ----------

function _stabilizeOne(item, marges) {
    var lbl = item.name + " : ";
    var reversed = false;
    try { reversed = !!item.isSpeedReversed(); } catch (eR) {}

    var pi = item.projectItem;
    if (!pi) return lbl + "ECHEC pas de source";

    // clip déjà swappé vers un nest _stab → simple vérification/extension de couverture
    if (_isStabName(pi.name)) {
        var stabSeq0 = _findSequenceByName(pi.name);
        if (!stabSeq0) return lbl + "ECHEC séquence " + pi.name + " introuvable";
        var rng0 = _sourceRange(item);
        var ext = _ensureCoverage(stabSeq0, rng0.inSec - marges, rng0.outSec + marges);
        return lbl + (ext === "" ? "déjà stabilisé, couverture OK" : ext);
    }

    // vitesse 100 % non inversée : pose directe de l'effet, comme à la main — pas de nest
    // (un clip inversé, même à -100 %, est refusé par le Warp natif → nest obligatoire)
    var spd = 1;
    try { spd = item.getSpeed(); } catch (eSp) {}
    if (!reversed && Math.abs(spd - 1) < 0.0001) {
        var direct = _applyWarpDirect(item, $.global._swMontageSeq || app.project.activeSequence);
        return lbl + (direct === "" ? "stabilisé directement (vitesse 100 %, analyse en cours)" : direct);
    }

    var bin = _findParentBin(app.project.rootItem, pi) || app.project.rootItem;
    var name = pi.name.replace(/\.[^.]+$/, "") + SW_SUFFIX;
    var rng = _sourceRange(item);
    var stabSeq = _findSequenceByName(name);

    if (stabSeq) {
        // nest déjà créé pour ce rush (autre utilisation) → réutilisation
        var ext2 = _ensureCoverage(stabSeq, rng.inSec - marges, rng.outSec + marges);
        if (ext2.indexOf("ECHEC") === 0) return lbl + ext2;
    } else {
        var mediaDur = _getMediaDurationSec(pi);
        if (mediaDur === null) return lbl + "ECHEC durée du média introuvable (XMP/métadonnées)";
        var srcIn = Math.max(0, rng.inSec - marges);
        var srcOut = Math.min(mediaDur, rng.outSec + marges);
        if (srcIn >= mediaDur) return lbl + "ECHEC plage source hors média (clip remappé ?)";

        // V1 = rush entier : in/out source posés sur 0 → durée réelle, puis restaurés
        var savedIn = null, savedOut = null;
        try { savedIn = pi.getInPoint(4).seconds; savedOut = pi.getOutPoint(4).seconds; } catch (eS) {}
        _setPiInOut(pi, 0, mediaDur);
        try { stabSeq = app.project.createNewSequenceFromClips(name, [pi], bin); }
        catch (eC) { stabSeq = null; }
        if (!stabSeq) {
            if (savedIn !== null) _setPiInOut(pi, savedIn, savedOut);
            return lbl + "ECHEC création de la séquence " + name;
        }
        if (stabSeq.name !== name) { try { stabSeq.name = name; } catch (eN) {} }
        _activate(stabSeq);

        if (stabSeq.videoTracks.numTracks < 2) {
            try { app.enableQE(); qe.project.getActiveSequence().addTracks(1); } catch (eT) {}
        }
        if (stabSeq.videoTracks.numTracks < 2) {
            if (savedIn !== null) _setPiInOut(pi, savedIn, savedOut);
            return lbl + "ECHEC impossible d'obtenir une piste V2";
        }

        var sub = _createSubclipRange(pi, name + "_zone", srcIn, srcOut);
        if (!sub) {
            if (savedIn !== null) _setPiInOut(pi, savedIn, savedOut);
            return lbl + "ECHEC création du sous-élément";
        }
        try { sub.moveBin(_zoneBin()); } catch (eMv) {}
        if (!_overwriteAt(stabSeq.videoTracks[1], sub, srcIn)) {
            if (savedIn !== null) _setPiInOut(pi, savedIn, savedOut);
            return lbl + "ECHEC pose de la zone sur V2";
        }
        if (savedIn !== null) _setPiInOut(pi, savedIn, savedOut);

        try { app.enableQE(); _removeEmptyTracks(qe.project.getActiveSequence()); } catch (eRm) {}

        var warpErr = _applyWarpToClipAt(stabSeq, 1, 0);
        if (warpErr) return lbl + "ECHEC Warp : " + warpErr;
        _closeSequence(stabSeq); // pendant qu'elle est encore active
    }

    // swap de la source du clip timeline vers le nest, vitesse/position conservées
    var before = [item.getSpeed(), item.inPoint.seconds, item.outPoint.seconds];
    try { item.projectItem = stabSeq.projectItem; }
    catch (eSw) { return lbl + "ECHEC swap de source : " + eSw; }
    // Premiere remet le in/out à zéro → recalage (le nest mappe 1:1 le temps source)
    if (Math.abs(item.inPoint.seconds - before[1]) > 0.05 ||
        Math.abs(item.outPoint.seconds - before[2]) > 0.05) {
        try { item.inPoint = _t(before[1]); item.outPoint = _t(before[2]); }
        catch (eFix) { return lbl + "stabilisé MAIS recalage in/out en échec : " + eFix; }
    }
    _refreshTrackItem(item);
    return lbl + "stabilisé → " + name + " (analyse en cours)" +
        (reversed ? " — clip inversé : vérifier que la zone stabilisée correspond à l'image" : "");
}

// ---------- API panneau ----------

function SW_stabilizeSelection(marges) {
    if (!app.project) return "ECHEC aucun projet ouvert";
    var seq = app.project.activeSequence;
    if (!seq) return "ECHEC aucune séquence active";
    marges = Number(marges) || 0;

    var sel = seq.getSelection();
    var items = [];
    for (var i = 0; i < sel.length; i++) {
        if (sel[i].mediaType === "Video") items.push(sel[i]);
    }
    if (items.length === 0) return "ECHEC sélectionne au moins un clip vidéo dans la timeline";

    $.global._swMontageSeq = seq;
    var results = [];
    for (var j = 0; j < items.length; j++) {
        try { results.push(_stabilizeOne(items[j], marges)); }
        catch (e) { results.push(items[j].name + " : ECHEC " + e); }
    }
    _activate(seq);
    return results.join("\n");
}

// Une séquence _stab est-elle encore référencée par un clip de montage ?
function _stabStillUsed(name) {
    for (var i = 0; i < app.project.sequences.numSequences; i++) {
        var sq = app.project.sequences[i];
        if (_isStabName(sq.name)) continue;
        for (var t = 0; t < sq.videoTracks.numTracks; t++) {
            var tr = sq.videoTracks[t];
            for (var c = 0; c < tr.clips.numItems; c++) {
                try {
                    if (tr.clips[c].projectItem && tr.clips[c].projectItem.name === name) return true;
                } catch (e) {}
            }
        }
    }
    return false;
}

function _deleteZonesFor(name) {
    var root = app.project.rootItem;
    for (var i = 0; i < root.children.numItems; i++) {
        var c = root.children[i];
        if (c.type === ProjectItemType.BIN && c.name === SW_ZONE_BIN) {
            for (var j = c.children.numItems - 1; j >= 0; j--) {
                if (c.children[j].name === name + "_zone") _deleteProjectItem(c.children[j]);
            }
        }
    }
}

// Restaure le rush d'origine sur les clips sélectionnés (l'inverse de Stabiliser), puis
// supprime la séquence _stab et sa _zone si plus rien ne les utilise (chutiers clean —
// quitte à refaire l'analyse si on re-stabilise plus tard).
function SW_unstabilizeSelection() {
    if (!app.project) return "ECHEC aucun projet ouvert";
    var seq = app.project.activeSequence;
    if (!seq) return "ECHEC aucune séquence active";
    var sel = seq.getSelection();
    var results = [];
    var touched = []; // noms des _stab dont on vient de retirer une instance
    for (var i = 0; i < sel.length; i++) {
        var item = sel[i];
        if (item.mediaType !== "Video") continue;
        var lbl = item.name + " : ";
        var pi = item.projectItem;
        if (!pi || !_isStabName(pi.name)) { results.push(lbl + "ignoré (pas stabilisé par StableWarp)"); continue; }
        var stabSeq = _findSequenceByName(pi.name);
        if (!stabSeq) { results.push(lbl + "ECHEC séquence " + pi.name + " introuvable"); continue; }
        var rushPI = null;
        try { rushPI = stabSeq.videoTracks[0].clips[0].projectItem; } catch (e) {}
        if (!rushPI) { results.push(lbl + "ECHEC rush d'origine introuvable dans " + pi.name); continue; }
        var before = [item.inPoint.seconds, item.outPoint.seconds];
        try { item.projectItem = rushPI; }
        catch (eSw) { results.push(lbl + "ECHEC swap retour : " + eSw); continue; }
        if (Math.abs(item.inPoint.seconds - before[0]) > 0.05 ||
            Math.abs(item.outPoint.seconds - before[1]) > 0.05) {
            try { item.inPoint = _t(before[0]); item.outPoint = _t(before[1]); } catch (eFix) {}
        }
        _refreshTrackItem(item);
        results.push(lbl + "rush d'origine restauré");
        var known = false;
        for (var k = 0; k < touched.length; k++) { if (touched[k] === pi.name) { known = true; break; } }
        if (!known) touched.push(pi.name);
    }
    if (results.length === 0) return "ECHEC sélectionne au moins un clip vidéo";

    // ménage : supprimer les nests devenus inutiles (et leurs zones)
    for (var n = 0; n < touched.length; n++) {
        var name = touched[n];
        if (_stabStillUsed(name)) {
            results.push(name + " conservé (encore utilisé ailleurs dans le montage)");
            continue;
        }
        var s = _findSequenceByName(name);
        if (s) {
            _closeSequence(s);
            if (_deleteProjectItem(s.projectItem)) results.push(name + " supprimé du chutier");
        }
        _deleteZonesFor(name);
    }
    return results.join("\n");
}

// ---------- détecteur de bandeau bleu (analyse Warp non faite) ----------

var SW_BANNER_MAX_TRIES = 2;

// Décide, pour un Warp NON analysé, s'il faut relancer son analyse maintenant.
// Garde-fou : on ne relance que si le compteur d'analyse est FIGÉ d'un tick à
// l'autre (sinon une analyse est déjà en cours, on n'y touche pas) et tant
// qu'on n'a pas épuisé le quota de tentatives. Retourne :
//   "init"/"analyzing"/"wait" → ne rien faire ; "due" → relancer ;
//   "giveup-now" → abandon (logguer une fois) ; "gaveup" → silencieux.
function _bannerDecide(key, comp) {
    if (!$.global._swBanner) $.global._swBanner = {};
    var st = $.global._swBanner[key];
    var c = _warpCounter(comp);
    if (!st) { $.global._swBanner[key] = { counter: c, frozen: 0, tries: 0, gaveUp: false }; return "init"; }
    if (st.gaveUp) return "gaveup";
    if (c !== st.counter) { st.counter = c; st.frozen = 0; return "analyzing"; } // compteur bouge = en cours
    st.frozen++;
    if (st.frozen < 1) return "wait";
    if (st.tries >= SW_BANNER_MAX_TRIES) { st.gaveUp = true; return "giveup-now"; }
    return "due";
}
function _bannerDidRelaunch(key) {
    var st = $.global._swBanner[key];
    if (st) { st.tries++; st.frozen = 0; }
}
function _bannerClear(key, seen) {
    seen[key] = 1;
    if ($.global._swBanner && $.global._swBanner[key]) delete $.global._swBanner[key];
}

// Tick du watcher : (1) si restab, étend la couverture des nests _stab débordés et
// migre les stabs directes invalidées ; (2) si banner, détecte les Warp non analysés
// (bandeau bleu « Cliquez sur Analyser ») et relance leur analyse, direct comme nest.
// Renvoie "" si rien à faire (cas normal, pas de log).
function SW_watchTick(restab, banner) {
    try {
        if (!app.project || !app.project.activeSequence) return "";
        var seq = app.project.activeSequence;
        if (_isStabName(seq.name)) return ""; // ne pas surveiller l'intérieur d'un nest
        restab = (restab === undefined) ? true : !!Number(restab);
        banner = !!Number(banner);
        var marges = 0;

        $.global._swMontageSeq = seq;
        if (!$.global._swBanner) $.global._swBanner = {};
        var msgs = [];
        var seen = {}; // clés de bandeau vues ce tick (purge des obsolètes en fin)

        for (var t = 0; t < seq.videoTracks.numTracks; t++) {
            var tr = seq.videoTracks[t];
            for (var c = 0; c < tr.clips.numItems; c++) {
                var clip = tr.clips[c];
                var pi = null;
                try { pi = clip.projectItem; } catch (eP) {}
                if (!pi) continue;

                if (_isStabName(pi.name)) {
                    var stabSeq = _findSequenceByName(pi.name);
                    if (!stabSeq) continue;
                    if (restab) {
                        var rng = _sourceRange(clip);
                        var res = _ensureCoverage(stabSeq, rng.inSec - marges, rng.outSec + marges);
                        if (res !== "") msgs.push(clip.name + " : " + res);
                    }
                    if (banner) _bannerScanNest(stabSeq, seen, msgs);
                    continue;
                }

                // ----- clip à effet direct -----
                var spd = 1, rev = false;
                try { spd = clip.getSpeed(); } catch (eS) {}
                try { rev = !!clip.isSpeedReversed(); } catch (eRv) {}

                // stab directe devenue invalide (vitesse changée ou inversée après coup)
                if (restab && (Math.abs(spd - 1) > 0.0001 || rev) && _hasWarp(clip)) {
                    if (!$.global._swMigrFail) $.global._swMigrFail = {};
                    var key = clip.name + "@" + clip.start.seconds.toFixed(2) + "@" + spd + (rev ? "R" : "");
                    if (!$.global._swMigrFail[key]) {
                        msgs.push(clip.name + " : vitesse modifiée après stab directe → migration vers nest…");
                        var mres = _migrateDirectToNest(clip, seq);
                        msgs.push(mres);
                        if (mres.indexOf("ECHEC") >= 0) {
                            $.global._swMigrFail[key] = true;
                            msgs.push("(pas de nouvelle tentative tant que la vitesse de ce clip ne rechange pas)");
                        }
                    }
                    continue; // la migration repose un Warp neuf : pas de détection de bandeau ce tick
                }

                // bandeau bleu sur une stab directe valide (vitesse 100 %, non inversée)
                if (banner && Math.abs(spd - 1) < 0.0001 && !rev) {
                    var wc = _warpComp(clip);
                    if (!wc) continue;
                    var bkey = "D:" + t + ":" + clip.name + "@" + clip.start.seconds.toFixed(2);
                    if (_warpAnalyzed(wc)) { _bannerClear(bkey, seen); continue; }
                    seen[bkey] = 1;
                    var d = _bannerDecide(bkey, wc);
                    if (d === "due") {
                        var rm = _removeWarpDirect(clip, seq);
                        var add = (rm === "") ? _applyWarpDirect(clip, seq) : rm;
                        _bannerDidRelaunch(bkey);
                        msgs.push(clip.name + " : bandeau bleu détecté → " +
                            (add === "" ? "analyse relancée" : "ECHEC relance : " + add));
                    } else if (d === "giveup-now") {
                        msgs.push(clip.name + " : analyse impossible à relancer après " +
                            SW_BANNER_MAX_TRIES + " essais — laissé tel quel");
                    }
                }
            }
        }

        // purge des entrées de bandeau qui ne correspondent plus à aucun clip présent
        for (var pk in $.global._swBanner) {
            if ($.global._swBanner.hasOwnProperty(pk) && !seen[pk]) delete $.global._swBanner[pk];
        }

        if (restab) {
            var orphans = _cleanOrphanZones();
            if (orphans) msgs.push(orphans);
        }
        return msgs.join("\n");
    } catch (e) {
        return "watcher : " + e;
    }
}

// Détecte/relance les bandeaux bleus des segments V2 d'un nest. Lecture seule pour
// la détection ; n'active la séquence (via _reanalyzeNestSegment) que si une relance
// est réellement due, puis referme l'onglet et restaure la séquence de montage.
function _bannerScanNest(stabSeq, seen, msgs) {
    try {
        if (stabSeq.videoTracks.numTracks < 2) return;
        var v2 = stabSeq.videoTracks[1];
        var due = [];
        for (var k = 0; k < v2.clips.numItems; k++) {
            var w = _warpComp(v2.clips[k]);
            if (!w) continue;
            var bkey = "N:" + stabSeq.name + "#" + k;
            if (_warpAnalyzed(w)) { _bannerClear(bkey, seen); continue; }
            seen[bkey] = 1;
            var d = _bannerDecide(bkey, w);
            if (d === "due") due.push({ idx: k, key: bkey });
            else if (d === "giveup-now")
                msgs.push(stabSeq.name + " #" + k + " : analyse impossible à relancer — laissé tel quel");
        }
        if (!due.length) return;
        var orig = app.project.activeSequence;
        for (var i = 0; i < due.length; i++) {
            var rr = _reanalyzeNestSegment(stabSeq, due[i].idx);
            _bannerDidRelaunch(due[i].key);
            msgs.push(stabSeq.name + " #" + due[i].idx + " : bandeau bleu détecté → " +
                (rr === "" ? "analyse relancée" : "ECHEC relance : " + rr));
        }
        _closeSequence(stabSeq);
        if (orig) _activate(orig);
    } catch (e) {
        msgs.push("détecteur bandeau (" + stabSeq.name + ") : " + e);
    }
}

function SW_env() {
    return "Premiere " + app.version + " — " + (app.project ? app.project.name : "aucun projet");
}

// ---------- SONDE TEMPORAIRE : diagnostic état d'analyse Warp (à retirer) ----------
// Dump complet des propriétés du Warp, pour trouver un signal « analysé / bandeau
// bleu » qui PERSISTE après réouverture du projet.

function _dumpWarpComp(comp, indent) {
    var s = indent + "WARP " + comp.matchName;
    try { s += " (\"" + comp.displayName + "\")"; } catch (eD) {}
    try {
        var props = comp.properties;
        s += " — " + props.numItems + " propriété(s)";
        for (var p = 0; p < props.numItems; p++) {
            var pr = props[p];
            var nm = "?"; try { nm = pr.displayName; } catch (e1) {}
            var val = "?";
            try { val = String(pr.getValue()); }
            catch (e2) { val = "<getValue KO: " + e2 + ">"; }
            if (val.length > 80) val = val.substring(0, 80) + "…(" + val.length + " car.)";
            s += "\n" + indent + "  [" + p + "] " + nm + " = " + val;
        }
    } catch (eP) { s += "\n" + indent + "  <properties inaccessibles: " + eP + ">"; }
    return s;
}

function SW_diagWarp() {
    try {
        if (!app.project) return "ECHEC aucun projet";
        var seq = app.project.activeSequence;
        if (!seq) return "ECHEC aucune séquence active";
        var sel = seq.getSelection();
        if (!sel || !sel.length) return "ECHEC sélectionne au moins un clip";
        var out = [];
        for (var i = 0; i < sel.length; i++) {
            var clip = sel[i];
            if (clip.mediaType !== "Video") continue;
            out.push("══ CLIP: " + clip.name);
            var pi = null; try { pi = clip.projectItem; } catch (eP0) {}
            if (pi && _isStabName(pi.name)) {
                var ss = _findSequenceByName(pi.name);
                if (!ss || ss.videoTracks.numTracks < 2) { out.push("  nest sans V2"); continue; }
                var v2 = ss.videoTracks[1];
                for (var k = 0; k < v2.clips.numItems; k++) {
                    var w = _warpComp(v2.clips[k]);
                    if (w) { out.push("  segment V2 #" + k); out.push(_dumpWarpComp(w, "    ")); }
                }
            } else {
                var wc = _warpComp(clip);
                out.push(wc ? _dumpWarpComp(wc, "  ") : "  aucun Warp direct");
            }
        }
        return out.length ? out.join("\n") : "aucun clip vidéo sélectionné";
    } catch (e) { return "diag : " + e; }
}

// ---------- helpers de détection de l'état d'analyse du Warp ----------

// Le Warp du clip (ou null). Détection de l'état d'analyse via la propriété #0
// (booléen sans nom) : true = analysé, false = bandeau bleu « Cliquez sur Analyser ».
function _warpComp(item) {
    try {
        for (var c = 0; c < item.components.numItems; c++) {
            if (item.components[c].matchName === SW_WARP_MATCHNAME) return item.components[c];
        }
    } catch (e) {}
    return null;
}
function _warpAnalyzed(comp) {
    try { return comp.properties[0].getValue() === true; }
    catch (e) { return true; } // illisible → on considère analysé pour ne rien casser
}
// Compteur d'analyse (figé = bloqué/jamais lancé, en hausse = analyse en cours).
function _warpCounter(comp) {
    try { return Number(comp.properties[comp.properties.numItems - 1].getValue()); }
    catch (e) { return -1; }
}

// Relance l'analyse d'un segment V2 d'un nest : retire le Warp (segment = Warp seul)
// puis le repose via QE (l'ajout redéclenche l'analyse). "" si OK, message sinon.
function _reanalyzeNestSegment(stabSeq, segIdx) {
    if (!_activate(stabSeq)) return "activation de " + stabSeq.name + " impossible";
    app.enableQE();
    var qeSeq = qe.project.getActiveSequence();
    if (!qeSeq || qeSeq.name !== stabSeq.name) return "séquence " + stabSeq.name + " introuvable côté QE";
    var qeTrack = qeSeq.getVideoTrackAt(1);
    var rank = -1;
    for (var j = 0; j < qeTrack.numItems; j++) {
        var qi = qeTrack.getItemAt(j);
        if (!qi || qi.type === "Empty") continue;
        rank++;
        if (rank !== segIdx) continue;
        try { qi.removeEffects(0, 0, true, false, false); } catch (e) {}
        break;
    }
    return _applyWarpToClipAt(stabSeq, 1, segIdx);
}

