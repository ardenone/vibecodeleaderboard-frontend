// Shared browser configuration for all API clients.
(function (global) {
    'use strict';

    const localHostnames = new Set(['localhost', '127.0.0.1', '[::1]']);
    const hostname = global.location.hostname;
    const apiBaseUrl = localHostnames.has(hostname)
        ? 'http://localhost:8080'
        : `https://api.${hostname.replace(/^www\./, '')}`;

    Object.defineProperty(global, 'VibeCodeConfig', {
        configurable: false,
        enumerable: true,
        value: Object.freeze({ apiBaseUrl }),
        writable: false
    });
})(window);
