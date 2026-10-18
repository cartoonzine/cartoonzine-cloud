/**
 * validador/seguranca.mjs — a ÚNICA porta de saída do validador para a internet.
 *
 * Toda requisição feita para testar um link passa por `requisitar()`, que garante:
 *   • só http: e https: (nada de file:, ftp:, data:, gopher:...)
 *   • URL com usuário/senha embutidos (https://user:pass@host) é recusada
 *   • o DNS é resolvido AQUI e o IP é conferido ANTES de conectar; a conexão usa
 *     exatamente o IP conferido (sem segunda resolução → sem "DNS rebinding")
 *   • bloqueia loopback, redes privadas, link-local, CGNAT, multicast, reservados
 *     e o endereço de metadados de nuvem (169.254.169.254, fd00:ec2::254 ...)
 *   • redirecionamentos são seguidos à mão (máx. N), e CADA destino passa pelas
 *     mesmas regras de novo
 *   • corta a resposta depois de `maxBytes` e a requisição depois de `timeoutMs`
 *   • só envia cabeçalhos de uma lista segura (nunca Cookie/Authorization)
 *   • `redigir()` produz uma versão do link segura para log (sem tokens)
 *
 * Sem dependências externas: só módulos nativos do Node 18+.
 */
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

export const USER_AGENT = 'CartoonzineLinkCheck/1.0 (+https://github.com/cartoonzine/cartoonzine-cloud)';

// ------------------------------------------------------------------ redes bloqueadas
const BLOQUEADAS_V4 = [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
    ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
    ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
];
const BLOQUEADAS_V6 = [
    ['::', 128], ['::1', 128], ['::', 96] /* IPv4-compatível antigo */, ['100::', 64],
    ['2001:db8::', 32], ['2001::', 32] /* Teredo */, ['2002::', 16] /* 6to4 */,
    ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]
];

function criarLista(extrasPermitidas) {
    const bloq = new net.BlockList();
    for (const [a, p] of BLOQUEADAS_V4) bloq.addSubnet(a, p, 'ipv4');
    for (const [a, p] of BLOQUEADAS_V6) bloq.addSubnet(a, p, 'ipv6');
    const perm = new net.BlockList();
    for (const cidr of extrasPermitidas || []) {
        const [a, p] = String(cidr).split('/');
        const fam = net.isIPv6(a) ? 'ipv6' : 'ipv4';
        perm.addSubnet(a, +(p || (fam === 'ipv6' ? 128 : 32)), fam);
    }
    return { bloq, perm };
}

/** IPv6 que embute um IPv4 (::ffff:a.b.c.d, 64:ff9b::a.b.c.d) → devolve o IPv4. */
function ipv4Embutido(ip) {
    const low = ip.toLowerCase();
    let m = low.match(/^(?:0{0,4}:){0,5}:?ffff:(\d+\.\d+\.\d+\.\d+)$/) || low.match(/^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return m[1];
    m = low.match(/^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/) || low.match(/^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (m) {
        const a = parseInt(m[1], 16), b = parseInt(m[2], 16);
        return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
    }
    return null;
}

/** true se o IP é de destino proibido. `listas` vem de criarLista(). */
export function ipProibido(ip, listas) {
    const fam = net.isIP(ip);
    if (!fam) return true;
    if (listas.perm.check(ip, fam === 6 ? 'ipv6' : 'ipv4')) return false; // só nos testes
    if (fam === 6) {
        const v4 = ipv4Embutido(ip);
        if (v4) return ipProibido(v4, listas);
        if (/^fd00:ec2::254$/i.test(ip)) return true;
        return listas.bloq.check(ip, 'ipv6');
    }
    return listas.bloq.check(ip, 'ipv4');
}

// ------------------------------------------------------------------ erros classificados
export class ErroValidacao extends Error {
    /**
     * @param {string} codigo   ex.: 'destino_bloqueado', 'timeout', 'dns', 'http_404'
     * @param {boolean} transitorio  vale tentar de novo neste ciclo?
     */
    constructor(codigo, mensagem, transitorio = false, extra = {}) {
        super(mensagem || codigo);
        this.codigo = codigo;
        this.transitorio = transitorio;
        Object.assign(this, extra);
    }
}

function classificarErroDeRede(e) {
    if (e instanceof ErroValidacao) return e;
    const c = e && e.code;
    if (c === 'ENOTFOUND') return new ErroValidacao('dns', 'domínio não existe', false);
    if (c === 'EAI_AGAIN') return new ErroValidacao('dns_temporario', 'DNS não respondeu', true);
    if (c === 'ECONNREFUSED') return new ErroValidacao('conexao_recusada', 'servidor recusou a conexão', true);
    if (c === 'ECONNRESET' || c === 'EPIPE' || c === 'UND_ERR_SOCKET') return new ErroValidacao('conexao_caiu', 'conexão interrompida', true);
    if (c === 'EHOSTUNREACH' || c === 'ENETUNREACH') return new ErroValidacao('sem_rota', 'servidor inalcançável', true);
    if (c === 'HPE_HEADER_OVERFLOW' || (c && c.startsWith('HPE_'))) return new ErroValidacao('resposta_malformada', 'resposta HTTP malformada', false);
    if (c && /CERT|SSL|TLS|ERR_TLS/.test(c)) return new ErroValidacao('tls', 'certificado/TLS inválido', false);
    return new ErroValidacao('rede', (e && e.message) || 'erro de rede', true);
}

// ------------------------------------------------------------------ log seguro
const PARAM_SENSIVEL = /^(token|tok|key|apikey|api_key|auth|sig|signature|hdnts|hdnea|expires?|exp|policy|session|sid|jwt|password|pass|pwd|user|username|uid|access_token|x-amz-[a-z-]+|st|e|h|md5|hash)$/i;

/** Versão do link segura para log: sem usuário/senha, sem query, sem trechos com cara de token. */
export function redigir(url) {
    let u;
    try { u = new URL(url); } catch { return '[url inválida]'; }
    const partes = u.pathname.split('/').map(p =>
        p.length > 32 || /^[A-Za-z0-9_-]{20,}$/.test(p) || /[A-Za-z].*\d.*[A-Za-z].*\d/.test(p) && p.length > 16 ? '***' : p);
    // Xtream: /live/<usuario>/<senha>/123.ts  →  /live/***/***/123.ts
    if (/^(live|movie|series|timeshift)$/i.test(partes[1] || '') && partes.length >= 5) { partes[2] = '***'; partes[3] = '***'; }
    const q = [...u.searchParams.keys()];
    const query = q.length ? '?' + q.map(k => PARAM_SENSIVEL.test(k) ? `${k}=***` : `${k}=…`).join('&') : '';
    return `${u.protocol}//${u.host}${partes.join('/')}${query}`;
}

/** Chave estável para guardar o link no cache sem repetir o link (que pode ter token). */
export function chaveDoLink(url) {
    return crypto.createHash('sha256').update(String(url)).digest('base64url').slice(0, 22);
}

// ------------------------------------------------------------------ cabeçalhos
const CABECALHOS_PERMITIDOS = new Set(['referer', 'origin', 'user-agent', 'accept', 'accept-language']);

export function cabecalhosSeguros(h) {
    const out = {};
    for (const [k, v] of Object.entries(h || {})) {
        if (CABECALHOS_PERMITIDOS.has(k.toLowerCase()) && typeof v === 'string' && v.length < 512 && !/[\r\n]/.test(v)) out[k] = v;
    }
    return out;
}

// ------------------------------------------------------------------ requisição
/**
 * Cria a função de requisição com as regras de segurança.
 * @param {object} cfg
 * @param {string[]} [cfg.redesPermitidas]  SÓ PARA TESTES: CIDRs liberados (ex.: ['127.0.0.1/32'])
 * @param {number[]} [cfg.portasBloqueadas] portas que nunca são acessadas (SMTP, SSH, bancos...)
 */
export function criarRequisitor(cfg = {}) {
    const listas = criarLista(cfg.redesPermitidas);
    const portasBloqueadas = new Set(cfg.portasBloqueadas || [22, 23, 25, 110, 143, 445, 465, 587, 993, 995, 1433, 1521, 2375, 2376, 3306, 3389, 5432, 5984, 6379, 9200, 9300, 11211, 27017]);
    const resolver = cfg.resolver || dns.promises; // trocável nos testes

    // agentes sem keep-alive: cada teste é independente e nada fica pendurado no fim
    const agentes = { 'http:': new http.Agent({ keepAlive: false }), 'https:': new https.Agent({ keepAlive: false }) };

    async function conferirDestino(u) {
        if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ErroValidacao('protocolo_nao_permitido', `protocolo ${u.protocol} não é testado`);
        if (u.username || u.password) throw new ErroValidacao('credencial_na_url', 'link com usuário/senha embutidos não é testado');
        const porta = +(u.port || (u.protocol === 'https:' ? 443 : 80));
        if (portasBloqueadas.has(porta)) throw new ErroValidacao('porta_bloqueada', `porta ${porta} não é testada`);
        const host = u.hostname.replace(/^\[|\]$/g, '');
        if (!host || /^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i.test(host))
            throw new ErroValidacao('destino_bloqueado', 'destino interno');
        let enderecos;
        if (net.isIP(host)) enderecos = [{ address: host, family: net.isIP(host) }];
        else {
            try { enderecos = await resolver.lookup(host, { all: true, verbatim: true }); }
            catch (e) { throw classificarErroDeRede(e); }
        }
        if (!enderecos.length) throw new ErroValidacao('dns', 'domínio sem endereço');
        // se QUALQUER endereço do nome for interno, recusa (evita sortear o interno depois)
        if (enderecos.some(a => ipProibido(a.address, listas))) throw new ErroValidacao('destino_bloqueado', 'o domínio aponta para rede interna/privada');
        return { endereco: enderecos[0], porta };
    }

    /** Uma requisição, sem seguir redirecionamento. */
    function umaVez(u, alvo, opt, sinal) {
        return new Promise((resolve, reject) => {
            const mod = u.protocol === 'https:' ? https : http;
            const inicio = Date.now();
            let fim = false;
            const headers = { 'User-Agent': USER_AGENT, Accept: '*/*', ...cabecalhosSeguros(opt.headers), 'Accept-Encoding': 'gzip, deflate, br' };
            if (opt.range) headers.Range = `bytes=${opt.range[0]}-${opt.range[1]}`;
            const req = mod.request({
                protocol: u.protocol,
                hostname: u.hostname.replace(/^\[|\]$/g, ''),
                port: alvo.porta,
                path: u.pathname + u.search,
                method: opt.method || 'GET',
                headers,
                agent: agentes[u.protocol],
                servername: net.isIP(u.hostname) ? undefined : u.hostname,
                maxHeaderSize: 32 * 1024,
                // usa SEMPRE o IP já conferido (não deixa o sistema resolver de novo)
                lookup: (_h, o, cb) => (o && o.all)
                    ? cb(null, [{ address: alvo.endereco.address, family: alvo.endereco.family }])
                    : cb(null, alvo.endereco.address, alvo.endereco.family)
            });
            const acabar = (erro, valor) => {
                if (fim) return; fim = true;
                clearTimeout(relogio);
                if (sinal) sinal.removeEventListener('abort', aoAbortar);
                erro ? reject(erro) : resolve(valor);
            };
            const relogio = setTimeout(() => { req.destroy(); acabar(new ErroValidacao('timeout', `sem resposta em ${opt.timeoutMs} ms`, true)); }, opt.timeoutMs);
            const aoAbortar = () => { req.destroy(); acabar(new ErroValidacao('interrompido', 'execução interrompida', false)); };
            if (sinal) { if (sinal.aborted) return aoAbortar(); sinal.addEventListener('abort', aoAbortar, { once: true }); }

            req.on('error', e => acabar(classificarErroDeRede(e)));
            req.on('response', res => {
                const ttfb = Date.now() - inicio;
                const status = res.statusCode;
                if (status >= 300 && status < 400 && res.headers.location) {
                    res.resume();
                    req.destroy();
                    return acabar(null, { status, headers: res.headers, corpo: Buffer.alloc(0), ttfb, redirecionar: res.headers.location });
                }
                if ((opt.method || 'GET') === 'HEAD') { res.resume(); req.destroy(); return acabar(null, { status, headers: res.headers, corpo: Buffer.alloc(0), ttfb }); }

                // descompacta com limite (protege contra "bomba" gzip)
                let fluxo = res;
                const enc = String(res.headers['content-encoding'] || '').toLowerCase().trim();
                if (enc === 'gzip' || enc === 'x-gzip') fluxo = res.pipe(zlib.createGunzip());
                else if (enc === 'deflate') fluxo = res.pipe(zlib.createInflate());
                else if (enc === 'br') fluxo = res.pipe(zlib.createBrotliDecompress());

                const pedacos = []; let total = 0; let truncado = false;
                fluxo.on('data', d => {
                    if (fim) return;
                    const falta = opt.maxBytes - total;
                    if (d.length >= falta) {
                        pedacos.push(d.subarray(0, falta)); total += falta; truncado = true;
                        req.destroy();
                        return acabar(null, { status, headers: res.headers, corpo: Buffer.concat(pedacos, total), ttfb, truncado, duracao: Date.now() - inicio });
                    }
                    pedacos.push(d); total += d.length;
                });
                fluxo.on('end', () => acabar(null, { status, headers: res.headers, corpo: Buffer.concat(pedacos, total), ttfb, truncado, duracao: Date.now() - inicio }));
                fluxo.on('error', e => acabar(total > 0
                    ? null : new ErroValidacao(enc ? 'compressao_invalida' : 'conexao_caiu', 'resposta corrompida', !enc),
                total > 0 ? { status, headers: res.headers, corpo: Buffer.concat(pedacos, total), ttfb, truncado: true, duracao: Date.now() - inicio } : undefined));
                res.on('aborted', () => acabar(total > 0 ? null : new ErroValidacao('conexao_caiu', 'resposta interrompida', true),
                    total > 0 ? { status, headers: res.headers, corpo: Buffer.concat(pedacos, total), ttfb, truncado: true, duracao: Date.now() - inicio } : undefined));
            });
            req.end();
        });
    }

    /**
     * Faz a requisição seguindo redirecionamentos com segurança.
     * @returns {Promise<{status, headers, corpo: Buffer, urlFinal, redirecionamentos, ttfb, truncado}>}
     */
    async function requisitar(url, opt = {}) {
        const o = { method: 'GET', timeoutMs: 8000, maxBytes: 256 * 1024, maxRedirecionamentos: 5, ...opt };
        let atual;
        try { atual = new URL(url); } catch { throw new ErroValidacao('url_invalida', 'link mal formado'); }
        const inicio = Date.now();
        const cadeia = [];
        for (let i = 0; ; i++) {
            const restante = o.timeoutMs - (Date.now() - inicio);
            if (restante <= 0) throw new ErroValidacao('timeout', `sem resposta em ${o.timeoutMs} ms`, true);
            const alvo = await conferirDestino(atual);
            const tHop = Date.now();
            const r = await umaVez(atual, alvo, { ...o, timeoutMs: restante }, o.sinal);
            // ttfb = do início (incluindo redirecionamentos e DNS) até o 1º byte da resposta final
            if (!r.redirecionar) return { ...r, urlFinal: atual.href, redirecionamentos: cadeia.length, ttfb: (tHop - inicio) + r.ttfb };
            if (i >= o.maxRedirecionamentos) throw new ErroValidacao('redirecionamentos_demais', `mais de ${o.maxRedirecionamentos} redirecionamentos`);
            let prox;
            try { prox = new URL(r.redirecionar, atual); } catch { throw new ErroValidacao('redirecionamento_invalido', 'redirecionamento para link mal formado'); }
            if (cadeia.includes(prox.href)) throw new ErroValidacao('redirecionamento_em_loop', 'redirecionamento em círculo');
            cadeia.push(atual.href);
            atual = prox;
        }
    }

    return { requisitar, conferirDestino, encerrar: () => { agentes['http:'].destroy(); agentes['https:'].destroy(); } };
}
