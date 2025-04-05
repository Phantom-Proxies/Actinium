const tabsContainer = document.getElementById('tabs-container');
const addTabButton = document.getElementById('add-tab');
const addressBar = document.getElementById('address-bar');
const contentArea = document.getElementById('content-area');
const popoutButton = document.getElementById(
    'popout-button');

let tabs = {};
let activeTabId = null;
let tabCounter = 0;

function createWelcomeScreen(contentId) {
    const welcomeDiv = document.createElement('div');
    welcomeDiv.id = contentId;
    welcomeDiv.className = 'welcome-screen';
    welcomeDiv.innerHTML = `
        <h1 class="title">
            <svg class="icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="2" />
                <path d="M 14 12 L 22 12 A 10 10 0 0 1 17 20.66 L 13 13.73" />
                <path d="M 14 12 L 22 12 A 10 10 0 0 1 17 20.66 L 13 13.73" transform="rotate(120 12 12)" />
                <path d="M 14 12 L 22 12 A 10 10 0 0 1 17 20.66 L 13 13.73" transform="rotate(240 12 12)" />
            </svg>
            Welcome to <span style="color: var(--accent2-color);">Actinium</span>
        </h1>
        <div class="search-container">
            <input type="text" class="search-bar-welcome" placeholder="Enter a search query or URL">
            <p class="message">Actinium is completely stand-alone...</p>
        </div>
    `;
    contentArea.appendChild(welcomeDiv);
    startMessageCycling(welcomeDiv.querySelector('.message'));
    return welcomeDiv;
}

function createIframeContainer(contentId) {
    const iframeContainer = document.createElement('div');
    iframeContainer.id = contentId;
    iframeContainer.className = 'iframe-container';
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox',
        'allow-forms allow-modals allow-pointer-lock allow-popups allow-presentation allow-same-origin allow-scripts allow-top-navigation'
    );
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframeContainer.appendChild(iframe);
    contentArea.appendChild(iframeContainer);

    // Add load listener to update URL and title after navigation within the iframe
    iframe.onload = () => {
        let proxiedURL = iframe.contentWindow.location.href;
        let originalURL = extractOriginalURL(proxiedURL);
        if (!originalURL) {
            originalURL = proxiedURL; // Fallback to proxied URL if extraction fails.
        }

        let loadedTitle = 'Page Loaded';

        try {
            if (iframe.contentWindow?.document?.title) {
                loadedTitle = iframe.contentWindow.document.title || 'Page Loaded';
            }
        } catch (err) {
            console.warn("Could not access iframe title (cross-origin) for:",
                originalURL);
        }

        updateTabDetails(activeTabId, originalURL, loadedTitle);
        console.log(`Iframe navigated to: ${originalURL} (via proxy: ${proxiedURL})`);
    };
    return iframeContainer;
}

// Helper function to extract the original URL from the proxy URL
function extractOriginalURL(proxyURL) {
    try {
        const url = new URL(proxyURL);
        if (url.pathname === '/proxy') {
            const params = new URLSearchParams(url.search);
            const originalUrl = params.get('url');
            return originalUrl;
        }
        return null; // Not a proxy URL
    } catch (e) {
        console.error("Error parsing URL:", proxyURL, e);
        return null;
    }
}

function loadInActiveTab(input) {
    if (!activeTabId || !input) return;

    const currentTabData = tabs[activeTabId];
    const currentContentId = currentTabData.contentId;
    let targetUrl = '';
    let destinationUrl = '';
    const urlPattern =
        /^(https?:\/\/)?([a-z0-9-]+\.|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost)(:[0-9]+)?([\/\?#].*)?$/i;

    if (input.toLowerCase().endsWith('.onion')) {
        addressBar.value = '';
        addressBar.placeholder = ".onion addresses not supported yet.";
        setTimeout(() => {
            if (activeTabId === currentTabData?.id) {
                addressBar.placeholder = tabs[activeTabId]?.isWelcome ?
                    "Enter search query or URL" : (tabs[activeTabId]?.url ||
                        "Enter search query or URL");
            }
        }, 2000);
        const welcomeSearch = document.getElementById(currentContentId)
            ?.querySelector('.search-bar-welcome');
        if (welcomeSearch) welcomeSearch.value = '';
        return;
    }

    if (urlPattern.test(input) || input.includes('.') || input.includes(
            ':') || input.startsWith('localhost')) {
        destinationUrl = input;
        if (!/^https?:\/\//i.test(input) && !
            /^(localhost|\d{1,3}(\.\d{1,3}){3})/.test(input)) {
            destinationUrl = 'https://' + input;
        } else if (!/^https?:\/\//i.test(input)) {
            destinationUrl = 'http://' + input;
        }
    } else {
        const encodedQuery = encodeURIComponent(input);
        destinationUrl = `https://www.mojeek.com/search?q=${encodedQuery}`;
    }
    const proxyBaseUrl = window.location.origin;
    targetUrl =
        `${proxyBaseUrl}/proxy?url=${encodeURIComponent(destinationUrl)}`;
    console.log(
        `Loading via Proxy: ${targetUrl} (Original: ${destinationUrl})`);
    const welcomeScreen = document.getElementById(currentContentId);
    let iframeContainer = currentTabData.iframeContainer;

    if (!iframeContainer) {
        iframeContainer = createIframeContainer(currentContentId);
        currentTabData.iframeContainer = iframeContainer;
        if (welcomeScreen && welcomeScreen.parentNode === contentArea)
            welcomeScreen.remove();
    } else {
        if (welcomeScreen && welcomeScreen.classList.contains('visible'))
            welcomeScreen.classList.remove('visible');
    }
    if (welcomeScreen && welcomeScreen.parentNode === contentArea)
        welcomeScreen.classList.remove('visible');
    iframeContainer.classList.add('visible');
    const iframe = iframeContainer.querySelector('iframe');
    updateTabDetails(activeTabId, destinationUrl, 'Loading...');
    addressBar.value = destinationUrl;
    iframe.src = targetUrl;

    iframe.onerror = (error) => {
        console.error("Iframe failed to load:", destinationUrl, error);
        const failedUrl = destinationUrl;
        updateTabDetails(activeTabId, null,
            "Error Loading Page");
        iframeContainer.innerHTML = `<div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; padding: 20px; text-align: center;">
                                        <p style="color: var(--accent2-color); font-size: 1.2em; margin-bottom: 1em;">Failed to load page</p>
                                        <p style="color: var(--placeholder-color);">${failedUrl}</p>
                                    </div>`;
    };
}


// --- Tab Management ---
function addTab(makeActive = true) {
    /* ... same logic ... */
    tabCounter++;
    const tabId = `tab-${tabCounter}`;
    const contentId = `content-${tabCounter}`;
    const isFirstTab = Object.keys(tabs).length === 0;

    const tabElement = document.createElement('div');
    tabElement.className = 'tab';
    tabElement.id = tabId;
    tabElement.dataset.contentId = contentId;
    tabElement.innerHTML = `
        <span class="tab-title">New Tab</span>
        <button class="tab-close" title="Close Tab">×</button>
    `;
    tabsContainer.insertBefore(tabElement, addTabButton);

    createWelcomeScreen(contentId);

    tabs[tabId] = {
        element: tabElement,
        contentId: contentId,
        url: null,
        title: 'New Tab',
        isWelcome: true,
        iframeContainer: null
    };

    if (makeActive || isFirstTab) {
        switchTab(tabId);
    }
    tabElement.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'nearest'
    });
}

function switchTab(tabId) {
    if (!tabs[tabId] || tabId === activeTabId) return;
    if (activeTabId && tabs[activeTabId]) {
        tabs[activeTabId].element.classList.remove('active');
        const currentContent = document.getElementById(tabs[activeTabId]
            .contentId);
        if (currentContent) currentContent.classList.remove('visible');
        if (tabs[activeTabId].iframeContainer) tabs[activeTabId]
            .iframeContainer.classList.remove('visible');
    }
    activeTabId = tabId;
    const newTabData = tabs[tabId];
    newTabData.element.classList.add('active');
    const contentToShow = newTabData.iframeContainer && !newTabData
        .isWelcome ?
        newTabData.iframeContainer :
        document.getElementById(newTabData.contentId);

    if (contentToShow) {
        contentToShow.classList.add('visible');
    } else {
        console.error("Content container not found for tab:", tabId);
        if (!newTabData.iframeContainer && !newTabData.isWelcome) {
            console.warn(
                "Tab state inconsistent. Reverting to welcome screen for", tabId
            );
            newTabData.isWelcome = true;
            createWelcomeScreen(newTabData.contentId).classList.add('visible');
        } else if (newTabData.isWelcome) {
            createWelcomeScreen(newTabData.contentId).classList.add('visible');
        }
    }
    addressBar.value = newTabData.url || '';
    addressBar.placeholder = newTabData.isWelcome ?
        "Enter search query or URL" : (newTabData.url ||
            "Enter search query or URL");

    updatePopoutButtonState();
}

function closeTab(tabId) {
    const tabData = tabs[tabId];
    if (!tabData) return;

    tabData.element.remove();
    const welcomeElement = document.getElementById(tabData.contentId);
    if (welcomeElement) welcomeElement.remove();
    if (tabData.iframeContainer) tabData.iframeContainer.remove();

    delete tabs[tabId];

    if (activeTabId === tabId) {
        activeTabId = null;
        const remainingTabIds = Object.keys(tabs);
        if (remainingTabIds.length > 0) {
            const lastTabElement = addTabButton.previousElementSibling;
            if (lastTabElement?.classList.contains(
                    'tab')) {
                switchTab(lastTabElement.id);
            } else {
                addTab(true);
            }
        } else {
            addTab(true);
        }
    }
    if (Object.keys(tabs).length === 0) {
        addTab(true);
    }
}

function updateTabDetails(tabId, url, title) {
    const tabData = tabs[tabId];
    if (!tabData) return;
    tabData.url = url;
    tabData.isWelcome = !url;

    let displayTitle = title || 'Untitled';
    if (url && (url.startsWith('http:') || url.startsWith('https:'))) {
        try {
            displayTitle = new URL(url).hostname.replace(/^www\./, '') ||
                displayTitle;
        } catch (e) {}
    } else if (!url && title === 'Loading...') {
        displayTitle = title;
    } else if (!url && title !== 'New Tab') {
        displayTitle = title;
    } else {
        displayTitle = title;
    }
    const maxTitleLength = 25;
    if (displayTitle.length > maxTitleLength) {
        displayTitle = displayTitle.substring(0, maxTitleLength - 3) + '...';
    }

    tabData.title = displayTitle;
    tabData.element.querySelector('.tab-title').textContent = displayTitle;
    tabData.element.title = title;
    if (activeTabId === tabId) {
        addressBar.value = url || '';
        addressBar.placeholder = url || "Enter search query or URL";
        updatePopoutButtonState();
    }
}

function updatePopoutButtonState() {
    if (activeTabId && tabs[activeTabId] && tabs[activeTabId].url) {
        popoutButton.disabled = false;
    } else {
        popoutButton.disabled = true;
    }
}
tabsContainer.addEventListener('click', (e) => {
    const tabTarget = e.target.closest('.tab');
    const closeButton = e.target.closest('.tab-close');
    const addButtonTarget = e.target.closest('.add-tab-button');
    if (closeButton && tabTarget) {
        e.stopPropagation();
        closeTab(tabTarget.id);
    } else if (tabTarget) {
        switchTab(tabTarget.id);
    } else if (addButtonTarget) {
        addTab(true);
    }
});
addressBar.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        loadInActiveTab(addressBar.value.trim());
    }
});
contentArea.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && e.target.classList.contains(
            'search-bar-welcome')) {
        const welcomeSearchInput = e.target;
        const searchTerm = welcomeSearchInput.value.trim();
        if (searchTerm) {
            const parentWelcomeScreen = welcomeSearchInput.closest(
                '.welcome-screen');
            const screenId = parentWelcomeScreen?.id;
            if (screenId && tabs[activeTabId]?.contentId === screenId) {
                loadInActiveTab(searchTerm);
            }
        }
    }
});
popoutButton.addEventListener('click', () => {
    if (activeTabId && tabs[activeTabId] && tabs[activeTabId].url) {
        const originalUrl = tabs[activeTabId].url;
        window.open(originalUrl, '_blank');
    }
});
const baseMessages = [
    "Actinium is one of the only proxies to not rely upon Ultraviolet or others.",
    "Actinium supports routing traffic through TOR nodes (the dark web)!",
    "Actinium encrypts all internet traffic, ensuring that you stay undetected and secure.",
    "Actinium is highly optimized, sometimes faster than if you didn't use a proxy!",
    "Actinium provides advanced emulators, allowing you to play console games!"
];
let messageIntervals = {};

function startMessageCycling(msgElement) {
    if (!msgElement) return;
    let currentIndex = 0;
    const transitionDuration = 250,
        cycleInterval = 6000;
    const parentWelcomeScreen = msgElement.closest('.welcome-screen');
    const elementId = parentWelcomeScreen?.id;
    if (!elementId) return;

    function cycle() {
        const currentWelcomeScreen = document.getElementById(
            elementId);
        if (!currentWelcomeScreen || !currentWelcomeScreen
            .contains(msgElement)) {
            if (messageIntervals[elementId]) {
                clearInterval(messageIntervals[elementId]);
                delete messageIntervals[elementId];
            }
            return;
        }
        msgElement.classList.add('fade-out');
        setTimeout(() => {
            const stillExistsWelcomeScreen = document.getElementById(
                elementId);
            if (!stillExistsWelcomeScreen || !stillExistsWelcomeScreen
                .contains(msgElement)) {
                if (messageIntervals[elementId]) {
                    clearInterval(messageIntervals[elementId]);
                    delete messageIntervals[elementId];
                }
                return;
            }
            currentIndex = (currentIndex + 1) % baseMessages.length;
            msgElement.textContent = baseMessages[currentIndex];
            msgElement.classList.remove('fade-out');
        }, transitionDuration);
    }
    if (messageIntervals[elementId]) {
        clearInterval(messageIntervals[elementId]);
    }
    messageIntervals[elementId] = setInterval(cycle, cycleInterval);
    msgElement.textContent = baseMessages[currentIndex];
}
addTab(true);
updatePopoutButtonState();
