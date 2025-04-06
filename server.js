const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');
const { pipeline } = require('stream').promises;

const app = express();
const PORT = process.env.PORT || 80;
const PROXY_ROUTE = '/proxy';
const BASE_URL_HEADER = 'X-Proxied-Base-URL';

const INJECTION_SCRIPT = `
<script>
(() => {
    const proxyUrl = '${PROXY_ROUTE}?url=';
    const urlRegex = /(?:href|src|url)\\s*[:=(]\\s*(['"]?)(.*?)\\\\2/gi;
    const rewriteUrl = url => {
        if (!url || /^(data|javascript|mailto|#)/i.test(url)) return url;
        try {
            return proxyUrl + encodeURIComponent(new URL(url, document.baseURI).href);
        } catch (e) {
            console.error('Proxy: Failed to rewrite URL', url, e);
            return url;
        }
    };
    const rewriteUrlsInString = text => text.replace(urlRegex, (match, prefix, quote, url) => match.replace(url, rewriteUrl(url)));
    Object.defineProperty(window, 'location', { set: url => window.open(url, '_self'), get: () => ({ href: rewriteUrl(originalLocation.href) }) });
    Object.defineProperty(document, 'location', { set: url => window.open(url, '_self'), get: () => ({ href: rewriteUrl(originalDocLocation.href) }) });
    const originalOpenWindow = window.open;
    window.open = (url, ...args) => originalOpenWindow.call(window, rewriteUrl(url), ...args);
    const rewriteAttribute = (el, name, value) => {
        if (name === 'href' || name === 'src' || name === 'data') el.setAttribute(name, rewriteUrl(value));
        else if (name === 'style' && value) el.setAttribute(name, rewriteUrlsInString(value));
    };
    const rewriteElement = (el) => {
        if (el.nodeType === Node.ELEMENT_NODE) {
            for (const attr of el.attributes) rewriteAttribute(el, attr.name, attr.value);
            el.querySelectorAll('*[style]').forEach(styleEl => styleEl.setAttribute('style', rewriteUrlsInString(styleEl.getAttribute('style') || '')));
            if (el.tagName === 'SCRIPT' && !el.getAttribute('src')) el.textContent = rewriteUrlsInString(el.textContent);
        }
    };
    const observer = new MutationObserver(mutationsList => {
        for (const mutation of mutationsList) {
            if (mutation.type === 'childList') mutation.addedNodes.forEach(rewriteElement);
            else if (mutation.type === 'attributes' && mutation.target.nodeType === Node.ELEMENT_NODE) rewriteAttribute(mutation.target, mutation.attributeName, mutation.newValue);
        }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    document.querySelectorAll('script:not([src])').forEach(script => script.textContent = rewriteUrlsInString(script.textContent));
})();
</script>
`;

const rewriteUrlHelper = (url, baseUrl) => {
    if (!url || /^(data|javascript|mailto|#)/i.test(url)) return url;
    try {
        return `${PROXY_ROUTE}?url=${encodeURIComponent(new URL(url, baseUrl).href)}`;
    } catch (e) {
        console.error('Error rewriting URL:', url, e);
        return url;
    }
};

const rewriteContentHelper = (text, baseUrl, contentType) => {
    if (contentType.includes('css')) {
        return text.replace(/(url\(['"]?)([^'")]+?)(['"]?\)|@import\s+['"])/g, (_, prefix, url, suffix) => `${prefix}${rewriteUrlHelper(url, baseUrl)}${suffix}`);
    } else if (contentType.includes('javascript')) {
        return text.replace(/(["'])(https?:\/\/[^'"\s]+?)\1/g, (match, quote, url) => `${quote}${rewriteUrlHelper(url, baseUrl)}${quote}`);
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
                    const url = urlPart.split('=')[1].trim();
                    $el.attr('content', content.replace(url, rewriteUrlHelper(url, baseUrl)));
                }
            }
        });
        const rewriteAttrs = { '*': ['style'], a: ['href'], link: ['href'], script: ['src'], img: ['src', 'srcset'], iframe: ['src'], source: ['src', 'srcset'], video: ['src', 'poster'], audio: ['src'], object: ['data'], embed: ['src'] };
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
            } catch (e) {
                console.error('Error rewriting form action:', action, e);
            }
        });
        $('style').each((_, el) => $(el).html(rewriteContentHelper($(el).html(), baseUrl, 'text/css')));
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

app.get(PROXY_ROUTE, async (req, res) => {
    const targetUrlParam = req.query.url || req.query._target;
    if (!targetUrlParam) return res.status(400).send('Error: Missing "url" or "_target" parameter');

    let targetUrl = targetUrlParam;
    if (req.query._target) {
        const urlObj = new URL(targetUrl);
        Object.entries(req.query).forEach(([key, value]) => {
            if (key !== '_target') (Array.isArray(value) ? value : [value]).forEach(val => urlObj.searchParams.append(key, val));
        });
        targetUrl = urlObj.href;
    }

    try {
        const response = await axios.get(targetUrl, {
            responseType: 'stream',
            headers: { 'User-Agent': req.get('User-Agent') || 'Node.js Proxy' },
            validateStatus: status => status < 500,
            maxRedirects: 10,
        });
        const { data, status, headers, request } = response;
        const finalUrl = request.res.responseUrl || targetUrl;
        const contentType = headers['content-type']?.toLowerCase() || '';

        res.status(status);
        ['content-type', 'cache-control', 'last-modified'].forEach(header => headers[header] && res.set(header, headers[header]));
        if (headers['set-cookie']) res.set('Set-Cookie', [].concat(headers['set-cookie']).map(cookie => cookie.replace(/;\s*(domain=[^;]+|secure|path=[^;]+)/gi, '; Path=/')));

        if (contentType.includes('html') || contentType.includes('css') || contentType.includes('javascript')) {
            const chunks = [];
            for await (const chunk of data) chunks.push(chunk);
            res.send(rewriteContentHelper(Buffer.concat(chunks).toString('utf-8'), finalUrl, contentType));
        } else {
            await pipeline(data, res);
        }
    } catch (error) {
        const status = error.response?.status || 500;
        const message = error.response ? `${status} ${error.response.statusText}` : error.message;
        console.error('Proxy error:', message);
        res.status(status).send(`Error: ${message}`);
    }
});

app.use(async (req, res, next) => {
    const referer = req.headers.referer;
    if (!req.path.startsWith(PROXY_ROUTE) && referer?.startsWith(req.protocol + '://' + req.get('host') + PROXY_ROUTE + '?url=')) {
        try {
            const proxiedBaseUrl = new URL(decodeURIComponent(referer.substring(referer.indexOf('url=') + 4)));
            const targetUrl = new URL(req.path, proxiedBaseUrl.origin).href;

            const response = await axios.get(targetUrl, {
                responseType: 'stream',
                headers: { 'User-Agent': req.get('User-Agent') || 'Node.js Proxy' },
                validateStatus: status => status < 500,
                maxRedirects: 10,
            });
            const { data, status, headers, request } = response;
            const finalUrl = request.res.responseUrl || targetUrl;
            const contentType = headers['content-type']?.toLowerCase() || '';

            res.status(status);
            ['content-type', 'cache-control', 'last-modified'].forEach(header => headers[header] && res.set(header, headers[header]));
            if (headers['set-cookie']) res.set('Set-Cookie', [].concat(headers['set-cookie']).map(cookie => cookie.replace(/;\s*(domain=[^;]+|secure|path=[^;]+)/gi, '; Path=/')));

            if (contentType.includes('html') || contentType.includes('css') || contentType.includes('javascript')) {
                const chunks = [];
                for await (const chunk of data) chunks.push(chunk);
                res.send(rewriteContentHelper(Buffer.concat(chunks).toString('utf-8'), finalUrl, contentType));
            } else {
                await pipeline(data, res);
            }
        } catch (error) {
            const status = error.response?.status || 500;
            const message = error.response ? `${status} ${error.response.statusText}` : error.message;
            console.error('Proxy error (relative):', message);
            res.status(status).send(`Error: ${message}`);
        }
    } else {
        next();
    }
});

app.use(express.static('public'));

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Proxy running on port ${PORT}`);
});
