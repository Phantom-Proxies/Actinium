const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');
const { pipeline } = require('stream').promises;

const app = express();
const PORT = process.env.PORT || 6969;
const PROXY_ROUTE = '/proxy';

app.use(express.static('public'));

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
    const originalLocation = window.location;
    Object.defineProperty(window, 'location', { set: url => originalLocation.href = rewriteUrl(url), get: () => originalLocation });
    const originalDocLocation = document.location;
    Object.defineProperty(document, 'location', { set: url => originalDocLocation.href = rewriteUrl(url), get: () => originalDocLocation });
    const originalOpenWindow = window.open;
    window.open = (url, ...args) => originalOpenWindow.call(window, rewriteUrl(url), ...args);
    const originalSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function(name, value) {
        if (name === 'href' || name === 'src' || name === 'data') value = rewriteUrl(value);
        else if (name === 'style' && value) value = rewriteUrlsInString(value);
        originalSetAttribute.call(this, name, value);
    };
    const originalSetProperty = CSSStyleDeclaration.prototype.setProperty;
    CSSStyleDeclaration.prototype.setProperty = function(property, value, priority) {
        if (value && property.toLowerCase().includes('url')) {
            const urlMatch = value.match(/url\\(['"]?([^'"]*)['"]?\\)/i);
            if (urlMatch && urlMatch[1]) value = \`url('\${rewriteUrl(urlMatch[1])}')\`;
        }
        originalSetProperty.call(this, property, value, priority);
    };
    document.querySelectorAll('script:not([src])').forEach(script => script.textContent = rewriteUrlsInString(script.textContent));
    const observer = new MutationObserver(mutationsList => {
        for (const mutation of mutationsList) {
            if (mutation.type === 'childList') {
                mutation.addedNodes.forEach(node => {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        for (const attr of node.attributes) {
                            if (attr.name === 'href' || attr.name === 'src' || attr.name === 'data') node.setAttribute(attr.name, rewriteUrl(attr.value));
                            else if (attr.name === 'style' && attr.value) node.setAttribute(attr.name, rewriteUrlsInString(attr.value));
                        }
                        node.querySelectorAll('*[style]').forEach(el => el.setAttribute('style', rewriteUrlsInString(el.getAttribute('style') || '')));
                        if (node.tagName === 'SCRIPT' && !node.getAttribute('src')) node.textContent = rewriteUrlsInString(node.textContent);
                    }
                });
            } else if (mutation.type === 'attributes' && mutation.target.nodeType === Node.ELEMENT_NODE) {
                const { target, attributeName, newValue } = mutation;
                if (attributeName === 'href' || attributeName === 'src' || attributeName === 'data') target.setAttribute(attributeName, rewriteUrl(newValue));
                else if (attributeName === 'style' && newValue) target.setAttribute(attributeName, rewriteUrlsInString(newValue));
            }
        }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
})();
</script>
`;

const rewriteUrl = (url, baseUrl) => {
    if (!url || /^(data|javascript|mailto|#)/i.test(url)) return url;
    try {
        return `${PROXY_ROUTE}?url=${encodeURIComponent(new URL(url, baseUrl).href)}`;
    } catch (e) {
        console.error('Error rewriting URL:', url, e);
        return url;
    }
};

const rewriteContent = (text, baseUrl, contentType) => {
    if (contentType.includes('css')) {
        return text.replace(/(url\(['"]?)([^'")]+?)(['"]?\)|@import\s+['"])/g, (_, prefix, url, suffix) => `${prefix}${rewriteUrl(url, baseUrl)}${suffix}`);
    } else if (contentType.includes('javascript')) {
        const urlRegex = /(["'])(https?:\/\/[^'"\s]+?)\1/g;
        return text.replace(urlRegex, (match, quote, url) => `${quote}${rewriteUrl(url, baseUrl)}${quote}`);
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
                    $el.attr('content', content.replace(url, rewriteUrl(url, baseUrl)));
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
                    if (attr === 'srcset') $el.attr(attr, val.split(',').map(part => {
                        const [url, ...rest] = part.trim().split(/\s+/);
                        return url ? `${rewriteUrl(url, baseUrl)} ${rest.join(' ')}` : part;
                    }).join(','));
                    else if (attr === 'style') $el.attr(attr, rewriteContent(val, baseUrl, 'text/css'));
                    else $el.attr(attr, rewriteUrl(val, baseUrl));
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
        $('style').each((_, el) => $(el).html(rewriteContent($(el).html(), baseUrl, 'text/css')));
        $('head').prepend(INJECTION_SCRIPT);
        return $.html();
    }
    return text;
};

app.get(PROXY_ROUTE, async (req, res) => {
    let targetUrl;
    if (req.query.url) targetUrl = req.query.url;
    else if (req.query._target) {
        targetUrl = req.query._target;
        const urlObj = new URL(targetUrl);
        Object.entries(req.query).forEach(([key, value]) => {
            if (key !== '_target') {
                if (Array.isArray(value)) value.forEach(val => urlObj.searchParams.append(key, val));
                else urlObj.searchParams.append(key, value);
            }
        });
        targetUrl = urlObj.href;
    } else return res.status(400).send('Error: Missing "url" or "_target" parameter');

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
        ['content-type', 'cache-control', 'last-modified'].forEach(header => { if (headers[header]) res.set(header, headers[header]); });
        if (headers['set-cookie']) res.set('Set-Cookie', [].concat(headers['set-cookie']).map(cookie => cookie.replace(/;\s*(domain=[^;]+|secure|path=[^;]+)/gi, '; Path=/')));
        if (contentType.includes('html') || contentType.includes('css') || contentType.includes('javascript')) {
            const chunks = [];
            for await (const chunk of data) chunks.push(chunk);
            res.send(rewriteContent(Buffer.concat(chunks).toString('utf-8'), finalUrl, contentType));
        } else await pipeline(data, res);
    } catch (error) {
        const status = error.response?.status || 500;
        const message = error.response ? `${status} ${error.response.statusText}` : error.message;
        console.error('Proxy error:', message);
        res.status(status).send(`Error: ${message}`);
    }
});

app.use(async (req, res, next) => {
    const referer = req.headers.referer;
    const isProxyRequest = req.path.startsWith(PROXY_ROUTE);

    if (!isProxyRequest && referer && referer.startsWith(req.protocol + '://' + req.get('host') + PROXY_ROUTE + '?url=')) {
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
            ['content-type', 'cache-control', 'last-modified'].forEach(header => { if (headers[header]) res.set(header, headers[header]); });
            if (headers['set-cookie']) res.set('Set-Cookie', [].concat(headers['set-cookie']).map(cookie => cookie.replace(/;\s*(domain=[^;]+|secure|path=[^;]+)/gi, '; Path=/')));
            if (contentType.includes('html') || contentType.includes('css') || contentType.includes('javascript')) {
                const chunks = [];
                for await (const chunk of data) chunks.push(chunk);
                res.send(rewriteContent(Buffer.concat(chunks).toString('utf-8'), finalUrl, contentType));
            } else await pipeline(data, res);
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
