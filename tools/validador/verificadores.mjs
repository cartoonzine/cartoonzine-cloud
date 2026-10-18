/**
 * validador/verificadores.mjs — testa UM link conforme o formato.
 *
 * O que cada verificador confere (sem "assistir" o vídeo; só o mínimo para saber
 * se um player teria o que abrir):
 *   hls      → playlist começa com #EXTM3U; se for "master", abre UMA variante;
 *              a playlist de mídia precisa ter #EXTINF + segmentos; baixa 1 KB de
 *              UM segmento (e o #EXT-X-MAP, se houver) e confere a assinatura.
 *   dash     → XML com <MPD>, <Period> e <AdaptationSet>/<Representation>; se o
 *              segmento de inicialização tiver endereço fixo, testa ele também.
 *   arquivo  → mp4/webm/mkv/mp3... : pede só os primeiros 4 KB (Range) e confere a
 *              "assinatura" do arquivo (ftyp, EBML, OggS, ID3...). Página HTML = falha.
 *   mpegts   → .ts / Xtream ao vivo: lê até 64 KB e procura o byte de sincronia 0x47.
 *   generico → sem extensão: olha o Content-Type e os primeiros bytes e decide.
 *
 * Não é verificado (fica como está, nunca é removido por isso):
 *   embed (YouTube, Vimeo, Drive...), torrent/magnet, rtmp/udp/rtsp, Internet Archive "details".
 *   Conteúdo com DRM (Widevine/PlayReady/FairPlay) é marcado "protegido" e NÃO é testado
 *   além do manifesto — o validador não tenta contornar proteção.
 *
 * Resultado padrão:
 *   { estado: 'ok'|'falhou'|'protegido'|'nao_verificavel', tipo, motivo?, transitorio?,
 *     http?, ttfb?, confianca: 'alta'|'media'|'baixa', avisos: [], detalhes: {} }
 *
 * IMPORTANTE: "ok" quer dizer que a nuvem conseguiu abrir o começo do conteúdo.
 * NÃO é garantia de que vai tocar no aparelho do usuário (região, DRM, codec...).
 */
import { ErroValidacao } from './seguranca.mjs';

const EXT_ARQUIVO = /\.(mp4|m4v|webm|ogv|ogg|mov|mkv|3gp|3g2|avi|wmv|asf|mpg|mpeg|m2v|vob|f4v|mka|mp3|m4a|m4b|aac|flac|wav|opus|oga|wma)$/;

/** Mesmas regras do format-detector.js do player (para os dois concordarem). */
export function detectarTipo(rawUrl) {
    const url = String(rawUrl || '').trim();
    const low = url.toLowerCase();
    if (!url) return 'vazio';
    if (low.startsWith('magnet:')) return 'torrent';
    if (/^(rtmp[est]?|rtmpts|rtsps?|udp|rtp|mms[th]?|srt|tcp):\/\//.test(low)) return 'rtmp';
    if (!/^https?:\/\//.test(low)) return 'outro';
    const path = low.split('#')[0].split('?')[0];
    const query = low.includes('?') ? low.split('?')[1].split('#')[0] : '';
    if (path.endsWith('.torrent')) return 'torrent';
    if (/(youtube(-nocookie)?\.com|youtu\.be|vimeo\.com|dailymotion\.com|dai\.ly|drive\.google\.com)\//.test(low)) return 'embed';
    if (/archive\.org\/(details|embed)\//.test(low)) return 'embed';
    if (path.endsWith('.m3u8') || /(^|&)(type|output|format|extension)=(m3u8|hls)/.test(query) || /\/hls\/|format=m3u8|\.m3u8\//.test(low)) return 'hls';
    if (path.endsWith('.mpd') || /(^|&)(type|output|format)=(mpd|dash)/.test(query) || /\.ism\/manifest/.test(path)) return 'dash';
    if (path.endsWith('.m3u') || /\/get\.php$/.test(path)) return 'lista';
    if (/\.(ts|m2ts|mts|flv)$/.test(path) || /(^|&)(output|extension)=(ts|mpegts)/.test(query)) return 'mpegts';
    if (EXT_ARQUIVO.test(path)) return 'arquivo';
    if (/\/live\/[^/]+\/[^/]+\/\d+\/?$/.test(path)) return 'mpegts';
    return 'generico';
}

// ------------------------------------------------------------------ assinaturas
/** Reconhece o tipo de mídia pelos primeiros bytes. */
export function assinatura(b) {
    if (!b || b.length < 4) return null;
    const s = (i, str) => b.length >= i + str.length && b.toString('latin1', i, i + str.length) === str;
    if (b[0] === 0x47 && (b.length < 189 || b[188] === 0x47)) return 'mpegts';
    if (s(4, 'ftyp') || s(4, 'styp') || s(4, 'moof') || s(4, 'sidx') || s(4, 'moov') || s(4, 'free') || s(4, 'mdat')) return 'mp4';
    if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm/mkv';
    if (s(0, 'OggS')) return 'ogg';
    if (s(0, 'ID3')) return 'id3';                                  // mp3 / aac de HLS
    if (b[0] === 0xff && (b[1] & 0xf6) === 0xf0) return 'aac';     // ADTS
    if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'mp3';
    if (s(0, 'fLaC')) return 'flac';
    if (s(0, 'RIFF')) return 'riff';                                // avi/wav
    if (s(0, 'FLV')) return 'flv';
    if (b[0] === 0x30 && b[1] === 0x26 && b[2] === 0xb2 && b[3] === 0x75) return 'asf';
    if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && (b[3] === 0xba || b[3] === 0xb3)) return 'mpeg-ps';
    // TS com cabeçalho de 4 bytes extra (M2TS)
    if (b.length > 196 && b[4] === 0x47 && b[196] === 0x47) return 'mpegts';
    return null;
}

const pareceHtml = (b) => /^\s*(<!doctype html|<html|<head|<body|<\?xml[^>]*>\s*<html)/i.test(b.toString('utf8', 0, Math.min(b.length, 512)));
const pareceTexto = (b) => { const t = b.toString('utf8', 0, Math.min(b.length, 256)); return !/[\x00-\x08\x0e-\x1f]/.test(t); };
const textoDe = (b) => b.toString('utf8').replace(/^﻿/, '');

function erroHttp(status) {
    if (status === 429) return new ErroValidacao('http_429', 'servidor pediu para diminuir o ritmo', true, { http: status });
    if (status === 408 || status === 425 || status >= 500) return new ErroValidacao(`http_${status}`, `servidor respondeu ${status}`, true, { http: status });
    if (status === 401 || status === 403) return new ErroValidacao(`http_${status}`, 'acesso negado (o validador não contorna bloqueios)', false, { http: status });
    if (status === 404 || status === 410) return new ErroValidacao(`http_${status}`, 'não encontrado', false, { http: status });
    if (status === 451) return new ErroValidacao('http_451', 'indisponível por razão legal', false, { http: status });
    return new ErroValidacao(`http_${status}`, `servidor respondeu ${status}`, false, { http: status });
}

/** GET com checagem de status; devolve a resposta. */
async function buscar(ctx, url, extra = {}) {
    const r = await ctx.req(url, { timeoutMs: ctx.timeoutMs, headers: ctx.headers, sinal: ctx.sinal, ...extra });
    if (r.status === 416 && extra.range) return buscar(ctx, url, { ...extra, range: undefined, maxBytes: extra.maxBytes || 4096 }); // não aceita Range
    if (r.status < 200 || r.status >= 300) {
        const e = erroHttp(r.status);
        if (r.status === 429) e.retryAfter = r.headers['retry-after'];
        throw e;
    }
    return r;
}

// ------------------------------------------------------------------ HLS
/** Lê os atributos de uma linha #EXT-X-...:A=1,B="x,y" */
function atributos(linha) {
    const o = {};
    const corpo = linha.slice(linha.indexOf(':') + 1);
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(corpo))) o[m[1]] = m[2].replace(/^"|"$/g, '');
    return o;
}

const DRM_HLS = /^(SAMPLE-AES(-CTR|-CENC)?)$/i;
const KEYFORMAT_DRM = /(widevine|playready|fairplay|streamingkeydelivery|com\.microsoft|edef8ba9|9a04f079)/i;

/** Analisa o texto de uma playlist HLS. Exportado para os testes. */
export function analisarHls(texto, base) {
    const linhas = texto.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!linhas.length || !linhas[0].startsWith('#EXTM3U')) return { erro: 'playlist sem #EXTM3U' };
    const variantes = [], midias = [], segmentos = [];
    let drm = false, mapa = null, alvo = null, fim = false, esperaUri = null, extinf = 0;
    for (let i = 1; i < linhas.length; i++) {
        const l = linhas[i];
        if (l.startsWith('#EXT-X-STREAM-INF')) { esperaUri = { tipo: 'var', attrs: atributos(l) }; continue; }
        if (l.startsWith('#EXT-X-MEDIA:')) { const a = atributos(l); if (a.URI) midias.push({ uri: a.URI, tipo: a.TYPE }); continue; }
        if (l.startsWith('#EXT-X-KEY') || l.startsWith('#EXT-X-SESSION-KEY')) {
            const a = atributos(l);
            if (DRM_HLS.test(a.METHOD || '') || KEYFORMAT_DRM.test(a.KEYFORMAT || '') || /^skd:/i.test(a.URI || '')) drm = true;
            continue;
        }
        if (l.startsWith('#EXT-X-MAP')) { const a = atributos(l); if (a.URI && !mapa) mapa = a.URI; continue; }
        if (l.startsWith('#EXT-X-TARGETDURATION')) { alvo = parseFloat(l.split(':')[1]); continue; }
        if (l.startsWith('#EXT-X-ENDLIST')) { fim = true; continue; }
        if (l.startsWith('#EXTINF')) { extinf++; esperaUri = { tipo: 'seg' }; continue; }
        if (l.startsWith('#')) continue;
        // linha de URI
        if (esperaUri && esperaUri.tipo === 'var') variantes.push({ uri: l, banda: +(esperaUri.attrs.BANDWIDTH || 0), resolucao: esperaUri.attrs.RESOLUTION || null, codecs: esperaUri.attrs.CODECS || null });
        else if (esperaUri && esperaUri.tipo === 'seg') segmentos.push(l);
        esperaUri = null;
    }
    const abs = (u) => { try { return new URL(u, base).href; } catch { return null; } };
    if (variantes.length) return { master: true, drm, variantes: variantes.map(v => ({ ...v, url: abs(v.uri) })).filter(v => v.url), midias: midias.map(m => ({ ...m, url: abs(m.uri) })).filter(m => m.url) };
    if (!extinf || !segmentos.length) return { erro: 'playlist sem segmentos (#EXTINF)', drm };
    if (extinf !== segmentos.length) return { erro: 'playlist malformada (#EXTINF sem segmento)', drm };
    return { master: false, drm, ao_vivo: !fim, duracaoAlvo: alvo, mapa: mapa && abs(mapa), segmentos: segmentos.map(abs).filter(Boolean), semAlvo: alvo == null };
}

async function verificarHls(url, ctx, profundidade = 0) {
    const r = await buscar(ctx, url, { maxBytes: ctx.maxBytesPlaylist });
    if (r.truncado) throw new ErroValidacao('playlist_grande_demais', 'playlist maior que o limite');
    if (pareceHtml(r.corpo)) throw new ErroValidacao('pagina_html', 'o link devolve uma página, não uma playlist');
    const p = analisarHls(textoDe(r.corpo), r.urlFinal);
    if (p.erro) throw new ErroValidacao('playlist_malformada', p.erro);
    const res = { tipo: 'hls', http: r.status, ttfb: r.ttfb, redirecionamentos: r.redirecionamentos, avisos: [], detalhes: {} };
    if (p.drm) return { ...res, estado: 'protegido', motivo: 'conteúdo com DRM (não testado além da playlist)', confianca: 'baixa' };

    if (p.master) {
        if (profundidade > 0) throw new ErroValidacao('playlist_malformada', 'master dentro de master');
        if (!p.variantes.length) throw new ErroValidacao('playlist_malformada', 'master sem variantes');
        res.detalhes.variantes = p.variantes.length;
        // testa a primeira variante (é a que o hls.js costuma abrir primeiro); se falhar, mais uma
        let ultimoErro;
        for (const v of p.variantes.slice(0, 2)) {
            try {
                const sub = await verificarHls(v.url, ctx, 1);
                if (sub.estado === 'protegido') return { ...res, estado: 'protegido', motivo: sub.motivo, confianca: 'baixa' };
                if (v !== p.variantes[0]) res.avisos.push('a 1ª variante falhou; a 2ª funcionou');
                return { ...res, estado: 'ok', confianca: sub.confianca, avisos: res.avisos.concat(sub.avisos), detalhes: { ...res.detalhes, ...sub.detalhes } };
            } catch (e) {
                ultimoErro = e;
                if (e.codigo === 'interrompido') throw e;
            }
        }
        throw ultimoErro;
    }

    res.detalhes.segmentos = p.segmentos.length;
    res.detalhes.aoVivo = p.ao_vivo;
    if (p.semAlvo) res.avisos.push('sem #EXT-X-TARGETDURATION');
    // ao vivo: o segmento mais novo (os antigos saem da janela); VOD: o primeiro
    const seg = p.ao_vivo ? p.segmentos[p.segmentos.length - 1] : p.segmentos[0];
    if (p.mapa) {
        const m = await buscar(ctx, p.mapa, { range: [0, 1023], maxBytes: 1024 });
        if (pareceHtml(m.corpo)) throw new ErroValidacao('segmento_invalido', 'segmento de inicialização devolve uma página');
    }
    const s = await buscar(ctx, seg, { range: [0, 1023], maxBytes: 1024 });
    if (!s.corpo.length) throw new ErroValidacao('segmento_vazio', 'segmento sem dados');
    if (pareceHtml(s.corpo)) throw new ErroValidacao('segmento_invalido', 'o segmento devolve uma página');
    const ass = assinatura(s.corpo);
    res.detalhes.segmento = ass || 'desconhecido';
    return { ...res, estado: 'ok', confianca: ass ? 'alta' : 'media' };
}

// ------------------------------------------------------------------ DASH
export function analisarDash(texto) {
    const t = texto.replace(/^﻿/, '');
    if (!/<MPD[\s>]/.test(t)) return { erro: 'manifesto sem <MPD>' };
    if (!/<Period[\s>]/.test(t)) return { erro: 'manifesto sem <Period>' };
    if (!/<(AdaptationSet|Representation)[\s>]/.test(t)) return { erro: 'manifesto sem <AdaptationSet>' };
    const drm = /<ContentProtection[\s>]/i.test(t); // qualquer proteção (CENC, Widevine, PlayReady) = DRM
    const ao_vivo = /type="dynamic"/.test(t);
    // inicialização com endereço fixo (sem $Number$/$Time$)
    let init = null;
    const m = t.match(/initialization="([^"$]+)"/) || t.match(/<Initialization[^>]*sourceURL="([^"$]+)"/);
    if (m) init = m[1];
    const base = (t.match(/<BaseURL>([^<]+)<\/BaseURL>/) || [])[1] || null;
    return { drm, ao_vivo, init, base };
}

async function verificarDash(url, ctx) {
    const r = await buscar(ctx, url, { maxBytes: ctx.maxBytesManifesto });
    if (r.truncado) throw new ErroValidacao('manifesto_grande_demais', 'manifesto maior que o limite');
    if (pareceHtml(r.corpo)) throw new ErroValidacao('pagina_html', 'o link devolve uma página, não um manifesto');
    const p = analisarDash(textoDe(r.corpo));
    if (p.erro) throw new ErroValidacao('manifesto_malformado', p.erro);
    const res = { tipo: 'dash', http: r.status, ttfb: r.ttfb, redirecionamentos: r.redirecionamentos, avisos: [], detalhes: { aoVivo: p.ao_vivo } };
    if (p.drm) return { ...res, estado: 'protegido', motivo: 'conteúdo com DRM (não testado além do manifesto)', confianca: 'baixa' };
    if (p.init) {
        let alvo;
        try { alvo = new URL(p.init, p.base ? new URL(p.base, r.urlFinal) : r.urlFinal).href; } catch { alvo = null; }
        if (alvo) {
            const s = await buscar(ctx, alvo, { range: [0, 1023], maxBytes: 1024 });
            if (pareceHtml(s.corpo)) throw new ErroValidacao('segmento_invalido', 'a inicialização devolve uma página');
            res.detalhes.segmento = assinatura(s.corpo) || 'desconhecido';
            return { ...res, estado: 'ok', confianca: assinatura(s.corpo) ? 'alta' : 'media' };
        }
    }
    res.avisos.push('segmentos com endereço variável: só o manifesto foi conferido');
    return { ...res, estado: 'ok', confianca: 'media' };
}

// ------------------------------------------------------------------ arquivo / ts / genérico
async function verificarArquivo(url, ctx, tipo) {
    const ts = tipo === 'mpegts';
    const r = await buscar(ctx, url, ts ? { maxBytes: 64 * 1024 } : { range: [0, 4095], maxBytes: 4096 });
    const res = { tipo, http: r.status, ttfb: r.ttfb, redirecionamentos: r.redirecionamentos, avisos: [], detalhes: {} };
    if (!r.corpo.length) throw new ErroValidacao('resposta_vazia', 'o servidor respondeu sem dados');
    if (pareceHtml(r.corpo)) throw new ErroValidacao('pagina_html', 'o link devolve uma página, não um vídeo');
    const ass = assinatura(r.corpo);
    const ct = String(r.headers['content-type'] || '').toLowerCase();
    res.detalhes.assinatura = ass || 'desconhecida';
    if (!ts && r.status === 200 && !r.headers['accept-ranges']) res.avisos.push('servidor não aceita Range (avançar o vídeo pode falhar)');
    if (ass) return { ...res, estado: 'ok', confianca: 'alta' };
    if (/^(video|audio)\//.test(ct) || ct === 'application/octet-stream' || ct === 'binary/octet-stream') {
        res.avisos.push('formato não reconhecido pelos primeiros bytes');
        return { ...res, estado: 'ok', confianca: 'media' };
    }
    if (pareceTexto(r.corpo)) throw new ErroValidacao('conteudo_invalido', `o link devolve texto (${ct || 'sem tipo'}), não um vídeo`);
    return { ...res, estado: 'ok', confianca: 'baixa', avisos: res.avisos.concat('tipo de conteúdo desconhecido') };
}

async function verificarGenerico(url, ctx) {
    const r = await buscar(ctx, url, { maxBytes: ctx.maxBytesPlaylist });
    const ct = String(r.headers['content-type'] || '').toLowerCase();
    const ini = textoDe(r.corpo.subarray(0, 2048));
    if (/mpegurl/.test(ct) || ini.trimStart().startsWith('#EXTM3U')) {
        if (/#EXT-X-|#EXTINF/.test(textoDe(r.corpo))) return verificarHls(r.urlFinal, ctx);
        return { tipo: 'lista', estado: 'ok', confianca: 'media', http: r.status, ttfb: r.ttfb, redirecionamentos: r.redirecionamentos, avisos: ['é uma lista M3U, não um vídeo'], detalhes: {} };
    }
    if (/dash\+xml/.test(ct) || /<MPD[\s>]/.test(ini)) return verificarDash(r.urlFinal, ctx);
    if (pareceHtml(r.corpo)) throw new ErroValidacao('pagina_html', 'o link devolve uma página, não um vídeo');
    const ass = assinatura(r.corpo);
    if (ass) return { tipo: ass === 'mpegts' ? 'mpegts' : 'arquivo', estado: 'ok', confianca: 'alta', http: r.status, ttfb: r.ttfb, redirecionamentos: r.redirecionamentos, avisos: [], detalhes: { assinatura: ass } };
    if (/^(video|audio)\//.test(ct)) return { tipo: 'arquivo', estado: 'ok', confianca: 'media', http: r.status, ttfb: r.ttfb, redirecionamentos: r.redirecionamentos, avisos: ['formato não reconhecido pelos primeiros bytes'], detalhes: {} };
    if (!r.corpo.length) throw new ErroValidacao('resposta_vazia', 'o servidor respondeu sem dados');
    throw new ErroValidacao('conteudo_invalido', `conteúdo não parece mídia (${ct || 'sem tipo'})`);
}

// links que o validador se RECUSA a acessar por segurança: ficam como estão (não contam como falha)
const BLOQUEIOS = new Set(['destino_bloqueado', 'porta_bloqueada', 'credencial_na_url', 'protocolo_nao_permitido']);

/**
 * Testa um link. Nunca lança: devolve sempre um resultado.
 * @param {string} url
 * @param {object} ctx  { req, timeoutMs, headers, sinal, maxBytesPlaylist, maxBytesManifesto }
 */
export async function verificar(url, ctx) {
    const tipo = detectarTipo(url);
    const c = { maxBytesPlaylist: 512 * 1024, maxBytesManifesto: 1024 * 1024, ...ctx };
    const t0 = Date.now();
    try {
        let r;
        switch (tipo) {
            case 'vazio': return { tipo, estado: 'falhou', motivo: 'sem link', codigo: 'sem_url', transitorio: false, avisos: [] };
            case 'embed': case 'torrent': case 'rtmp': case 'outro':
                return { tipo, estado: 'nao_verificavel', motivo: 'formato que a nuvem não testa (fica como está)', avisos: [], confianca: 'baixa' };
            case 'hls': r = await verificarHls(url, c); break;
            case 'dash': r = await verificarDash(url, c); break;
            case 'arquivo': case 'mpegts': r = await verificarArquivo(url, c, tipo); break;
            default: r = await verificarGenerico(url, c);
        }
        return { ...r, duracao: Date.now() - t0 };
    } catch (e) {
        const err = e instanceof ErroValidacao ? e : new ErroValidacao('erro_interno', String(e && e.message || e), false);
        return {
            tipo, estado: BLOQUEIOS.has(err.codigo) ? 'bloqueado' : 'falhou', codigo: err.codigo, motivo: err.message, transitorio: !!err.transitorio,
            http: err.http, retryAfter: err.retryAfter, duracao: Date.now() - t0, avisos: []
        };
    }
}
