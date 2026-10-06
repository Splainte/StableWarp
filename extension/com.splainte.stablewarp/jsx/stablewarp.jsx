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
// 1) component.remove() ciblé (sans risque pour les autres effets) ;
// 2) QE removeEffects, uniquement si le clip n'a AUCUN autre effet utilisateur
//    (sémantique incertaine — on ne risque pas un Lumetri) ; sonde sinon.
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
// (SW_bannerNext / SW_bannerResult). Renvoie "" si rien à faire (pas de log).
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

// ---------- détecteur de bandeau bleu (par l'image) ----------
// Premiere n'expose aucune propriété lisible qui dise « ce Warp attend une analyse »
// (diags du 2026-10-06 : mêmes valeurs avec et sans bandeau ; seul AnalysisStatusCounter
// bouge, +500 par analyse terminée). En revanche le bandeau est dessiné dans l'image
// rendue : on exporte une image du milieu de chaque clip stabilisé (exportFramePNG), le
// panneau y cherche la bande bleue pleine largeur, et on relance l'analyse là où elle
// persiste. Marche dans tous les cas : réouverture d'un vieux projet, trim, etc.
//
// Cycle par clip (clé = piste + nom + position + portion de rush : un clip modifié
// change de clé et est donc revérifié) :
//   todo → capture : pas de bande → ok ; bande → suspect
//   suspect → nouvelle capture après SW_RECHECK_MS : bande et compteur inchangé →
//     relance (launched) ; compteur qui avance = analyse en cours → on patiente
//   launched → fin d'analyse (compteur +500) ou SW_LAUNCH_TIMEOUT_MS → todo (contrôle)
// Les clips que StableWarp vient lui-même de stabiliser démarrent en launched.

var SW_BANNER_MAX_TRIES = 2;
var SW_RECHECK_MS = 15000;
var SW_LAUNCH_TIMEOUT_MS = 15 * 60000;
var SW_COUNTER_STEP = 500;   // incrément d'AnalysisStatusCounter par analyse terminée
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
        var fk = _freshKey(clip);
        if (!$.global._swFresh) $.global._swFresh = {};
        $.global._swFresh[fk] = _now();
        var all = $.global._swBnSeqs || {};
        for (var sid in all) {
            if (!all.hasOwnProperty(sid)) continue;
            for (var k in all[sid].recs) {
                if (all[sid].recs.hasOwnProperty(k) && k.substr(k.indexOf("|") + 1) === fk) delete all[sid].recs[k];
            }
        }
    } catch (e) {}
}

// Valeur d'AnalysisStatusCounter (null si absente).
function _warpCounter(comp) {
    try {
        var props = comp.properties;
        for (var i = props.numItems - 1; i >= 0; i--) {
            if (props[i].displayName === "AnalysisStatusCounter") return Number(props[i].getValue()) || 0;
        }
    } catch (e) {}
    return null;
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

// Relance l'analyse d'un Warp direct : retrait puis repose (l'ajout redéclenche
// l'analyse), en recopiant les réglages du monteur. "" si OK, message sinon.
function _relaunchDirect(item, montageSeq, trackIdx) {
    var snap = _snapWarpSettings(_warpComp(item));
    var rm = _removeWarpDirect(item, montageSeq, trackIdx);
    if (rm !== "") return rm;
    var add = _applyWarpDirect(item, montageSeq, trackIdx);
    if (add !== "") return add;
    _restoreWarpSettings(_warpComp(item), snap);
    return "";
}

// Compteur d'analyse d'un nest = somme des compteurs de ses segments (avance de +500 à
// chaque segment analysé). null si illisible.
function _nestCounter(stabSeq) {
    try {
        if (!stabSeq || stabSeq.videoTracks.numTracks < 2) return null;
        var v2 = stabSeq.videoTracks[1], sum = 0, any = false;
        for (var k = 0; k < v2.clips.numItems; k++) {
            var w = _warpComp(v2.clips[k]);
            var c = w ? _warpCounter(w) : null;
            if (c !== null) { sum += c; any = true; }
        }
        return any ? sum : null;
    } catch (e) { return null; }
}

// Clips stabilisés de la séquence (Warp direct à 100 % ou nest _stab), avec leur clé
// et leur compteur d'analyse.
function _bannerClips(seq) {
    var out = [];
    for (var t = 0; t < seq.videoTracks.numTracks; t++) {
        var tr = seq.videoTracks[t];
        for (var k = 0; k < tr.clips.numItems; k++) {
            var clip = tr.clips[k];
            var pi = null;
            try { pi = clip.projectItem; } catch (eP) {}
            if (!pi) continue;
            var nest = "", ctr = null;
            if (_isStabName(pi.name)) {
                var stabSeq = _findSequenceByName(pi.name);
                if (!stabSeq) continue;
                nest = pi.name;
                ctr = _nestCounter(stabSeq);
            } else {
                var wc = _warpComp(clip);
                if (!wc) continue;
                var spd = 1, rev = false;
                try { spd = clip.getSpeed(); } catch (eS) {}
                try { rev = !!clip.isSpeedReversed(); } catch (eR) {}
                if (Math.abs(spd - 1) > 0.0001 || rev) continue; // migration vers nest en cours
                ctr = _warpCounter(wc);
            }
            out.push({ clip: clip, t: t, nest: nest, ctr: ctr, key: t + "|" + _freshKey(clip) });
        }
    }
    return out;
}

function _findClip(seq, t, name, start) {
    try {
        var tr = seq.videoTracks[t];
        for (var k = 0; k < tr.clips.numItems; k++) {
            if (tr.clips[k].name === name && _near(tr.clips[k].start.seconds, start)) return tr.clips[k];
        }
    } catch (e) {}
    return null;
}

// État du détecteur pour une séquence (conservé quand on passe d'une séquence à l'autre).
function _bnState(seq) {
    if (!$.global._swBnSeqs) $.global._swBnSeqs = {};
    var sid = seq.sequenceID;
    if (!$.global._swBnSeqs[sid]) $.global._swBnSeqs[sid] = { recs: {}, job: null, pos: null };
    return $.global._swBnSeqs[sid];
}

// API panneau : prochaine capture à faire. Renvoie "CAPTURE|<chemin sans extension>"
// ou "" (rien à faire, ou tête de lecture en mouvement : on ne gêne pas le monteur).
function SW_bannerNext(dir, sep) {
    try {
        if (!app.project || !app.project.activeSequence) return "";
        var seq = app.project.activeSequence;
        if (_isStabName(seq.name)) return "";
        var g = _bnState(seq);
        g.job = null;
        var pos = null;
        try { pos = seq.getPlayerPosition().seconds; } catch (eP) {}
        var moving = (g.pos !== null && pos !== g.pos);
        g.pos = pos;
        if (moving) return "";

        var now = _now(), fresh = $.global._swFresh || {};
        var list = _bannerClips(seq), recs = {}, pickTodo = null, pickSuspect = null;
        for (var i = 0; i < list.length; i++) {
            var c = list[i], r = g.recs[c.key];
            if (!r) {
                var fk = fresh[_freshKey(c.clip)];
                r = (fk && now - fk < SW_LAUNCH_TIMEOUT_MS) ?
                    { state: "launched", at: fk, ctr: c.ctr, tries: 0, fails: 0 } :
                    { state: "todo", tries: 0, fails: 0 };
            }
            r.t = c.t; r.nest = c.nest; r.name = c.clip.name; r.cur = c.ctr;
            r.start = c.clip.start.seconds; r.end = c.clip.end.seconds;
            if (r.state === "launched" &&
                ((r.ctr !== null && c.ctr !== null && c.ctr - r.ctr >= SW_COUNTER_STEP) ||
                 now - r.at > SW_LAUNCH_TIMEOUT_MS)) r.state = "todo"; // fini : on contrôle
            recs[c.key] = r;
            if (!pickSuspect && r.state === "suspect" && now - r.at >= SW_RECHECK_MS) pickSuspect = c.key;
            if (!pickTodo && r.state === "todo") pickTodo = c.key;
        }
        g.recs = recs; // les clips disparus sont oubliés
        var key = pickSuspect || pickTodo;
        if (!key) return "";

        var rec = recs[key], st = seq.getSettings();
        var tc = _t((rec.start + rec.end) / 2).getFormatted(st.videoFrameRate, st.videoDisplayFormat);
        app.enableQE();
        var qeSeq = qe.project.getActiveSequence();
        if (!qeSeq) return "";
        var base = dir + sep + "sw-bandeau-" + now;
        qeSeq.exportFramePNG(tc, base);
        g.job = key;
        return "CAPTURE|" + base;
    } catch (e) { return ""; }
}

// API panneau : verdict de l'image de la dernière capture (1 = bande bleue, 0 = rien,
// -1 = image illisible). Relance l'analyse si le bandeau persiste. Renvoie un message
// à logguer, ou "".
function SW_bannerResult(hasBand) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return "";
        var g = _bnState(seq), key = g.job;
        g.job = null;
        var r = key ? g.recs[key] : null;
        if (!r) return "";
        hasBand = Number(hasBand);
        if (hasBand < 0) {
            if (++r.fails >= 3) { r.state = "ok"; return r.name + " : capture d'image impossible, clip non surveillé"; }
            return "";
        }
        if (!hasBand) { r.state = "ok"; return ""; }
        if (r.state === "todo") { r.state = "suspect"; r.at = _now(); r.ctr = r.cur; return ""; }
        if (r.state !== "suspect") return "";
        if (r.cur !== r.ctr) { r.at = _now(); r.ctr = r.cur; return ""; } // analyse en cours
        if (r.tries >= SW_BANNER_MAX_TRIES) {
            r.state = "gaveup";
            return r.name + " : bandeau bleu toujours là après " + SW_BANNER_MAX_TRIES +
                " relances — laissé tel quel (clique Analyser à la main)";
        }
        var clip = _findClip(seq, r.t, r.name, r.start);
        if (!clip) return "";
        $.global._swMontageSeq = seq;
        var rr = r.nest ? _reanalyzeNestFor(clip, r.nest) : _relaunchDirect(clip, seq, r.t);
        var ok = r.nest ? rr.indexOf("ECHEC") !== 0 : rr === "";
        r.tries++;
        r.at = _now();
        if (ok) {
            r.state = "launched";
            r.ctr = r.nest ? _nestCounter(_findSequenceByName(r.nest)) : _warpCounter(_warpComp(clip));
        }
        _activate(seq);
        return r.name + " : bandeau bleu détecté → " + (ok ? "analyse relancée" : "ECHEC relance : " + rr);
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

// ---------- diagnostic bandeau bleu (LECTURE SEULE, ne modifie rien) ----------

// Représentation lisible d'une valeur de propriété (booléens/nombres/chaînes/objets).
function _diagVal(v) {
    try {
        if (v === true) return "true";
        if (v === false) return "false";
        if (v === null) return "null";
        if (v === undefined) return "undefined";
        if (typeof v === "number") return String(v);
        if (typeof v === "string") return '"' + v + '"';
        return String(v);
    } catch (e) { return "?"; }
}

// Vidange complète du Warp d'un clip : matchName, toutes ses propriétés (nom + valeur)
// et le verdict de l'heuristique actuelle. Sert à identifier quel signal distingue
// vraiment le bandeau bleu (« Analyser ») d'un clip déjà analysé.
function _diagWarpComp(item, trackIdx) {
    var out = [];
    out.push("=== " + item.name + " (V" + (trackIdx + 1) +
             ", début " + item.start.seconds.toFixed(2) + "s) ===");
    var wc = null, wcIdx = -1;
    try {
        for (var c = 0; c < item.components.numItems; c++) {
            if (item.components[c].matchName === SW_WARP_MATCHNAME) { wc = item.components[c]; wcIdx = c; break; }
        }
    } catch (e0) {}
    if (!wc) { out.push("  (pas d'effet Stabilisation sur ce clip)"); return out.join("\n"); }
    out.push("  composant[" + wcIdx + "] matchName=" + wc.matchName);
    var props = null;
    try { props = wc.properties; } catch (eP) { out.push("  properties illisibles : " + eP); return out.join("\n"); }
    var n = 0;
    try { n = props.numItems; } catch (eN) {}
    out.push("  " + n + " propriété(s) :");
    var max = n < 60 ? n : 60;
    for (var i = 0; i < max; i++) {
        var nm = "?", val = "?";
        try { nm = props[i].displayName; } catch (eNm) {}
        try { val = _diagVal(props[i].getValue()); } catch (eV) { val = "getValue ECHEC (" + eV + ")"; }
        out.push("    [" + i + "] " + nm + " = " + val);
    }
    return out.join("\n");
}

// TEST : exporte une image (milieu du clip) de chaque clip vidéo sélectionné, pour
// vérifier si le bandeau bleu du Warp est dessiné dans l'image rendue. Lecture seule.
// Renvoie une ligne "FILE|<chemin sans extension>|<libellé>" par image demandée, plus
// la liste des méthodes QE du premier clip (pistes d'exploration).
function SW_captureSelected(dir, sep) {
    if (!app.project) return "ECHEC aucun projet ouvert";
    var seq = app.project.activeSequence;
    if (!seq) return "ECHEC aucune séquence active";
    var picks = _selectedVideoPicks(seq);
    if (!picks.length) return "ECHEC sélectionne au moins un clip vidéo";
    app.enableQE();
    var qeSeq = qe.project.getActiveSequence();
    if (!qeSeq) return "ECHEC séquence introuvable côté QE";
    var st = seq.getSettings();
    var out = [];
    for (var i = 0; i < picks.length && i < 4; i++) {
        var it = picks[i].item;
        var tc = _t((it.start.seconds + it.end.seconds) / 2).getFormatted(st.videoFrameRate, st.videoDisplayFormat);
        var base = dir + sep + "stablewarp-capture-" + (i + 1) + "-" + it.name.replace(/[^\w.-]/g, "_");
        try {
            qeSeq.exportFramePNG(tc, base);
            out.push("FILE|" + base + "|" + it.name + " à " + tc + (_warpComp(it) ? " (Warp)" : " (sans Warp)"));
        } catch (e) { out.push("ECHEC export " + it.name + " : " + e); }
    }
    try {
        var t0 = picks[0].trackIdx >= 0 ? picks[0].trackIdx : 0;
        var tr = seq.videoTracks[t0], k0 = -1;
        for (var k = 0; k < tr.clips.numItems; k++) {
            if (tr.clips[k].name === picks[0].item.name &&
                _near(tr.clips[k].start.seconds, picks[0].item.start.seconds)) { k0 = k; break; }
        }
        var qeTrack = qeSeq.getVideoTrackAt(t0), rank = -1;
        for (var j = 0; j < qeTrack.numItems && k0 >= 0; j++) {
            var qi = qeTrack.getItemAt(j);
            if (!qi || qi.type === "Empty") continue;
            if (++rank !== k0) continue;
            var ms = qi.reflect.methods, names = [];
            for (var m = 0; m < ms.length; m++) names.push(String(ms[m].name));
            out.push("Méthodes QE du clip : " + names.join(", "));
            break;
        }
    } catch (eQ) { out.push("(méthodes QE illisibles : " + eQ + ")"); }
    return out.join("\n");
}

// TEST : que renvoie Sequence.isDoneAnalyzingForVideoEffects() (API officielle, à
// l'échelle de la séquence) selon qu'il y a un bandeau en attente, une analyse en
// cours ou rien ? Pour la séquence active et chaque nest _stab, plus les méthodes
// DOM/QE de la séquence (pistes d'exploration). Lecture seule.
function SW_testAnalysisApi() {
    if (!app.project) return "ECHEC aucun projet ouvert";
    var seq = app.project.activeSequence;
    if (!seq) return "ECHEC aucune séquence active";
    function st(s) {
        try { return s.isDoneAnalyzingForVideoEffects() ? "terminé (true)" : "PAS terminé (false)"; }
        catch (e) { return "erreur : " + e; }
    }
    var out = ["isDoneAnalyzingForVideoEffects :", "  séquence active « " + seq.name + " » → " + st(seq)];
    for (var i = 0; i < app.project.sequences.numSequences; i++) {
        var s = app.project.sequences[i];
        if (_isStabName(s.name)) out.push("  nest « " + s.name + " » → " + st(s));
    }
    function names(o) {
        var r = [];
        try { var ms = o.reflect.methods; for (var m = 0; m < ms.length; m++) r.push(String(ms[m].name)); }
        catch (e) { return "illisible : " + e; }
        return r.join(", ");
    }
    // valeur brute lisible, quel que soit le type renvoyé par QE
    function dump(v, depth) {
        if (v === null || v === undefined) return String(v);
        if (typeof v !== "object") return String(v);
        if (typeof v.length === "number") {
            var a = [];
            for (var k = 0; k < v.length && k < 40; k++) a.push(dump(v[k], depth + 1));
            return "[" + a.join(", ") + (v.length > 40 ? ", … (" + v.length + ")" : "") + "]";
        }
        if (depth > 1) return String(v);
        var p = [];
        try {
            var ps = v.reflect.properties;
            for (var q = 0; q < ps.length; q++) {
                var n = String(ps[q].name);
                if (n === "__proto__" || n === "reflect") continue;
                try { p.push(n + "=" + dump(v[n], depth + 1)); } catch (eP) {}
            }
        } catch (eR) { return String(v); }
        return "{" + p.join(" ") + "}";
    }
    try {
        app.enableQE();
        var qs = qe.project.getActiveSequence();
        var calls = ["isIncompleteBackgroundVideoEffects", "getRedBarTimes", "getYellowBarTimes",
                     "getGreenBarTimes", "getEmptyBarTimes"];
        out.push("Fonctions QE de la séquence active :");
        for (var c = 0; c < calls.length; c++) {
            try { out.push("  " + calls[c] + "() → " + dump(qs[calls[c]](), 0)); }
            catch (eC) { out.push("  " + calls[c] + "() → erreur : " + eC); }
        }
    } catch (eQ) { out.push("QE indisponible : " + eQ); }
    out.push("Clips stabilisés (piste, nom, début → fin en s) :");
    for (var t = 0; t < seq.videoTracks.numTracks; t++) {
        var tr = seq.videoTracks[t];
        for (var j = 0; j < tr.clips.numItems; j++) {
            var cl = tr.clips[j], pi = null;
            try { pi = cl.projectItem; } catch (eI) {}
            var nest = pi && _isStabName(pi.name);
            if (!nest && !_warpComp(cl)) continue;
            out.push("  V" + (t + 1) + " " + cl.name + " : " + cl.start.seconds.toFixed(2) + " → " +
                cl.end.seconds.toFixed(2) + (nest ? " (nest)" : ""));
        }
    }
    return out.join("\n");
}

// API panneau : diagnostic des clips vidéo sélectionnés (rien n'est modifié).
function SW_diagWarp() {
    if (!app.project) return "ECHEC aucun projet ouvert";
    var seq = app.project.activeSequence;
    if (!seq) return "ECHEC aucune séquence active";
    var picks = [];
    try {
        for (var t = 0; t < seq.videoTracks.numTracks; t++) {
            var tr = seq.videoTracks[t];
            for (var k = 0; k < tr.clips.numItems; k++) {
                var clip = tr.clips[k];
                if (clip.mediaType === "Video" && clip.isSelected()) picks.push({ item: clip, t: t });
            }
        }
    } catch (eS) {}
    if (!picks.length) return "Diagnostic : sélectionne d'abord le(s) clip(s) qui affiche(nt) le bandeau bleu, puis relance.";
    var res = ["StableWarp — diagnostic bandeau — " + SW_env()];
    for (var p = 0; p < picks.length; p++) res.push(_diagWarpComp(picks[p].item, picks[p].t));
    return res.join("\n\n");
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

