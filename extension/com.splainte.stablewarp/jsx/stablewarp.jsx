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

// Bornes de balayage des pistes : une seule piste si trackIdx est connu (lève
// l'ambiguïté nom+start entre un clip et son jumeau aligné sur une autre piste),
// sinon toutes (repli historique). trackIdx négatif/absent = toutes.
function _trackBounds(seq, trackIdx) {
    if (trackIdx !== undefined && trackIdx !== null && trackIdx >= 0 &&
        trackIdx < seq.videoTracks.numTracks) {
        return { from: trackIdx, to: trackIdx + 1 };
    }
    return { from: 0, to: seq.videoTracks.numTracks };
}

// Pose le Warp directement sur un clip de montage à vitesse 100 % (pas besoin de nest).
// Correspondance DOM↔QE : le k-ième clip DOM d'une piste = le k-ième item non vide QE.
// trackIdx (optionnel) restreint la recherche à la piste du clip sélectionné : sans lui,
// un clip identique aligné sur une piste inférieure était trouvé d'abord → effet posé
// sur « celui d'en dessous ».
function _applyWarpDirect(item, montageSeq, trackIdx) {
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
    var b = _trackBounds(montageSeq, trackIdx);
    for (var t = b.from; t < b.to; t++) {
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
// 1) component.remove() ciblé du DOM (absent de Premiere 26.5) ;
// 2) remove() ciblé du composant QE : n'enlève QUE le Warp (banc de test du 2026-10-08,
//    Echo/Lumetri intacts) ;
// 3) QE removeEffects, uniquement si le clip n'a AUCUN autre effet utilisateur
//    (enlève tous les effets — on ne risque pas un Lumetri) ; sonde sinon.
function _removeWarpDirect(item, montageSeq, trackIdx) {
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

    try {
        _activate(montageSeq);
        var qi0 = _qeItemOf(montageSeq, trackIdx, item);
        for (var q = qi0 ? qi0.numComponents - 1 : -1; q >= 0; q--) {
            var qc = qi0.getComponentAt(q);
            if (qc && qc.matchName === SW_WARP_MATCHNAME) qc.remove();
        }
        if (qi0 && !_hasWarp(item)) return "";
    } catch (eQ) {}

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
        var b = _trackBounds(montageSeq, trackIdx);
        for (var t = b.from; t < b.to; t++) {
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
function _migrateDirectToNest(item, montageSeq, trackIdx) {
    var rm = _removeWarpDirect(item, montageSeq, trackIdx);
    if (rm !== "") return rm;
    return _stabilizeOne(item, 0, trackIdx);
}

// ---------- stabilisation d'un clip ----------

function _stabilizeOne(item, marges, trackIdx) {
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
        var direct = _applyWarpDirect(item, $.global._swMontageSeq || app.project.activeSequence, trackIdx);
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

// Clips vidéo sélectionnés AVEC leur piste ([{item, trackIdx}]), en balayant les pistes
// et en retenant les clips sélectionnés (isSelected). Sans la piste, l'effet direct
// pouvait se poser sur un clip identique aligné sur une piste inférieure (« celui
// d'en dessous »). Repli sur getSelection (trackIdx -1) si le balayage n'aboutit pas
// au même compte — jamais pire que le comportement historique.
function _selectedVideoPicks(seq) {
    var sel = seq.getSelection();
    var selVideo = 0;
    for (var i = 0; i < sel.length; i++) {
        if (sel[i].mediaType === "Video") selVideo++;
    }
    if (selVideo === 0) return [];
    var picks = [];
    var scanOk = true;
    try {
        for (var t = 0; t < seq.videoTracks.numTracks; t++) {
            var tr = seq.videoTracks[t];
            for (var k = 0; k < tr.clips.numItems; k++) {
                var clip = tr.clips[k];
                if (clip.mediaType === "Video" && clip.isSelected()) {
                    picks.push({ item: clip, trackIdx: t });
                }
            }
        }
    } catch (eScan) { scanOk = false; }
    if (!scanOk || picks.length !== selVideo) {
        picks = [];
        for (var i2 = 0; i2 < sel.length; i2++) {
            if (sel[i2].mediaType === "Video") picks.push({ item: sel[i2], trackIdx: -1 });
        }
    }
    return picks;
}

function SW_stabilizeSelection(marges) {
    if (!app.project) return "ECHEC aucun projet ouvert";
    var seq = app.project.activeSequence;
    if (!seq) return "ECHEC aucune séquence active";
    marges = Number(marges) || 0;

    var picks = _selectedVideoPicks(seq);
    if (!picks.length) return "ECHEC sélectionne au moins un clip vidéo dans la timeline";

    $.global._swMontageSeq = seq;
    var results = [];
    for (var j = 0; j < picks.length; j++) {
        try {
            var res = _stabilizeOne(picks[j].item, marges, picks[j].trackIdx);
            results.push(res);
            if (res.indexOf("ECHEC") < 0) _markFresh(picks[j].item);
        } catch (e) { results.push(picks[j].item.name + " : ECHEC " + e); }
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

// ---------- surveillance re-stab ----------

// Tick du watcher re-stab : étend la couverture des nests _stab débordés et migre les
// stabs directes invalidées (vitesse changée). Le bandeau bleu a son propre cycle
// (SW_bannerNext / SW_bannerApply). Renvoie "" si rien à faire (pas de log).
function SW_watchTick() {
    try {
        if (!app.project || !app.project.activeSequence) return "";
        var seq = app.project.activeSequence;
        if (_isStabName(seq.name)) return ""; // ne pas surveiller l'intérieur d'un nest
        var marges = 0;
        $.global._swMontageSeq = seq;
        var msgs = [];

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
                    var rng = _sourceRange(clip);
                    var res = _ensureCoverage(stabSeq, rng.inSec - marges, rng.outSec + marges);
                    if (res !== "") {
                        msgs.push(clip.name + " : " + res);
                        _markFresh(clip); // nouveau segment : son analyse tourne déjà
                    }
                    continue;
                }

                // ----- clip à effet direct -----
                var spd = 1, rev = false;
                try { spd = clip.getSpeed(); } catch (eS) {}
                try { rev = !!clip.isSpeedReversed(); } catch (eRv) {}

                // stab directe devenue invalide (vitesse changée ou inversée après coup)
                if ((Math.abs(spd - 1) > 0.0001 || rev) && _hasWarp(clip)) {
                    if (!$.global._swMigrFail) $.global._swMigrFail = {};
                    var key = clip.name + "@" + clip.start.seconds.toFixed(2) + "@" + spd + (rev ? "R" : "");
                    if (!$.global._swMigrFail[key]) {
                        msgs.push(clip.name + " : vitesse modifiée après stab directe → migration vers nest…");
                        var mres = _migrateDirectToNest(clip, seq, t);
                        msgs.push(mres);
                        if (mres.indexOf("ECHEC") >= 0) {
                            $.global._swMigrFail[key] = true;
                            msgs.push("(pas de nouvelle tentative tant que la vitesse de ce clip ne rechange pas)");
                        } else {
                            _markFresh(clip);
                        }
                    }
                }
            }
        }

        var orphans = _cleanOrphanZones();
        if (orphans) msgs.push(orphans);
        return msgs.join("\n");
    } catch (e) {
        return "watcher : " + e;
    }
}

function SW_env() {
    return "Premiere " + app.version + " — " + (app.project ? app.project.name : "aucun projet");
}

// ---------- détecteur de bandeau bleu ----------
// Aucune propriété lisible du Warp ne dit « ce clip attend une analyse », et
// isDoneAnalyzingForVideoEffects() ne voit que les analyses EN COURS. Deux signaux
// fiables, vérifiés sur Premiere 26.5 (banc de test du 2026-10-08), sans aucune image :
//
// 1. PORTION ANALYSÉE (trim, Warp jamais analysé, nests) — Sequence.exportAsProject écrit
//    en quelques ms un instantané de la séquence ET de ses nests ; pour chaque Warp, ses
//    données d'analyse donnent la portion de rush analysée. Le panneau (js/warpsnap.js)
//    la compare à la portion utilisée par le clip et renvoie les Warp non couverts
//    (bandeau « Image non analysée… ») à SW_bannerApply. La barre de rendu reste JAUNE
//    dans ce cas : seul ce calcul le voit.
// 2. ANALYSE INVALIDÉE (réouverture d'un vieux projet, réglage modifié) — les données
//    sont là mais Premiere les refuse (bandeau « De nouvelles images doivent être
//    analysées ») : la barre de rendu passe au ROUGE sous le clip. Un Warp analysé
//    reste jaune, même en 4K 10 bits. Le rouge peut aussi venir d'un autre effet lourd
//    ou d'un clip superposé : on relance alors une seule fois, et si c'est encore rouge
//    une fois l'analyse finie, on en conclut que ce n'est pas le Warp.
//    Les nests ralentis sont toujours rouges dans le montage (vitesse) : leur propre
//    barre n'est lisible qu'une fois activés → contrôle une fois par session et par nest.
//
// Garde-fous : rien pendant la lecture/le scrub ni pendant une analyse (montage ou
// nest), SW_BATCH relances à la fois au plus (Premiere plante au-delà de ~5 analyses
// simultanées), SW_BANNER_MAX_TRIES relances par clip.

var SW_BANNER_MAX_TRIES = 2;
var SW_GRACE_MS = 10000;     // le temps qu'une analyse fraîchement lancée soit signalée
var SW_BATCH = 3;            // analyses relancées en même temps au plus
var SW_SNAP_MS = 60000;      // instantané de contrôle même sans modification détectée
var SW_RANGE_EPS = 0.02;     // ~ une demi-image

function _near(a, b) { return Math.abs(a - b) < SW_RANGE_EPS; }
function _now() { return new Date().getTime(); }
function _r2(x) { return Math.round(x * 100) / 100; }

// Identité d'un clip hors piste (nom + position + portion de rush).
function _freshKey(clip) {
    return clip.name + "|" + _r2(clip.start.seconds) + "|" + _r2(clip.inPoint.seconds) + "|" +
        _r2(clip.outPoint.seconds);
}

// Note un clip que StableWarp vient de (re)stabiliser : son analyse tourne déjà, le
// détecteur le laisse finir au lieu de le prendre pour un bandeau bloqué.
function _markFresh(clip) {
    try {
        if (!$.global._swFresh) $.global._swFresh = {};
        $.global._swFresh[_freshKey(clip)] = _now();
    } catch (e) {}
}

// Réglages du Warp (propriétés nommées, hors compteur interne).
function _snapWarpSettings(comp) {
    var out = [];
    if (!comp) return out;
    try {
        var props = comp.properties;
        for (var i = 0; i < props.numItems; i++) {
            var nm = "";
            try { nm = props[i].displayName; } catch (eN) {}
            if (!nm || nm === "AnalysisStatusCounter") continue;
            try { out.push({ i: i, n: nm, v: props[i].getValue() }); } catch (eV) {}
        }
    } catch (e) {}
    return out;
}

// Ne réécrit que les valeurs qui diffèrent du Warp neuf. Le nom doit correspondre :
// « Echelle auto (x %) », calculé par l'analyse, est ainsi ignoré.
function _restoreWarpSettings(comp, snap) {
    if (!comp) return;
    try {
        var props = comp.properties;
        for (var s = 0; s < snap.length; s++) {
            try {
                var p = props[snap[s].i];
                if (p.displayName !== snap[s].n) continue;
                if (p.getValue() !== snap[s].v) p.setValue(snap[s].v, true);
            } catch (eP) {}
        }
    } catch (e) {}
}

// Item QE d'un clip DOM de la séquence ACTIVE (k-ième clip DOM = k-ième item non vide).
function _qeItemOf(seq, trackIdx, item) {
    app.enableQE();
    var qs = qe.project.getActiveSequence();
    if (!qs || qs.guid !== seq.sequenceID) return null;
    var b = _trackBounds(seq, trackIdx);
    for (var t = b.from; t < b.to; t++) {
        var tr = seq.videoTracks[t];
        for (var k = 0; k < tr.clips.numItems; k++) {
            var c = tr.clips[k];
            if (c.name !== item.name || !_near(c.start.seconds, item.start.seconds)) continue;
            var qt = qs.getVideoTrackAt(t), rank = -1;
            for (var j = 0; j < qt.numItems; j++) {
                var qi = qt.getItemAt(j);
                if (!qi || qi.type === "Empty") continue;
                if (++rank === k) return qi;
            }
        }
    }
    return null;
}

// Relance l'analyse SUR PLACE : bascule « Analyse détaillée » par l'API QE puis la remet
// à sa valeur. Contrairement au modèle DOM (setValue), le setParamValue QE suit le même
// chemin que l'interface et relance l'analyse ; le Warp n'est ni retiré ni déplacé, les
// autres effets (Lumetri…), leur ordre et les réglages restent intacts (banc de test du
// 2026-10-08). La séquence du clip doit être active. "" si OK, message sinon.
function _relaunchInPlace(qi) {
    if (!qi) return "clip introuvable côté QE";
    var qc = null;
    for (var i = 0; i < qi.numComponents; i++) {
        var c = qi.getComponentAt(i);
        if (c && c.matchName === SW_WARP_MATCHNAME) { qc = c; break; }
    }
    if (!qc) return "Warp introuvable côté QE";
    try {
        var nm = qc.getParamList()[17]; // « Analyse détaillée » (nom traduit, indice stable)
        var v = String(qc.getParamValue(nm, ""));
        if (v !== "true" && v !== "false") return "réglage « Analyse détaillée » introuvable";
        qc.setParamValue(nm, v === "true" ? "false" : "true", "");
        qc.setParamValue(nm, v, "");
        return "";
    } catch (e) { return "relance sur place : " + e; }
}

// Relance l'analyse d'un Warp direct : sur place d'abord ; en secours (hard, ou échec),
// retrait puis repose du Warp en recopiant les réglages du monteur. "" si OK, message sinon.
function _relaunchDirect(item, montageSeq, trackIdx, hard) {
    if (!hard) {
        _activate(montageSeq);
        if (_relaunchInPlace(_qeItemOf(montageSeq, trackIdx, item)) === "") { _markFresh(item); return ""; }
    }
    var snap = _snapWarpSettings(_warpComp(item));
    var rm = _removeWarpDirect(item, montageSeq, trackIdx);
    if (rm !== "") return rm;
    var add = _applyWarpDirect(item, montageSeq, trackIdx);
    if (add !== "") return add;
    _restoreWarpSettings(_warpComp(item), snap);
    _markFresh(item);
    return "";
}

// Séquence QE correspondant à une séquence DOM. Parcours protégé : getSequenceAt lève
// une exception sur certaines séquences (constaté sur Premiere 26.5).
function _qeSeqOf(seq) {
    app.enableQE();
    try { var a = qe.project.getActiveSequence(); if (a && a.guid === seq.sequenceID) return a; } catch (e0) {}
    for (var i = 0; i < qe.project.numSequences; i++) {
        try { var q = qe.project.getSequenceAt(i); if (q && q.guid === seq.sequenceID) return q; } catch (e) {}
    }
    return null;
}

// Zones rouges de la barre de rendu d'une séquence QE : [[début, fin], …] en secondes.
// getRedBarTimes renvoie une liste plate de bornes, deux par zone.
function _redRanges(qeSeq) {
    var out = [], v = qeSeq.getRedBarTimes();
    for (var i = 0; i + 1 < v.length; i += 2) {
        var s = Number(v[i].secs), e = Number(v[i + 1].secs);
        if (e > s) out.push([s, e]);
    }
    return out;
}

// Part de [s, e] couverte par les zones.
function _redShare(ranges, s, e) {
    if (e <= s) return 0;
    var cov = 0;
    for (var i = 0; i < ranges.length; i++) {
        var a = Math.max(s, ranges[i][0]), b = Math.min(e, ranges[i][1]);
        if (b > a) cov += b - a;
    }
    return cov / (e - s);
}

// Clips stabilisés de la séquence : Warp direct à 100 % (nest = "") ou nest _stab.
function _bannerClips(seq) {
    var out = [];
    for (var t = 0; t < seq.videoTracks.numTracks; t++) {
        var tr = seq.videoTracks[t];
        for (var k = 0; k < tr.clips.numItems; k++) {
            var clip = tr.clips[k];
            var pi = null;
            try { pi = clip.projectItem; } catch (eP) {}
            if (!pi) continue;
            var nest = "";
            if (_isStabName(pi.name)) {
                nest = pi.name;
            } else {
                if (!_warpComp(clip)) continue;
                var spd = 1, rev = false;
                try { spd = clip.getSpeed(); } catch (eS) {}
                try { rev = !!clip.isSpeedReversed(); } catch (eR) {}
                if (Math.abs(spd - 1) > 0.0001 || rev) continue; // migration vers nest en cours
            }
            out.push({ clip: clip, t: t, nest: nest, key: t + "|" + _freshKey(clip) });
        }
    }
    return out;
}

function _findClip(seq, t, name, start) {
    try {
        var tr = seq.videoTracks[t];
        for (var k = 0; k < tr.clips.numItems; k++) {
            if ((name === null || tr.clips[k].name === name) && _near(tr.clips[k].start.seconds, start)) return tr.clips[k];
        }
    } catch (e) {}
    return null;
}

// État du détecteur pour une séquence (conservé quand on passe d'une séquence à l'autre).
function _bnState(seq) {
    if (!$.global._swBnSeqs) $.global._swBnSeqs = {};
    var sid = seq.sequenceID;
    if (!$.global._swBnSeqs[sid]) $.global._swBnSeqs[sid] = { recs: {}, cov: {}, nests: {}, pos: null, fp: null, snapAt: 0 };
    return $.global._swBnSeqs[sid];
}

// Un autre clip vidéo occupe-t-il [s, e] sur une autre piste ?
function _stacked(seq, t, s, e) {
    for (var t2 = 0; t2 < seq.videoTracks.numTracks; t2++) {
        if (t2 === t) continue;
        var tr = seq.videoTracks[t2];
        for (var k = 0; k < tr.clips.numItems; k++) {
            var a = Math.max(s, tr.clips[k].start.seconds), b = Math.min(e, tr.clips[k].end.seconds);
            if (b - a > SW_RANGE_EPS) return true;
        }
    }
    return false;
}

// Le rouge sous ce clip direct peut-il venir d'autre chose que son Warp ?
function _bnAmbiguous(seq, c) {
    if (_userEffects(c.clip).length > 0) return true; // matchName inconnu = prudence
    return _stacked(seq, c.t, c.clip.start.seconds, c.clip.end.seconds);
}

// Empreinte des clips stabilisés + compteurs d'analyse : change à chaque trim, ajout,
// déplacement ou fin d'analyse → déclenche un nouvel instantané.
function _bnFingerprint(seq, list) {
    var f = [];
    for (var i = 0; i < list.length; i++) {
        var c = list[i].clip, w = _warpComp(c), ctr = "";
        try {
            if (w) { var ps = w.properties; ctr = ps[ps.numItems - 1].getValue(); }
        } catch (e) {}
        f.push(list[i].key + "|" + _r2(c.end.seconds) + "|" + ctr);
    }
    // segments des nests (couverture étendue par StableWarp, analyses terminées)
    var seen = {};
    for (var j = 0; j < list.length; j++) {
        var n = list[j].nest;
        if (!n || seen[n]) continue;
        seen[n] = 1;
        var ns = _findSequenceByName(n);
        try {
            var v2 = ns.videoTracks[1];
            for (var k = 0; k < v2.clips.numItems; k++) {
                var sw = _warpComp(v2.clips[k]), sc = "";
                try { var sp = sw.properties; sc = sp[sp.numItems - 1].getValue(); } catch (e2) {}
                f.push(n + "#" + _r2(v2.clips[k].start.seconds) + "-" + _r2(v2.clips[k].end.seconds) + "|" + sc);
            }
        } catch (e3) {}
    }
    return f.join(";");
}

// Une analyse tourne-t-elle dans la séquence ou dans un de ses nests ?
function _bnBusy(seq, list) {
    try { if (!seq.isDoneAnalyzingForVideoEffects()) return true; } catch (e) {}
    var seen = {};
    for (var i = 0; i < list.length; i++) {
        var n = list[i].nest;
        if (!n || seen[n]) continue;
        seen[n] = 1;
        try { var ns = _findSequenceByName(n); if (ns && !ns.isDoneAnalyzingForVideoEffects()) return true; } catch (e2) {}
    }
    return false;
}

// API panneau, à chaque tick. Renvoie des lignes de log, et "SNAP|<chemin>" quand un
// instantané vient d'être écrit (le panneau l'analyse puis appelle SW_bannerApply).
function SW_bannerNext(snapPath) {
    try {
        if (!app.project || !app.project.activeSequence) return "";
        var seq = app.project.activeSequence;
        if (_isStabName(seq.name)) return "";
        var g = _bnState(seq);
        // tête de lecture qui bouge (lecture, scrub) : on ne gêne pas le monteur
        var pos = null;
        try { pos = seq.getPlayerPosition().seconds; } catch (eP) {}
        var moving = (g.pos !== null && pos !== g.pos);
        g.pos = pos;
        if (moving) return "";
        var now = _now();
        // lot précédent pas encore signalé par Premiere : ne rien empiler
        if (g.lastLaunch && now - g.lastLaunch < SW_GRACE_MS) return "";
        var list = _bannerClips(seq);
        if (!list.length) return "";
        if (_bnBusy(seq, list)) return ""; // analyse en cours : on attend qu'elle finisse

        // 1. portion analysée : instantané si quelque chose a changé (ou de temps en temps)
        var fp = _bnFingerprint(seq, list);
        if (fp !== g.fp || now - g.snapAt > SW_SNAP_MS) {
            var f = new File(snapPath);
            if (f.exists) f.remove();
            if (seq.exportAsProject(snapPath)) {
                g.pendingFp = fp;
                return "SNAP|" + snapPath;
            }
        }

        // 2. analyse invalidée : barre rouge sous un clip stabilisé
        return _bnRedPass(seq, g, list).join("\n");
    } catch (e) { return ""; }
}

function _bnRedPass(seq, g, list) {
    var msgs = [], launched = 0, now = _now(), fresh = $.global._swFresh || {};
    var qs = _qeSeqOf(seq);
    if (!qs) return msgs;
    var red = _redRanges(qs), recs = {}, nestsToCheck = {};
    for (var i = 0; i < list.length; i++) {
        var c = list[i];
        var r = g.recs[c.key] || { state: "new", tries: 0, at: 0 };
        recs[c.key] = r;
        if (r.state === "other" || r.state === "gaveup") continue;
        var fk = fresh[_freshKey(c.clip)];
        if ((fk && now - fk < SW_GRACE_MS) || now - r.at < SW_GRACE_MS) continue;
        var s = c.clip.start.seconds, e = c.clip.end.seconds;
        if (_redShare(red, s, e) < 0.5) { r.state = "ok"; continue; }
        if (c.nest) { nestsToCheck[c.nest] = 1; continue; }
        // rouge alors que StableWarp a lui-même analysé ce clip cette session (analyse
        // finie, puisque rien ne tourne) : l'analyse est valide, le rouge vient d'autre
        // chose (autre effet lourd, clip superposé) → on n'y touche pas
        if (fk || r.state === "relaunched") { r.state = "other"; continue; }
        if (launched >= SW_BATCH) continue;
        if (r.tries >= SW_BANNER_MAX_TRIES) { r.state = "gaveup"; continue; }
        var rr = _relaunchDirect(c.clip, seq, c.t, r.tries >= 1);
        r.tries++; r.at = now; r.state = "relaunched"; launched++;
        g.lastLaunch = now;
        msgs.push(c.clip.name + " : analyse à refaire (barre rouge" +
            (_bnAmbiguous(seq, c) ? ", à confirmer" : "") + ") → " + (rr === "" ? "analyse relancée" : "ECHEC relance : " + rr));
    }
    g.recs = recs; // les clips disparus sont oubliés

    // nests rouges dans le montage : contrôle de leur propre barre, une fois par session
    if (!launched) {
        for (var n in nestsToCheck) {
            if (!nestsToCheck.hasOwnProperty(n) || g.nests[n]) continue;
            g.nests[n] = 1;
            var m = _bnCheckNest(seq, n);
            if (m) { msgs.push(m); g.lastLaunch = _now(); }
            break; // un nest par tick : chaque contrôle ouvre brièvement le nest
        }
    }
    return msgs;
}

// Ouvre brièvement le nest, lit sa barre de rendu (lisible seulement quand il est actif)
// et relance les segments Warp sous du rouge. Renvoie un message, ou "".
function _bnCheckNest(montage, name) {
    var ns = _findSequenceByName(name);
    if (!ns || ns.videoTracks.numTracks < 2) return "";
    // ouvrir (pas seulement activer) : Premiere ne calcule la barre de rendu que des
    // séquences affichées dans la timeline (banc de test du 2026-10-08)
    try { app.project.openSequence(ns.sequenceID); } catch (eO) { if (!_activate(ns)) return ""; }
    var msg = "";
    try {
        $.sleep(800); // le temps que la barre de rendu soit calculée
        var q = _qeSeqOf(ns), red = q ? _redRanges(q) : [], v2 = ns.videoTracks[1], done = [];
        for (var k = 0; k < v2.clips.numItems; k++) {
            var seg = v2.clips[k];
            if (!_warpComp(seg) || _redShare(red, seg.start.seconds, seg.end.seconds) < 0.5) continue;
            var rr = _reanalyzeNestSegment(ns, k);
            done.push(rr === "" ? "#" + k : "#" + k + " ECHEC " + rr);
        }
        if (done.length) msg = name + " : analyse à refaire dans le nest → relancée (" + done.join(", ") + ")";
    } catch (e) {}
    _closeSequence(ns);
    _activate(montage);
    return msg;
}

// API panneau : Warp non couverts trouvés dans l'instantané, une ligne par Warp
// « séquence \t piste \t début (s) ». Relance au plus SW_BATCH analyses.
function SW_bannerApply(lines) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return "";
        var g = _bnState(seq), now = _now();
        g.fp = g.pendingFp; g.snapAt = now;
        var rows = lines ? String(lines).split("\n") : [], msgs = [], launched = 0, nestsTouched = {};
        // un Warp redevenu couvert repart de zéro (compteur de relances oublié)
        var still = {};
        for (var r0 = 0; r0 < rows.length; r0++) {
            var q0 = rows[r0].split("\t");
            if (q0.length >= 3) still[q0[0] + "|" + Number(q0[1]) + "|" + _r2(Number(q0[2]))] = 1;
        }
        for (var ck in g.cov) if (g.cov.hasOwnProperty(ck) && !still[ck]) delete g.cov[ck];
        $.global._swMontageSeq = seq;
        for (var i = 0; i < rows.length && launched < SW_BATCH; i++) {
            var p = rows[i].split("\t");
            if (p.length < 3) continue;
            var sname = p[0], t = Number(p[1]), start = Number(p[2]);
            var key = sname + "|" + t + "|" + _r2(start);
            var tries = g.cov[key] || 0;
            if (tries >= SW_BANNER_MAX_TRIES) {
                if (tries === SW_BANNER_MAX_TRIES) {
                    g.cov[key] = tries + 1;
                    msgs.push(sname + " (V" + (t + 1) + ", " + _r2(start) + " s) : analyse incomplète malgré " +
                        SW_BANNER_MAX_TRIES + " relances — laissé tel quel (clique Analyser à la main)");
                }
                continue;
            }
            var rr, label;
            if (sname === seq.name) {
                var clip = _findClip(seq, t, null, start);
                if (!clip || !_warpComp(clip)) continue;
                var spd = 1, rev = false;
                try { spd = clip.getSpeed(); } catch (eS) {}
                try { rev = !!clip.isSpeedReversed(); } catch (eR) {}
                if (Math.abs(spd - 1) > 0.0001 || rev) continue; // la migration vers nest s'en charge
                label = clip.name;
                rr = _relaunchDirect(clip, seq, t, tries >= 1);
            } else if (_isStabName(sname)) {
                var ns = _findSequenceByName(sname);
                if (!ns) continue;
                var idx = -1;
                try {
                    var v = ns.videoTracks[t];
                    for (var k = 0; k < v.clips.numItems; k++) if (_near(v.clips[k].start.seconds, start)) { idx = k; break; }
                } catch (eI) {}
                if (idx < 0) continue;
                label = sname + " #" + idx;
                rr = _reanalyzeNestSegment(ns, idx, tries >= 1);
                nestsTouched[sname] = ns;
            } else continue;
            g.cov[key] = tries + 1;
            launched++;
            msgs.push(label + " : images non analysées → " + (rr === "" ? "analyse relancée" : "ECHEC relance : " + rr));
        }
        for (var n in nestsTouched) if (nestsTouched.hasOwnProperty(n)) _closeSequence(nestsTouched[n]);
        if (launched) { g.lastLaunch = now; _activate(seq); }
        return msgs.join("\n");
    } catch (e) { return "détecteur bandeau : " + e; }
}

// Relance l'analyse des segments du nest qui couvrent la portion de rush de ce clip.
function _reanalyzeNestFor(item, nestName) {
    var stabSeq = _findSequenceByName(nestName);
    if (!stabSeq) return "ECHEC séquence " + nestName + " introuvable";
    if (stabSeq.videoTracks.numTracks < 2) return "ECHEC structure inattendue dans " + nestName;
    var rng = _sourceRange(item);
    var v2 = stabSeq.videoTracks[1];
    var idx = [];
    for (var k = 0; k < v2.clips.numItems; k++) {
        if (rng.inSec < v2.clips[k].end.seconds && rng.outSec > v2.clips[k].start.seconds) idx.push(k);
    }
    if (!idx.length) return "ECHEC aucun segment stabilisé ne couvre ce clip";
    var orig = app.project.activeSequence;
    var errs = [];
    for (var i = 0; i < idx.length; i++) {
        var r = _reanalyzeNestSegment(stabSeq, idx[i]);
        if (r !== "") errs.push("#" + idx[i] + " " + r);
    }
    _closeSequence(stabSeq);
    if (orig) _activate(orig);
    return errs.length ? "ECHEC " + errs.join(" ; ") :
        "analyse relancée (" + idx.length + " segment" + (idx.length > 1 ? "s" : "") + " du nest)";
}

// API panneau : relance l'analyse des clips sélectionnés (plan B manuel).
function SW_reanalyzeSelection() {
    if (!app.project) return "ECHEC aucun projet ouvert";
    var seq = app.project.activeSequence;
    if (!seq) return "ECHEC aucune séquence active";
    var picks = _selectedVideoPicks(seq);
    if (!picks.length) return "ECHEC sélectionne au moins un clip vidéo dans la timeline";
    $.global._swMontageSeq = seq;
    var results = [];
    for (var i = 0; i < picks.length; i++) {
        var item = picks[i].item, lbl = item.name + " : ";
        try {
            var pi = item.projectItem;
            if (pi && _isStabName(pi.name)) {
                var rn = _reanalyzeNestFor(item, pi.name);
                results.push(lbl + rn);
                if (rn.indexOf("ECHEC") !== 0) _markFresh(item);
                continue;
            }
            if (!_warpComp(item)) { results.push(lbl + "ignoré (pas d'effet Stabilisation)"); continue; }
            var rr = _relaunchDirect(item, seq, picks[i].trackIdx);
            results.push(lbl + (rr === "" ? "analyse relancée" : "ECHEC " + rr));
            if (rr === "") _markFresh(item);
        } catch (e) { results.push(lbl + "ECHEC " + e); }
    }
    _activate(seq);
    return results.join("\n");
}

// ---------- helpers de détection de l'état d'analyse du Warp ----------

// Le Warp du clip (ou null).
function _warpComp(item) {
    try {
        for (var c = 0; c < item.components.numItems; c++) {
            if (item.components[c].matchName === SW_WARP_MATCHNAME) return item.components[c];
        }
    } catch (e) {}
    return null;
}

// Relance l'analyse d'un segment V2 d'un nest : sur place d'abord (_relaunchInPlace) ;
// en secours (hard, ou échec), retire le Warp (segment = Warp seul) puis le repose via
// QE. Le retrait est vérifié avant la repose : jamais deux Warp empilés (double
// stabilisation). "" si OK, message sinon.
function _reanalyzeNestSegment(stabSeq, segIdx, hard) {
    if (!_activate(stabSeq)) return "activation de " + stabSeq.name + " impossible";
    function seg() { try { return stabSeq.videoTracks[1].clips[segIdx]; } catch (e) { return null; } }
    if (!seg()) return "segment #" + segIdx + " introuvable";
    if (!hard && _relaunchInPlace(_qeItemOf(stabSeq, 1, seg())) === "") return "";
    // 1) retrait ciblé par le DOM
    try {
        var s0 = seg();
        for (var c = s0.components.numItems - 1; c >= 0; c--) {
            if (s0.components[c].matchName === SW_WARP_MATCHNAME) { try { s0.components[c].remove(); } catch (eR) {} }
        }
    } catch (eC) {}
    // 2) repli QE (le segment ne porte que le Warp)
    if (_hasWarp(seg())) {
        app.enableQE();
        var qeSeq = qe.project.getActiveSequence();
        if (!qeSeq || qeSeq.name !== stabSeq.name) return "séquence " + stabSeq.name + " introuvable côté QE";
        var qeTrack = qeSeq.getVideoTrackAt(1), rank = -1;
        for (var j = 0; j < qeTrack.numItems; j++) {
            var qi = qeTrack.getItemAt(j);
            if (!qi || qi.type === "Empty") continue;
            if (++rank !== segIdx) continue;
            try { qi.removeEffects(0, 0, true, false, false); } catch (e1) {}
            if (_hasWarp(seg())) { try { qi.removeEffects(); } catch (e2) {} }
            break;
        }
    }
    if (_hasWarp(seg())) return "impossible de retirer l'ancien Warp du segment #" + segIdx;
    return _applyWarpToClipAt(stabSeq, 1, segIdx);
}
