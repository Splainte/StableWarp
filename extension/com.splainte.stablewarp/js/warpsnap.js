// StableWarp — lecture des données d'analyse du Warp Stabilizer dans un export de séquence
// (Sequence.exportAsProject). Exécuté côté panneau (Node) ; ES5 (Chromium 66 de CEP).
//
// Pour chaque Warp de la séquence exportée et de ses nests, le projet contient un bloc
// PremiereFilterPrivateData (base64 → 24 octets d'en-tête → zlib → « Stab » + en-tête
// binaire + JSON UTF-16) qui décrit la portion de rush réellement analysée :
//   {"StartTime":{"scale":1,"value":3},"Duration":{"scale":1,"value":5},
//    "StepTime":{"scale":25,"value":1},"SourceID":"…"}  (temps du rush, en secondes)
// Un Warp jamais analysé a 0 image et un SourceID nul. On compare cette portion à celle
// que le clip utilise (InPoint/OutPoint de son Clip) : si elle ne la couvre pas, des
// images ne sont pas analysées → bandeau bleu. Vérifié sur Premiere 26.5 le 2026-10-08.

(function (root) {
    var TPS = 254016000000; // ticks Premiere par seconde
    var VIDEO = '228cda18-3625-4d2d-951e-348879e4ed93'; // type de média « vidéo »
    var WARP = 'AE.ADBE SubspaceStabilizer';

    function inflate(buf) {
        var zlib = require('zlib');
        if (buf[0] === 0x1f && buf[1] === 0x8b) return zlib.gunzipSync(buf);
        return buf;
    }

    // tous les objets de premier niveau, indexés par ObjectID et ObjectUID
    function indexObjects(s) {
        var byId = {}, byUid = {};
        var re = /<(\w+) Object(U?)ID="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/g, m;
        while ((m = re.exec(s))) {
            var o = { tag: m[1], body: m[4] };
            if (m[2]) byUid[m[3]] = o; else byId[m[3]] = o;
        }
        return { id: byId, uid: byUid };
    }

    function num(body, tag) {
        var m = new RegExp('<' + tag + '>(-?\\d+)</' + tag + '>').exec(body);
        return m ? Number(m[1]) : null;
    }

    function rat(o) { return o && o.scale ? o.value / o.scale : 0; }

    // Blocs de données par BinaryHash : des Warp aux données identiques (clip coupé en
    // deux au Cutter) n'en écrivent qu'un, les autres y renvoient par une balise vide.
    function indexBlobs(s) {
        var out = {}, re = /<PremiereFilterPrivateData[^>]*BinaryHash="([^"]+)"[^>]*?(?:\/>|>([^<]*)<)/g, m;
        while ((m = re.exec(s))) if (m[2] && /\S/.test(m[2])) out[m[1]] = m[2];
        return out;
    }

    // données d'analyse d'un composant Warp, ou null si illisibles
    function warpData(body, blobs) {
        var m = /<PremiereFilterPrivateData([^>]*?)(?:\/>|>([^<]*)<)/.exec(body);
        if (!m) return { frames: 0, start: 0, dur: 0, step: 0, src: '' };
        var b64 = m[2] && /\S/.test(m[2]) ? m[2] : null;
        if (!b64) {
            var h = /BinaryHash="([^"]+)"/.exec(m[1]);
            b64 = h && blobs[h[1]];
            if (!b64) return null;
        }
        try {
            var raw = Buffer.from(b64, 'base64');
            var d = require('zlib').inflateSync(raw.slice(24));
            if (d.toString('latin1', 0, 4) !== 'Stab') return null;
            var frames = d.readUInt32BE(20), n = d.readUInt32BE(36);
            var js = d.slice(40, 40 + 2 * n);
            for (var i = 0; i + 1 < js.length; i += 2) { var t = js[i]; js[i] = js[i + 1]; js[i + 1] = t; } // UTF-16BE → LE
            var j = JSON.parse(js.toString('utf16le'));
            return { frames: frames, start: rat(j.StartTime), dur: rat(j.Duration), step: rat(j.StepTime),
                     src: /^0{8}-/.test(j.SourceID || '') ? '' : (j.SourceID || '') };
        } catch (e) { return null; }
    }

    // Liste des Warp de l'export : [{seq, track, start, end, inS, outS, a: données|null, covered}]
    // (temps en secondes ; start/end = position timeline, inS/outS = portion de rush)
    function parse(buf) {
        var s = inflate(buf).toString('utf8');
        var ix = indexObjects(s), blobs = indexBlobs(s), out = [];
        var seqRe = /<Sequence ObjectUID="[^"]+"[^>]*>([\s\S]*?)<\/Sequence>/g, sm;
        while ((sm = seqRe.exec(s))) {
            var sb = sm[1];
            var nm = /<Name>([^<]*)<\/Name>/.exec(sb.replace(/<Node[\s\S]*?<\/Node>/, ''));
            var seqName = nm ? unescapeXml(nm[1]) : '';
            var tgRe = /<TrackGroup Version="\d+" Index="\d+">\s*<First>([^<]+)<\/First>\s*<Second ObjectRef="(\d+)"\/>/g, tg;
            while ((tg = tgRe.exec(sb))) {
                if (tg[1] !== VIDEO || !ix.id[tg[2]]) continue;
                var trRe = /<Track Index="(\d+)" ObjectURef="([^"]+)"\/>/g, tr;
                while ((tr = trRe.exec(ix.id[tg[2]].body))) {
                    var track = ix.uid[tr[2]];
                    if (!track) continue;
                    var itRe = /<TrackItem Index="\d+" ObjectRef="(\d+)"\/>/g, it;
                    while ((it = itRe.exec(track.body))) {
                        var item = ix.id[it[1]];
                        if (!item || item.tag !== 'VideoClipTrackItem') continue;
                        var w = findWarp(ix, blobs, item.body);
                        if (!w) continue;
                        var clip = clipOf(ix, item.body);
                        var e = {
                            seq: seqName, track: Number(tr[1]),
                            start: (num(item.body, 'Start') || 0) / TPS, end: (num(item.body, 'End') || 0) / TPS,
                            inS: clip ? clip.inS : null, outS: clip ? clip.outS : null, a: w.data
                        };
                        e.covered = covers(e);
                        out.push(e);
                    }
                }
            }
        }
        return out;
    }

    function findWarp(ix, blobs, itemBody) {
        var cm = /<Components ObjectRef="(\d+)"\/>/.exec(itemBody);
        var chain = cm && ix.id[cm[1]];
        if (!chain) return null;
        var re = /<Component Index="\d+" ObjectRef="(\d+)"\/>/g, c;
        while ((c = re.exec(chain.body))) {
            var comp = ix.id[c[1]];
            if (comp && comp.body.indexOf('<MatchName>' + WARP + '</MatchName>') >= 0) {
                return { data: warpData(comp.body, blobs) };
            }
        }
        return null;
    }

    function clipOf(ix, itemBody) {
        var sm = /<SubClip ObjectRef="(\d+)"\/>/.exec(itemBody);
        var sub = sm && ix.id[sm[1]];
        var cm = sub && /<Clip ObjectRef="(\d+)"\/>/.exec(sub.body);
        var clip = cm && ix.id[cm[1]];
        if (!clip) return null;
        var i = num(clip.body, 'InPoint'), o = num(clip.body, 'OutPoint');
        if (i === null || o === null) return null;
        return { inS: i / TPS, outS: o / TPS };
    }

    // l'analyse couvre-t-elle toute la portion de rush du clip ? (null = on ne sait pas)
    function covers(e) {
        if (!e.a) return null;
        if (!e.a.frames || !e.a.src || e.a.dur <= 0) return false; // jamais analysé
        if (e.inS === null) return null;
        var tol = Math.max(e.a.step, 0.001) * 1.5;
        return e.a.start <= e.inS + tol && e.a.start + e.a.dur >= e.outS - tol;
    }

    function unescapeXml(t) {
        return t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
    }

    var api = { parse: parse, covers: covers };
    // panneau CEP : global (en contexte mixte, `module` peut aussi exister) ; tests : module Node
    if (root) root.SWWarpSnap = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(this);
