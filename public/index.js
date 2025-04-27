"use strict";

const form = document.getElementById("uv-form"),
      address = document.getElementById("uv-address"),
      searchEngine = document.getElementById("uv-search-engine"),
      error = document.getElementById("uv-error"),
      errorCode = document.getElementById("uv-error-code"),
      input = document.querySelector("input");

class crypts {
    static encode(str) {
        return encodeURIComponent([...str].map((c, i) => i % 2 ? String.fromCharCode(c.charCodeAt() ^ 2) : c).join(""));
    }
    static decode(str) {
        if (str.endsWith("/")) str = str.slice(0, -1);
        return decodeURIComponent([...str].map((c, i) => i % 2 ? String.fromCharCode(c.charCodeAt() ^ 2) : c).join(""));
    }
}

const search = (input) => {
    input = input.trim();
    let searchUrl = `https://www.duckduckgo.com/search?q=${encodeURIComponent(input)}`;
    try {
        return new URL(input).toString();
    } catch {
        try {
            let url = new URL(`http://${input}`);
            if (url.hostname.includes(".")) return url.toString();
        } catch {}
    }
    return searchUrl;
};

if ("serviceWorker" in navigator) {
    let proxy = { file: "/@/sw.js", config: __uv$config };
    navigator.serviceWorker.register(proxy.file, { scope: proxy.config.prefix })
        .then(reg => {
            console.log("ServiceWorker registered:", reg.scope);
            form.addEventListener("submit", event => {
                event.preventDefault();
                location.href = proxy.config.prefix + crypts.encode(search(address.value));
            });
        })
        .catch(err => console.error("ServiceWorker registration failed:", err));
}

document.addEventListener("click", event => {
    let target = event.target.closest(".proxy-link, img");
    if (!target) return;

    event.preventDefault();
    let url = target.getAttribute("data-url") || target.src;
    if (url) {
        let proxiedUrl = __uv$config.prefix + crypts.encode(url);
        window.location.href = proxiedUrl;
    }
});

console.log(proxy.config.prefix);

