/**
 * Servidor HTTP falso (só em 127.0.0.1) com todos os casos que o validador precisa enfrentar.
 * Conta quantas vezes cada caminho foi pedido e a concorrência máxima por "servidor" (Host).
 */
import http from 'node:http';
import zlib from 'node:zlib';

const TS = (n = 188 * 6) => { const b = Buffer.alloc(n, 0xff); for (let i = 0; i < n; i += 188) b[i] = 0x47; return b; };
const MP4 = () => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(4096, 1)]);
const WEBM = () => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(4096, 2)]);
const HTML = '<!DOCTYPE html><html><body>Login</body></html>';

const master = (pre = '') => `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\n${pre}media.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\n${pre}media-hd.m3u8\n`;
const media = (seg = '/seg/1.ts', fim = true) => `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\n${seg}\n#EXTINF:6.0,\n${seg}?2\n${fim ? '#EXT-X-ENDLIST\n' : ''}`;
const MPD_OK = `<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static"><Period><AdaptationSet mimeType="video/mp4"><SegmentTemplate initialization="/seg/init.mp4" media="/seg/$Number$.m4s"/><Representation id="1" bandwidth="800000"/></AdaptationSet></Period></MPD>`;
const MPD_DRM = `<MPD type="static"><Period><AdaptationSet><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/><Representation id="1"/></AdaptationSet></Period></MPD>`;

export function criarServidor() {
    const pedidos = new Map();     // caminho → n
    const ativosHost = new Map();  // host → simultâneos agora
    const maxHost = new Map();     // host → máximo visto
    const conta = (p) => pedidos.set(p, (pedidos.get(p) || 0) + 1);

    const srv = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://x');
        const p = u.pathname;
        const host = (req.headers.host || '').split(':')[0];
        conta(p);
        ativosHost.set(host, (ativosHost.get(host) || 0) + 1);
        maxHost.set(host, Math.max(maxHost.get(host) || 0, ativosHost.get(host)));
        let liberado = false;
        const liberar = () => { if (!liberado) { liberado = true; ativosHost.set(host, ativosHost.get(host) - 1); } };
        res.on('finish', liberar); res.on('close', liberar);

        const range = (buf, tipo) => {
            const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
            if (m) {
                const a = +m[1], b = Math.min(+m[2], buf.length - 1);
                res.writeHead(206, { 'Content-Type': tipo, 'Content-Range': `bytes ${a}-${b}/${buf.length}`, 'Accept-Ranges': 'bytes' });
                return res.end(buf.subarray(a, b + 1));
            }
            res.writeHead(200, { 'Content-Type': tipo, 'Accept-Ranges': 'bytes' });
            res.end(buf);
        };
        const texto = (t, tipo = 'application/vnd.apple.mpegurl', st = 200) => { res.writeHead(st, { 'Content-Type': tipo }); res.end(t); };
        const atrasar = (ms, fn) => setTimeout(fn, ms);

        // ---------- HLS
        if (p === '/hls/master.m3u8') return texto(master());
        if (p === '/hls/media.m3u8' || p === '/hls/media-hd.m3u8') return texto(media());
        if (p === '/hls/vivo.m3u8') return texto(media('/seg/1.ts', false));
        if (p === '/hls/malformada.m3u8') return texto('#EXTM3U\n#EXTINF:6.0,\n#EXTINF:6.0,\n/seg/1.ts\n');
        if (p === '/hls/sem-cabecalho.m3u8') return texto('isto não é uma playlist');
        if (p === '/hls/sem-segmentos.m3u8') return texto('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-ENDLIST\n');
        if (p === '/hls/drm.m3u8') return texto('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXTINF:6,\n/seg/1.ts\n');
        if (p === '/hls/aes128.m3u8') return texto('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-KEY:METHOD=AES-128,URI="/chave.key"\n#EXTINF:6,\n/seg/1.ts\n#EXT-X-ENDLIST\n');
        if (p === '/hls/fmp4.m3u8') return texto('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MAP:URI="/seg/init.mp4"\n#EXTINF:6,\n/seg/1.m4s\n#EXT-X-ENDLIST\n');
        if (p === '/hls/segmento-html.m3u8') return texto(media('/seg/html.ts'));
        if (p === '/hls/segmento-404.m3u8') return texto(media('/seg/nao-existe.ts'));
        if (p === '/hls/master-quebrada.m3u8') return texto(master('/quebrada/'));
        if (p === '/hls/gigante.m3u8') return texto('#EXTM3U\n' + '#EXTINF:6,\n/seg/1.ts\n'.repeat(60000));
        if (p === '/hls/gzip.m3u8') { res.writeHead(200, { 'Content-Type': 'application/x-mpegurl', 'Content-Encoding': 'gzip' }); return res.end(zlib.gzipSync(media())); }
        if (p === '/hls/html.m3u8') return texto(HTML, 'text/html');
        // ---------- DASH
        if (p === '/dash/ok.mpd') return texto(MPD_OK, 'application/dash+xml');
        if (p === '/dash/drm.mpd') return texto(MPD_DRM, 'application/dash+xml');
        if (p === '/dash/ruim.mpd') return texto('<MPD><Nada/></MPD>', 'application/dash+xml');
        // ---------- segmentos
        if (p === '/seg/1.ts') return range(TS(), 'video/mp2t');
        if (p === '/seg/1.m4s') return range(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('styp'), Buffer.alloc(2000)]), 'video/iso.segment');
        if (p === '/seg/init.mp4') return range(MP4(), 'video/mp4');
        if (p === '/seg/html.ts') return texto(HTML, 'text/html');
        // ---------- arquivos
        if (p === '/v/filme.mp4') return range(MP4(), 'video/mp4');
        if (p === '/v/filme.webm') return range(WEBM(), 'video/webm');
        if (p === '/v/falso.mp4') return texto(HTML, 'text/html');
        if (p === '/v/texto.mp4') return texto('erro: arquivo removido', 'text/plain');
        if (p === '/v/vazio.mp4') return texto('', 'video/mp4');
        if (p === '/v/404.mp4') return texto('não achei', 'text/plain', 404);
        if (p === '/v/403.mp4') return texto('proibido', 'text/plain', 403);
        if (p === '/v/500.mp4') return texto('erro', 'text/plain', 500);
        if (p === '/v/lento.mp4') return; // nunca responde → timeout
        if (p === '/v/lento-um-pouco.mp4') return atrasar(400, () => range(MP4(), 'video/mp4'));
        if (p === '/v/instavel.mp4') return pedidos.get(p) === 1 ? texto('ocupado', 'text/plain', 503) : range(MP4(), 'video/mp4');
        if (p === '/v/429.mp4') { if (pedidos.get(p) === 1) { res.writeHead(429, { 'Retry-After': '1' }); return res.end(); } return range(MP4(), 'video/mp4'); }
        if (p === '/v/429-longo.mp4') { res.writeHead(429, { 'Retry-After': '3600' }); return res.end(); }
        if (p === '/v/sem-range.mp4') { res.writeHead(200, { 'Content-Type': 'video/mp4' }); return res.end(MP4()); }
        if (p.startsWith('/v/demora-')) return atrasar(150, () => range(MP4(), 'video/mp4'));
        // ---------- ao vivo infinito (.ts)
        if (p === '/live/canal.ts') {
            res.writeHead(200, { 'Content-Type': 'video/mp2t' });
            const t = setInterval(() => { if (!res.write(TS(188 * 50))) {} }, 5);
            res.on('close', () => clearInterval(t));
            return;
        }
        // ---------- sem extensão
        if (p === '/semtipo/video') return range(MP4(), 'application/octet-stream');
        if (p === '/semtipo/playlist') return texto(media(), 'application/vnd.apple.mpegurl');
        if (p === '/semtipo/pagina') return texto(HTML, 'text/html');
        // ---------- redirecionamentos
        if (p === '/r/ok') { res.writeHead(302, { Location: '/v/filme.mp4' }); return res.end(); }
        if (p === '/r/loop') { res.writeHead(302, { Location: '/r/loop2' }); return res.end(); }
        if (p === '/r/loop2') { res.writeHead(302, { Location: '/r/loop' }); return res.end(); }
        if (p.startsWith('/r/cadeia/')) { const n = +p.split('/')[3]; res.writeHead(302, { Location: `/r/cadeia/${n + 1}` }); return res.end(); }
        if (p === '/r/interno') { res.writeHead(302, { Location: 'http://10.0.0.5/admin' }); return res.end(); }
        if (p === '/r/metadados') { res.writeHead(301, { Location: 'http://169.254.169.254/latest/meta-data/' }); return res.end(); }
        if (p === '/r/file') { res.writeHead(302, { Location: 'file:///etc/passwd' }); return res.end(); }
        // ---------- eco de cabeçalhos (para conferir o que é enviado)
        if (p === '/eco') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(req.headers)); }
        texto('não existe', 'text/plain', 404);
    });

    return new Promise(ok => srv.listen(0, '127.0.0.1', () => {
        const porta = srv.address().port;
        ok({
            porta,
            base: `http://127.0.0.1:${porta}`,
            url: (host, caminho) => `http://${host}:${porta}${caminho}`,
            pedidos, maxHost,
            zerar() { pedidos.clear(); maxHost.clear(); },
            fechar: () => new Promise(f => { srv.closeAllConnections?.(); srv.close(() => f()); })
        });
    }));
}

/** Resolver de DNS falso: nomes *.teste → 127.0.0.1; alguns nomes apontam para redes proibidas. */
export const resolverFalso = {
    async lookup(host) {
        const mapa = {
            'interno.teste': [{ address: '10.0.0.5', family: 4 }],
            'metadados.teste': [{ address: '169.254.169.254', family: 4 }],
            'misto.teste': [{ address: '127.0.0.1', family: 4 }, { address: '192.168.0.10', family: 4 }],
            'v6local.teste': [{ address: '::1', family: 6 }],
            'mapeado.teste': [{ address: '::ffff:10.1.2.3', family: 6 }]
        };
        if (mapa[host]) return mapa[host];
        if (host === 'naoexiste.teste') { const e = new Error('ENOTFOUND'); e.code = 'ENOTFOUND'; throw e; }
        if (host.endsWith('.teste')) return [{ address: '127.0.0.1', family: 4 }];
        const e = new Error('ENOTFOUND'); e.code = 'ENOTFOUND'; throw e;
    }
};
