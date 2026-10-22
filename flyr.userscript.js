// ==UserScript==
// @name         Flyr
// @namespace    https://github.com/thomfre/flyr
// @version      0.8
// @description  Make yr.no beautiful for pilots
// @icon         https://raw.githubusercontent.com/thomfre/flyr/main/logo.png
// @author       thomfre
// @match        https://www.yr.no/*
// @match        https://yr.no/*
// @grant        GM_getResourceText
// @grant        unsafeWindow
// @run-at       document-idle
// @noframes
// @require      https://raw.githubusercontent.com/mourner/suncalc/v1.9.0/suncalc.js
// @resource     airports https://raw.githubusercontent.com/thomfre/flyr/main/airports.json
// @downloadURL  https://raw.githubusercontent.com/thomfre/flyr/main/flyr.userscript.js
// @updateURL    https://raw.githubusercontent.com/thomfre/flyr/main/flyr.userscript.meta.js
// ==/UserScript==

(function () {
    'use strict';

    // Set to true to get diagnostic output in the browser console.
    const DEBUG = false;

    // A yr.no location within this distance of an airport counts as that airport.
    const MATCH_RADIUS_KM = 1.5;

    // Built-in airport data, so the script works even if airports.json can't be loaded.
    // Entries in airports.json (the @resource) override these per ICAO code.
    const BUILTIN_AIRPORTS = [
        { airport: 'ENBL', location: 'Førde lufthamn, Bringeland', variation: -0.4, runways: [7, 25], lat: 61.3917, lon: 5.7636 },
        { airport: 'ENBR', location: 'Bergen lufthavn, Flesland', variation: -0.5, runways: [17, 35], lat: 60.2936, lon: 5.2181 },
        { airport: 'ENCN', location: 'Kristiansand lufthavn, Kjevik', variation: -2.6, runways: [3, 21], lat: 58.2042, lon: 8.0853 },
        { airport: 'ENFL', location: 'Florø lufthamn', variation: 0, runways: [7, 25], lat: 61.5836, lon: 5.0247 },
        { airport: 'ENHD', location: 'Haugesund lufthavn, Karmøy', variation: -1, runways: [13, 31], lat: 59.3453, lon: 5.2084 },
        { airport: 'ENSG', location: 'Sogndal lufthamn, Haukåsen', variation: -1.1, runways: [6, 24], lat: 61.1561, lon: 7.1378 },
        { airport: 'ENSO', location: 'Stord lufthavn', variation: -2, runways: [14, 32], lat: 59.7919, lon: 5.3408 },
        { airport: 'ENZV', location: 'Stavanger lufthavn, Sola', variation: -1, runways: [18, 36, 11, 29], lat: 58.8767, lon: 5.6378 },
    ];

    const SEL = {
        windValue: '.wind__value',
        windGust: '.wind__gust',
        windUnit: '.wind__unit',
        windRoot: '.wind',
        windContainer: '.wind__container',
        windDescription: '.wind-description',
    };

    const TO_KT = { ms: 1.943844, kmh: 0.539957, mph: 0.868976, kt: 1 };

    const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    const log = (...args) => DEBUG && console.log('[Flyr]', ...args);
    const warn = (...args) => console.warn('[Flyr]', ...args);

    // ---------------------------------------------------------------- airport data

    const normalizeName = (s) =>
        (s || '')
            .normalize('NFC')
            .toLowerCase()
            .replace(/\blufthamn\b/g, 'lufthavn')
            .replace(/\blh\b/g, 'lufthavn')
            .replace(/\s+/g, ' ')
            .trim();

    const loadAirports = () => {
        let remote = [];
        try {
            const text = typeof GM_getResourceText === 'function' ? GM_getResourceText('airports') : null;
            if (text) remote = JSON.parse(text);
            if (!Array.isArray(remote)) remote = [];
        } catch (ex) {
            warn('Could not read airports.json, using built-in list', ex);
        }

        const byIcao = new Map(BUILTIN_AIRPORTS.map((a) => [a.airport, { ...a }]));
        remote.forEach((r) => {
            const b = byIcao.get(r.airport) || {};
            byIcao.set(r.airport, {
                ...b,
                ...r,
                lat: Number.isFinite(r.lat) ? r.lat : b.lat,
                lon: Number.isFinite(r.lon) ? r.lon : b.lon,
                aliases: [...(b.aliases || []), ...(r.aliases || [])],
            });
        });

        // "Haugesund lufthavn, Karmøy" also matches "Haugesund lufthavn" and "Haugesund LH"
        return [...byIcao.values()].map((a) => {
            const names = new Set();
            [a.location, ...(a.aliases || [])].filter(Boolean).forEach((n) => {
                names.add(normalizeName(n));
                names.add(normalizeName(n.split(',')[0]));
            });
            return { ...a, names };
        });
    };

    // ---------------------------------------------------------------- location on the page

    const safeDecode = (s) => {
        try {
            return decodeURIComponent(s);
        } catch (ex) {
            return s;
        }
    };

    const getLocationId = () => location.pathname.split('/').find((s) => /^\d+-\d+$/.test(s)) || null;

    // yr.no embeds the location (incl. coordinates) in __REACT_QUERY_STATE__ on page load
    const getLocationFromPageState = (id) => {
        try {
            const queries = pageWindow.__REACT_QUERY_STATE__?.queries;
            if (!Array.isArray(queries)) return null;
            const query = queries.find(
                (q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'location' && q.queryKey.includes(id)
            );
            return query?.state?.data || null;
        } catch (ex) {
            return null;
        }
    };

    // After navigating inside yr.no the page state is stale, so ask yr's own API instead
    const locationCache = new Map();
    const pendingLocations = new Set();

    const requestLocation = (id) => {
        if (locationCache.has(id) || pendingLocations.has(id)) return;
        pendingLocations.add(id);
        fetch(location.origin + '/api/v0/locations/' + encodeURIComponent(id), { credentials: 'same-origin' })
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null)
            .then((data) => {
                locationCache.set(id, data && (data.position ? data : data.location || null));
                pendingLocations.delete(id);
                schedule();
            });
    };

    const getLocationInfo = () => {
        const id = getLocationId();
        let data = null;
        if (id) {
            data = getLocationFromPageState(id) || locationCache.get(id) || null;
            if (!data) requestLocation(id);
        }

        const names = [];
        if (data?.name) names.push(data.name);

        const segments = location.pathname.split('/').filter(Boolean);
        const idIndex = segments.indexOf(id);
        if (idIndex !== -1 && idIndex < segments.length - 1) names.push(safeDecode(segments[segments.length - 1]));

        const heading = document.querySelector('#location-heading') || document.querySelector('h1');
        if (heading) names.push(heading.textContent);

        const titleMatch = document.title.match(/^Yr\s+-\s+(.+?)\s+-\s+/);
        if (titleMatch) names.push(titleMatch[1]);

        const p = data?.position;
        const position = p && Number.isFinite(p.lat) && Number.isFinite(p.lon) ? { lat: p.lat, lon: p.lon } : null;

        return { id, name: names[0] || '', names: names.map(normalizeName).filter(Boolean), position };
    };

    const distanceKm = (a, b) => {
        const rad = Math.PI / 180;
        const x = (b.lon - a.lon) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
        const y = (b.lat - a.lat) * rad;
        return 6371 * Math.sqrt(x * x + y * y);
    };

    const findAirport = (airports, info) => {
        if (info.position) {
            let best = null;
            let bestDistance = Infinity;
            airports.forEach((a) => {
                if (!Number.isFinite(a.lat) || !Number.isFinite(a.lon)) return;
                const d = distanceKm(info.position, a);
                if (d < bestDistance) {
                    best = a;
                    bestDistance = d;
                }
            });
            if (best && bestDistance <= MATCH_RADIUS_KM) return best;
        }
        return airports.find((a) => info.names.some((n) => a.names.has(n))) || null;
    };

    // ---------------------------------------------------------------- formatting

    const pad = (n, len) => String(n).padStart(len, '0');

    const hhmm = (date) =>
        date instanceof Date && !isNaN(date) ? pad(date.getHours(), 2) + ':' + pad(date.getMinutes(), 2) : '--:--';

    const formatRunway = (rwy) => pad(rwy, 2);

    const formatVariation = (variation) =>
        !variation ? '0°' : Math.abs(variation) + '° ' + (variation < 0 ? 'E' : 'W');

    const withGust = (value, gust) =>
        gust !== null && gust !== undefined && gust > value ? value + 'G' + gust : String(value);

    // ---------------------------------------------------------------- sun

    const getSunInfo = (airport, info) => {
        if (typeof SunCalc === 'undefined') return '';
        const position = Number.isFinite(airport.lat) ? { lat: airport.lat, lon: airport.lon } : info.position;
        if (!position) return '';

        try {
            const t = SunCalc.getTimes(new Date(), position.lat, position.lon);
            return ` - 🌅 ${hhmm(t.dawn)}-${hhmm(t.sunrise)} 🌇 ${hhmm(t.sunset)}-${hhmm(t.dusk)}`;
        } catch (ex) {
            warn('Could not calculate sun times', ex);
            return '';
        }
    };

    // ---------------------------------------------------------------- wind maths

    const toMagnetic = (trueDirection, variation) => {
        let d = Math.round(trueDirection) + Math.round(variation || 0);
        d = ((d % 360) + 360) % 360;
        return d === 0 ? 360 : d;
    };

    // One line per runway end that has headwind (or pure crosswind)
    const getRunwayComponents = (airport, direction, speedKt, gustKt) =>
        (airport.runways || [])
            .map((rwy) => {
                const heading = Number(rwy) * 10;
                // Signed angle between wind and runway: negative = from the left
                const diff = ((direction - heading + 540) % 360) - 180;
                if (Math.abs(diff) > 90) return null;

                const rad = (diff * Math.PI) / 180;
                const components = (v) => ({
                    cross: Math.round(Math.abs(v * Math.sin(rad))),
                    head: Math.round(v * Math.cos(rad)),
                });

                const base = components(speedKt);
                const gust = gustKt !== null ? components(gustKt) : null;

                const crossText =
                    base.cross === 0 && (!gust || gust.cross === 0)
                        ? 'no crosswind'
                        : withGust(base.cross, gust && gust.cross) + 'kt from the ' + (diff < 0 ? 'left' : 'right');
                const headText = withGust(base.head, gust && gust.head) + 'kt headwind';

                return 'RWY' + formatRunway(rwy) + ': ' + crossText + ', ' + headText;
            })
            .filter(Boolean);

    // ---------------------------------------------------------------- DOM helpers

    const parseNumber = (text) => {
        const m = (text || '').replace(',', '.').match(/-?\d+(?:\.\d+)?/);
        return m ? parseFloat(m[0]) : null;
    };

    const detectUnit = (text) => {
        const t = (text || '').toLowerCase();
        if (/km\/[ht]|kilomet/.test(t)) return 'kmh';
        if (/mph|miles/.test(t)) return 'mph';
        if (/\bknots?\b|\bknop\b|\bkt\b|\bkn\b/.test(t)) return 'kt';
        if (/m\/s|meters? per|metres? per/.test(t)) return 'ms';
        return null;
    };

    const unitOf = (el) => el && detectUnit(el.textContent + ' ' + (el.getAttribute('title') || ''));

    const isOurs = (el) => !!(el && el.closest && el.closest('[data-flyr]'));

    const ownText = (el) =>
        [...el.childNodes]
            .filter((n) => !(n.nodeType === 1 && n.hasAttribute('data-flyr')))
            .map((n) => n.textContent)
            .join('')
            .replace(/\s+/g, ' ')
            .trim();

    const ROTATION_PATTERNS = [
        /rotate\(\s*(-?\d+(?:\.\d+)?)/i,
        /rotate:\s*(-?\d+(?:\.\d+)?)deg/i,
        /--[\w-]*(?:rotat|direction|angle)[\w-]*:\s*(-?\d+(?:\.\d+)?)/i,
    ];

    // Wind direction is read from the rotation of yr's wind arrow (degrees the wind comes from)
    const findRotation = (scope) => {
        if (!scope || isOurs(scope)) return null;

        const arrows = [...scope.querySelectorAll('[class*="arrow"], [class*="arrow"] *')];
        const candidates = [...arrows, scope, ...scope.querySelectorAll('[style], [transform]')];

        for (const el of candidates) {
            if (isOurs(el)) continue;
            const src = (el.getAttribute('style') || '') + ';' + (el.getAttribute('transform') || '');
            for (const pattern of ROTATION_PATTERNS) {
                const m = src.match(pattern);
                if (m) return parseFloat(m[1]);
            }
        }

        // Last resort: rotation applied through a stylesheet
        for (const el of arrows) {
            const transform = getComputedStyle(el).transform;
            const m = transform && transform.match(/^matrix\(([^,]+),\s*([^,]+)/);
            if (m) return (Math.atan2(parseFloat(m[2]), parseFloat(m[1])) * 180) / Math.PI;
        }
        return null;
    };

    const isCell = (el) => el.tagName === 'TD' || el.tagName === 'TH';

    // yr's own (React-managed) elements are never rewritten. The original is hidden and our
    // copy is placed next to it. If yr re-renders, the key no longer matches and the copy is rebuilt.
    const getOverlay = (target) => {
        if (isCell(target)) return target.querySelector(':scope > [data-flyr]');
        const next = target.nextElementSibling;
        return next && next.hasAttribute('data-flyr') ? next : null;
    };

    const hideTarget = (target) => target.setAttribute(isCell(target) ? 'data-flyr-cell' : 'data-flyr-hidden', '');

    const removeOverlay = (target) => {
        const existing = getOverlay(target);
        if (existing) existing.remove();
        target.removeAttribute('data-flyr-hidden');
        target.removeAttribute('data-flyr-cell');
    };

    const overlay = (target, key, build) => {
        const existing = getOverlay(target);
        if (existing && existing.dataset.flyrKey === key) {
            hideTarget(target);
            return;
        }
        if (existing) existing.remove();

        let node;
        if (isCell(target)) {
            if (!target.dataset.flyrFontSize) target.dataset.flyrFontSize = getComputedStyle(target).fontSize;
            node = document.createElement('span');
            node.style.fontSize = target.dataset.flyrFontSize;
            build(node, true);
            target.appendChild(node);
        } else {
            node = target.cloneNode(true);
            node.removeAttribute('id');
            node.removeAttribute('data-flyr-hidden');
            node.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
            node.querySelectorAll('[data-flyr-hidden]').forEach((n) => n.removeAttribute('data-flyr-hidden'));
            build(node, false);
            target.after(node);
        }
        node.setAttribute('data-flyr', '');
        node.dataset.flyrKey = key;
        hideTarget(target);
    };

    const textReplacements = [];

    const replaceText = (root, pattern, replacement) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
            const node = walker.currentNode;
            const updated = node.nodeValue.replace(pattern, replacement);
            if (updated !== node.nodeValue) {
                textReplacements.push({ node, original: node.nodeValue, updated });
                node.nodeValue = updated;
            }
        }
    };

    // ---------------------------------------------------------------- page rendering

    const ensureStyle = () => {
        if (document.getElementById('flyr-style')) return;
        const style = document.createElement('style');
        style.id = 'flyr-style';
        style.textContent = `
            [data-flyr-hidden] { display: none !important; }
            [data-flyr-cell] { font-size: 0 !important; }
            [data-flyr-cell] > :not([data-flyr]) { display: none !important; }
            #flyr-title { display: block; width: 100%; margin: 0.25em 0 0.5em; font-size: 0.9rem; font-weight: normal;
                          line-height: 1.5; white-space: pre-line; }
            .flyr-runways { display: block; flex-basis: 100%; width: 100%; font-size: 0.8em; line-height: 1.35;
                            white-space: pre-line; margin-top: 0.25em; text-align: left; }
        `;
        (document.head || document.documentElement).appendChild(style);
    };

    const renderTitle = (airport, info, currentLine) => {
        const text =
            '🛩️ ' +
            airport.airport +
            ' - RWY ' +
            (airport.runways || []).map(formatRunway).join(', ') +
            ' - variation: ' +
            formatVariation(airport.variation) +
            getSunInfo(airport, info) +
            (currentLine ? '\n' + currentLine : '');

        let el = document.getElementById('flyr-title');
        if (!el) {
            el = document.createElement('div');
            el.id = 'flyr-title';
            el.setAttribute('data-flyr', '');
        }

        if (!el.isConnected) {
            const locationRow = document.querySelector('.page-header__location');
            const oldHeader = document.querySelector('.page-header__location-header');
            const heading = document.querySelector('#location-heading') || document.querySelector('h1');
            if (locationRow) locationRow.insertAdjacentElement('afterend', el);
            else if (oldHeader) oldHeader.appendChild(el);
            else if (heading) heading.insertAdjacentElement('afterend', el);
            else return;
        }

        if (el.textContent !== text) el.textContent = text;
    };

    const convertHeaders = () => {
        document.querySelectorAll('th').forEach((th) => {
            if (isOurs(th)) return;
            if (!th.hasAttribute('data-flyr-unit')) {
                const unit = detectUnit(th.textContent);
                if (!unit || unit === 'kt') return;
                th.setAttribute('data-flyr-unit', unit);
            }
            replaceText(th, /m\/s|km\/[ht]|mph/gi, 'kt');
        });
    };

    const getTableUnit = (el) => {
        const th = el.closest('table')?.querySelector('th[data-flyr-unit]');
        return th ? th.getAttribute('data-flyr-unit') : null;
    };

    const getPageUnit = () => {
        for (const el of document.querySelectorAll(SEL.windUnit)) {
            if (isOurs(el)) continue;
            const unit = unitOf(el);
            if (unit) return unit;
        }
        return 'ms';
    };

    // Reads one of yr's wind widgets (always yr's original element, never our copy)
    const readWind = (root, airport, pageUnit) => {
        const valueEl = root.querySelector(SEL.windValue);
        if (!valueEl) return null;

        const gustEl = root.querySelector(SEL.windGust);
        const unitEl = root.querySelector(SEL.windUnit);
        const unit = unitOf(unitEl) || getTableUnit(root) || pageUnit;
        const factor = TO_KT[unit];

        const speed = parseNumber(valueEl.textContent);
        if (speed === null) return null;
        const gust = gustEl ? parseNumber(gustEl.textContent) : null;

        const speedKt = speed * factor;
        const gustKt = gust !== null ? gust * factor : null;
        const rotation = findRotation(root) ?? findRotation(root.closest('td'));
        const direction = rotation === null ? null : toMagnetic(rotation, airport.variation);

        return {
            unit,
            rotation,
            direction,
            kt: Math.round(speedKt),
            gkt: gustKt !== null ? Math.round(gustKt) : null,
            runways: direction === null ? [] : getRunwayComponents(airport, direction, speedKt, gustKt),
        };
    };

    const formatWind = (w) => (w.direction !== null ? pad(w.direction, 3) + '° ' : '') + withGust(w.kt, w.gkt) + 'kt';

    const convertWind = (root, airport, pageUnit) => {
        const w = readWind(root, airport, pageUnit);
        if (!w) return;

        const row = root.closest('tr');
        const descriptionEl = row ? row.querySelector(SEL.windDescription) : null;
        const tableMode = !!row && w.direction !== null;
        const key = [airport.airport, w.unit, ownText(root), w.rotation].join('|');

        overlay(root, key, (node, isSpan) => {
            if (isSpan || tableMode) {
                // Table rows: compact aviation format, e.g. "174° 19G35kt"
                node.classList.remove('wind--display-arrow');
                node.textContent = formatWind(w);
                if (w.runways.length && !descriptionEl) {
                    const r = document.createElement('div');
                    r.className = 'flyr-runways';
                    r.textContent = w.runways.join(', ');
                    node.style.flexWrap = 'wrap';
                    node.appendChild(r);
                }
                return;
            }

            // Everywhere else: keep yr's layout (incl. the arrow), only swap numbers and unit.
            // Direction and runway components for "now" are shown in the Flyr header line.
            const v = node.querySelector(SEL.windValue);
            if (v) v.textContent = String(w.kt);

            const g = node.querySelector(SEL.windGust);
            if (g && w.gkt !== null) g.textContent = g.textContent.replace(/\d+(?:[.,]\d+)?/, String(w.gkt));

            const u = node.querySelector(SEL.windUnit);
            if (u) {
                u.textContent = 'kt';
                u.setAttribute('title', 'knots');
            }
        });

        if (descriptionEl) {
            if (tableMode && w.runways.length) {
                overlay(descriptionEl, key, (node) => {
                    node.textContent = w.runways.join(', ');
                });
            } else {
                removeOverlay(descriptionEl);
            }
        }
    };

    // "Now" line for the Flyr header, read from yr's current-conditions box
    const getCurrentWindLine = (airport, pageUnit) => {
        const root = [...document.querySelectorAll('.now-hero ' + SEL.windRoot)].find(
            (el) => !isOurs(el) && el.querySelector(SEL.windValue)
        );
        const w = root && readWind(root, airport, pageUnit);
        if (!w) return '';
        return '💨 Now: ' + formatWind(w) + (w.runways.length ? ' · ' + w.runways.join(' · ') : '');
    };

    const convertAllWind = (airport, pageUnit) => {
        const roots = new Set();

        document.querySelectorAll(SEL.windValue).forEach((valueEl) => {
            if (isOurs(valueEl)) return;
            const root = valueEl.closest(SEL.windRoot) || valueEl.closest(SEL.windContainer) || valueEl.parentElement;
            if (root) roots.add(root);
        });

        roots.forEach((root) => {
            try {
                convertWind(root, airport, pageUnit);
            } catch (ex) {
                warn('Could not convert wind element', root, ex);
            }
        });

        return roots.size;
    };

    const cleanup = () => {
        document.querySelectorAll('[data-flyr]').forEach((n) => n.remove());
        document.querySelectorAll('[data-flyr-hidden]').forEach((n) => n.removeAttribute('data-flyr-hidden'));
        document.querySelectorAll('[data-flyr-cell]').forEach((n) => {
            n.removeAttribute('data-flyr-cell');
            delete n.dataset.flyrFontSize;
        });
        document.querySelectorAll('[data-flyr-unit]').forEach((n) => n.removeAttribute('data-flyr-unit'));
        textReplacements.splice(0).forEach(({ node, original, updated }) => {
            if (node.isConnected && node.nodeValue === updated) node.nodeValue = original;
        });
    };

    // ---------------------------------------------------------------- main loop

    const airports = loadAirports();
    let activeAirport = null;
    let reportedUrl = null;

    const applyFlyr = () => {
        const info = getLocationInfo();
        const airport = findAirport(airports, info);

        if (airport !== activeAirport) {
            cleanup();
            activeAirport = airport;
            if (airport) log('Active airport', airport.airport, info);
        }

        if (!airport) {
            if (info.id && !pendingLocations.has(info.id) && reportedUrl !== location.href) {
                reportedUrl = location.href;
                console.info('[Flyr] No airport matches "' + info.name + '" (' + info.id + ')', info.position || '');
            }
            return;
        }

        ensureStyle();
        convertHeaders();
        const pageUnit = getPageUnit();
        renderTitle(airport, info, getCurrentWindLine(airport, pageUnit));
        const count = convertAllWind(airport, pageUnit);
        if (count === 0) log('No wind elements (' + SEL.windValue + ') found on this page.');
    };

    const observer = new MutationObserver(() => schedule());
    const observe = () =>
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['style', 'transform', 'class'],
        });

    const run = () => {
        // Pause observing while we change the DOM, so we don't trigger ourselves
        observer.disconnect();
        try {
            applyFlyr();
        } catch (ex) {
            warn(ex);
        } finally {
            observe();
        }
    };

    let timer = null;
    function schedule() {
        if (timer) return;
        timer = setTimeout(() => {
            timer = null;
            run();
        }, 150);
    }

    // Give yr.no time to hydrate its server-rendered page before we touch it
    const start = () => setTimeout(run, 300);
    if (document.readyState === 'complete') start();
    else window.addEventListener('load', start, { once: true });
})();
