const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');
const { pipeline } = require('stream').promises;

const app = express();
const PORT = process.env.PORT || 80;
const PROXY_ROUTE = '/proxy';

app.use(express.static('public'));

// Script to inject into HTML for handling JavaScript-based redirections
const INJECTION_SCRIPT = `
<script>
(function() {
    const proxyUrl = '${PROXY_ROUTE}?url=';

    function rewriteUrl(url) {
        try {
            return proxyUrl + encodeURIComponent(new URL(url, document.baseURI).href);
        } catch (e) {
            console.error('Proxy: Failed to rewrite URL', url, e);
            return url;
        }
    }

    const originalLocation = window.location;
    Object.defineProperty(window, 'location', {
        set: function(url) {
            originalLocation.href = rewriteUrl(url);
        },
        get: function() {
            return originalLocation;
        }
    });

    const originalDocLocation = document.location;
    Object.defineProperty(document, 'location', {
        set: function(url) {
            originalDocLocation.href = rewriteUrl(url);
        },
        get: function() {
            return originalDocLocation;
        }
    });

    const originalOpen = window.open;
    window.open = function(url, ...args) {
        const newUrl = rewriteUrl(url);
        return originalOpen.call(window, newUrl, ...args);
    };
})();
</script>
`;

// Function to rewrite URLs to go through the proxy
const rewriteUrl = (url, baseUrl) => {
    if (!url || /^(data|javascript|mailto|#)/i.test(url)) return url;
    try {
        return `${PROXY_ROUTE}?url=${encodeURIComponent(new URL(url, baseUrl).href)}`;
    } catch (e) {
        console.error('Error rewriting URL:', url, e);
        return url;
    }
};

// Function to rewrite HTML and CSS content
const rewriteContent = (text, baseUrl, isCss = false) => {
    if (isCss) {
        // Rewrite URLs in CSS
        return text.replace(/(url\(['"]?)([^'")]+?)(['"]?\)|@import\s+['"])/g, 
            (_, prefix, url, suffix) => `${prefix}${rewriteUrl(url, baseUrl)}${suffix}`);
    }

    // Parse HTML with Cheerio
    const $ = cheerio.load(text, { decodeEntities: false });
    $('base').remove(); // Remove base tags to avoid conflicts

    // Rewrite meta refresh tags
    $('meta[http-equiv="refresh"]').each((_, el) => {
        const $el = $(el);
        const content = $el.attr('content');
        if (content) {
            const parts = content.split(';');
            const urlPart = parts.find(part => part.trim().toLowerCase().startsWith('url='));
            if (urlPart) {
                const url = urlPart.split('=')[1].trim();
                const newUrl = rewriteUrl(url, baseUrl);
                $el.attr('content', content.replace(url, newUrl));
            }
        }
    });

    // Attributes to rewrite per tag
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
        embed: ['src'],
    };

    // Rewrite attributes in HTML
    Object.entries(rewriteAttrs).forEach(([tag, attrs]) => {
        $(tag).each((_, el) => {
            const $el = $(el);
            attrs.forEach(attr => {
                const val = $el.attr(attr);
                if (!val) return;

                if (attr === 'srcset') {
                    $el.attr(attr, val.split(',').map(part => {
                        const [url, ...rest] = part.trim().split(/\s+/);
                        return url ? `${rewriteUrl(url, baseUrl)} ${rest.join(' ')}` : part;
                    }).join(','));
                } else if (attr === 'style') {
                    $el.attr(attr, rewriteContent(val, baseUrl, true));
                } else {
                    $el.attr(attr, rewriteUrl(val, baseUrl));
                }
            });
        });
    });

    // Rewrite form actions
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

    // Rewrite CSS in <style> tags
    $('style').each((_, el) => {
        const $el = $(el);
        $el.html(rewriteContent($el.html(), baseUrl, true));
    });

    // Inject script to handle JavaScript redirections
    $('head').prepend(INJECTION_SCRIPT);

    return $.html();
};

// Proxy route handler
app.get(PROXY_ROUTE, async (req, res) => {
    let targetUrl;

    // Handle form submissions or direct URL requests
    if (req.query._target) {
        targetUrl = req.query._target;
        const urlObj = new URL(targetUrl);
        Object.entries(req.query).forEach(([key, value]) => {
            if (key !== '_target') {
                if (Array.isArray(value)) {
                    value.forEach(val => urlObj.searchParams.append(key, val));
                } else {
                    urlObj.searchParams.append(key, value);
                }
            }
        });
        targetUrl = urlObj.href;
    } else if (req.query.url) {
        targetUrl = req.query.url;
    } else {
        return res.status(400).send('Error: Missing "url" or "_target" parameter');
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

        // Set response headers
        res.status(status);
        ['content-type', 'cache-control', 'last-modified'].forEach(header => {
            if (headers[header]) res.set(header, headers[header]);
        });

        // Rewrite cookies to work with the proxy
        if (headers['set-cookie']) {
            res.set('Set-Cookie', [].concat(headers['set-cookie']).map(cookie =>
                cookie.replace(/;\s*(domain=[^;]+|secure|path=[^;]+)/gi, '; Path=/')));
        }

        // Process HTML or CSS content
        const isHtml = contentType.includes('html');
        const isCss = contentType.includes('css');

        if (isHtml || isCss) {
            const chunks = [];
            for await (const chunk of data) chunks.push(chunk);
            const content = Buffer.concat(chunks).toString('utf-8');
            res.send(rewriteContent(content, finalUrl, isCss));
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

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Proxy running on port ${PORT}`);
});