const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');
const { pipeline } = require('stream').promises;
const http = require('http');
const WebSocket = require('ws');
const iconv = require('iconv-lite');

const app = express();
const PORT = process.env.PORT || 80;
const PROXY_ROUTE = '/proxy';

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.raw({ type: ['application/octet-stream', 'multipart/form-data'], limit: '50mb' }));

const INJECTION_SCRIPT = `
<script>
(() => {
    const proxyUrl = '${PROXY_ROUTE}?url=';
    const rewriteUrl = url => {
        if (!url || /^(data|javascript|mailto|#)/i.test(url)) return url;
        try {
            return proxyUrl + encodeURIComponent(new URL(url, document.baseURI).href);
        } catch (e) {
            return url;
        }
    };
    const originalFetch = window.fetch;
    window.fetch = function(input, init) {
        if (typeof input === 'string') input = rewriteUrl(input);
        else if (input instanceof Request) input = new Request(rewriteUrl(input.url), input);
        return originalFetch.call(this, input, init);
    };
    const originalXHROpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...args) {
        url = rewriteUrl(url);
        return originalXHROpen.call(this, method, url, ...args);
    };
    const originalPushState = history.pushState;
    history.pushState = function(state, title, url) {
        if (url) url = rewriteUrl(url);
        return originalPushState.call(this, state, title, url);
    };
    const originalReplaceState = history.replaceState;
    history.replaceState = function(state, title, url) {
        if (url) url = rewriteUrl(url);
        return originalReplaceState.call(this, state, title, url);
    };
    Object.defineProperty(window, 'top', { get: () => window });
    Object.defineProperty(window, 'parent', { get: () => window });
    Object.defineProperty(window, 'location', { set: url => window.open(url, '_self'), get: () => ({ href: rewriteUrl(document.baseURI) }) });
    Object.defineProperty(document, 'location', { set: url => window.open(url, '_self'), get: () => ({ href: rewriteUrl(document.baseURI) }) });
    const originalOpenWindow = window.open;
    window.open = (url, ...args) => originalOpenWindow.call(window, rewriteUrl(url), ...args);
    const observer = new MutationObserver(mutations => {
        mutations.forEach(m => {
            if (m.type === 'childList') {
                m.addedNodes.forEach(n => {
                    if (n.nodeType === Node.ELEMENT_NODE) {
                        Array.from(n.attributes || []).forEach(attr => {
                            if (attr.name === 'style') n.setAttribute(attr.name, rewriteUrlsInString(attr.value));
                            else n.setAttribute(attr.name, rewriteUrl(attr.value));
                        });
                    }
                });
            } else if (m.type === 'attributes') {
                if (m.attributeName === 'style') 
                    m.target.setAttribute(m.attributeName, rewriteUrlsInString(m.target.getAttribute(m.attributeName)));
                else 
                    m.target.setAttribute(m.attributeName, rewriteUrl(m.target.getAttribute(m.attributeName)));
            }
        });
    });
    const urlRegex = /(?:href|src|url)\\s*[:=(]\\s*(['"]?)(.*?)\\1/gi;
    const rewriteUrlsInString = text => text.replace(urlRegex, (match, quote, url) => match.replace(url, rewriteUrl(url)));
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
})();
</script>
`;

const rewriteUrlHelper = (url, baseUrl) => {
    if (!url || /^(data|javascript|mailto|#)/i.test(url)) return url;
    try {
        return `${PROXY_ROUTE}?url=${encodeURIComponent(new URL(url, baseUrl).href)}`;
    } catch (e) {
        return url;
    }
};

const rewriteContentHelper = (text, baseUrl, contentType) => {
    if (contentType.includes('css')) {
        return text.replace(/(url\(['"]?)([^'")]+?)(['"]?\))/g, (_, prefix, url, suffix) =>
            `${prefix}${rewriteUrlHelper(url, baseUrl)}${suffix}`
        );
    } else if (contentType.includes('javascript')) {
        return text.replace(/(["'])(https?:\/\/[^'"\s]+?)\1/g, (match, quote, url) =>
            `${quote}${rewriteUrlHelper(url, baseUrl)}${quote}`
        );
    } else if (contentType.includes('html')) {
        const $ = cheerio.load(text, { decodeEntities: false });
        $('base').remove();
        $('meta[http-equiv="refresh"]').each((_, el) => {
            const $el = $(el);
            const content = $el.attr('content');
            if (content) {
                const parts = content.split(';');
                const urlPart = parts.find(part => part.trim().toLowerCase().startsWith('url='));
                if (urlPart) {
                    $el.attr('content', content.replace(urlPart.split('=')[1].trim(), rewriteUrlHelper(urlPart.split('=')[1].trim(), baseUrl)));
                }
            }
        });

        const rewriteAttrs = {
            '*': ['style'],
            a: ['href'],
            link: ['href'],
            script: ['src'],
            img: ['src', 'srcset'],
            iframe: ['src'],
            source: ['src', 'srcset'],
            video: ['src', 'poster'],
            audio: ['src'],
            object: ['data'],
            embed: ['src']
        };

        Object.entries(rewriteAttrs).forEach(([tag, attrs]) => {
            $(tag).each((_, el) => {
                const $el = $(el);
                attrs.forEach(attr => {
                    const val = $el.attr(attr);
                    if (!val) return;
                    if (attr === 'srcset') {
                        $el.attr(attr, val.split(',').map(part => {
                            const [url, ...rest] = part.trim().split(/\s+/);
                            return url ? `${rewriteUrlHelper(url, baseUrl)} ${rest.join(' ')}` : part;
                        }).join(','));
                    } else if (attr === 'style') {
                        $el.attr(attr, rewriteContentHelper(val, baseUrl, 'text/css'));
                    } else {
                        $el.attr(attr, rewriteUrlHelper(val, baseUrl));
                    }
                });
            });
        });

        $('form').each((_, el) => {
            const $el = $(el);
            const action = $el.attr('action') || '';
            try {
                const absoluteAction = new URL(action, baseUrl).href;
                $el.attr('action', PROXY_ROUTE);
                $el.append(`<input type="hidden" name="_target" value="${absoluteAction}">`);
            } catch {}
        });

        $('script:not([src])').each((_, el) => {
            const $el = $(el);
            const scriptContent = $el.html();
            if (scriptContent) {
                $el.html(rewriteContentHelper(scriptContent, baseUrl, 'application/javascript'));
            }
        });

        $('*').each((_, el) => {
            Object.keys(el.attribs).forEach(attr => {
                if (attr.startsWith('on')) {
                    const original = $(el).attr(attr);
                    if (original) $(el).attr(attr, rewriteContentHelper(original, baseUrl, 'text/javascript'));
                }
            });
        });

        $('head').prepend(INJECTION_SCRIPT);
        return $.html();
    }
    return text;
};

const getOriginalUrlFromProxyReferer = (referer, proxyRoute) => {
    if (!referer) return null;
    try {
        const urlObj = new URL(referer);
        if (urlObj.pathname === proxyRoute) {
            const urlParam = urlObj.searchParams.get('url');
            if (urlParam) return decodeURIComponent(urlParam);
        }
    } catch {}
    return null;
};

const filterRequestHeaders = (headers) => {
    const newHeaders = { ...headers };
    ['host', 'accept-encoding', 'content-length', 'connection'].forEach(h => delete newHeaders[h]);
    return newHeaders;
};

app.all(PROXY_ROUTE, async (req, res) => {
    const targetUrlParam = req.query.url || req.query._target;
    if (!targetUrlParam) return res.status(400).send('Missing URL');

    let targetUrl = targetUrlParam;
    if (req.query._target) {
        const urlObj = new URL(targetUrl);
        Object.entries(req.query).forEach(([key, value]) => {
            if (key !== '_target') {
                (Array.isArray(value) ? value : [value]).forEach(val => urlObj.searchParams.append(key, val));
            }
        });
        targetUrl = urlObj.href;
    }

    try {
        const headers = filterRequestHeaders(req.headers);
        headers['Host'] = new URL(targetUrl).host;
        headers['Origin'] = new URL(targetUrl).origin;
        const referer = getOriginalUrlFromProxyReferer(req.headers.referer, PROXY_ROUTE);
        if (referer) headers['Referer'] = referer;

        const response = await axios({
            method: req.method,
            url: targetUrl,
            headers,
            data: (req.body && req.method !== 'GET' && req.method !== 'HEAD') ? req.body : undefined,
            responseType: 'stream',
            validateStatus: status => status < 500,
            maxRedirects: 10,
        });

        const { data, status, headers: respHeaders, request } = response;
        const finalUrl = request.res.responseUrl || targetUrl;
        const contentType = respHeaders['content-type']?.toLowerCase() || '';

        res.status(status);
        if (status >= 300 && status < 400 && respHeaders['location']) {
            res.set('Location', rewriteUrlHelper(respHeaders['location'], finalUrl));
        }

        ['content-type', 'cache-control', 'last-modified'].forEach(h => {
            if (respHeaders[h]) res.set(h, respHeaders[h]);
        });

        delete respHeaders['content-security-policy'];
        delete respHeaders['content-security-policy-report-only'];

        if (respHeaders['set-cookie']) {
            res.set('Set-Cookie', [].concat(respHeaders['set-cookie']).map(cookie =>
                cookie.replace(/;\s*(domain=[^;]+|secure|path=[^;]+)/gi, '; Path=/')
            ));
        }

        if (contentType.includes('html') || contentType.includes('css') || contentType.includes('javascript')) {
            const chunks = [];
            for await (const chunk of data) chunks.push(chunk);
            const buffer = Buffer.concat(chunks);
            const charsetMatch = contentType.match(/charset=([\w-]+)/i);
            const charset = charsetMatch ? charsetMatch[1].toLowerCase() : 'utf-8';
            const decoded = iconv.decode(buffer, charset);
            res.send(rewriteContentHelper(decoded, finalUrl, contentType));
        } else {
            await pipeline(data, res);
        }

    } catch (error) {
        console.error('Proxy error:', error.message);
        res.status(error.response?.status || 500).send(`Error: ${error.message}`);
    }
});

app.use(express.static('public'));

const server = http.createServer(app);

const wsServer = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
    try {
        const { pathname, searchParams } = new URL(req.url, `http://${req.headers.host}`);
        if (pathname === PROXY_ROUTE) {
            const targetUrl = searchParams.get('url');
            if (!targetUrl) {
                socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
                socket.destroy();
                return;
            }
            wsServer.handleUpgrade(req, socket, head, (clientWs) => {
                const targetWs = new WebSocket(targetUrl, {
                    headers: {
                        'Origin': new URL(targetUrl).origin,
                        'Referer': req.headers['referer'] || ''
                    }
                });
                targetWs.on('open', () => {
                    clientWs.on('message', msg => targetWs.send(msg));
                    targetWs.on('message', msg => clientWs.send(msg));
                });
                targetWs.on('error', () => clientWs.close());
                clientWs.on('error', () => targetWs.close());
            });
        } else {
            socket.destroy();
        }
    } catch (err) {
        console.error('Upgrade error:', err);
        socket.destroy();
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Proxy running on port ${PORT}`);
});
