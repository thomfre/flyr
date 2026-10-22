// ==UserScript==
// @name         Flyr
// @namespace    https://github.com/thomfre/flyr
// @version      0.6
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

    const SEL = {
        windValue: '.wind__value',
        windGust: '.wind__gust',
        windUnit: '.wind__unit',
        windRoot: '.wind',
        windContainer: '.wind__container',
        windDescription: '.wind-description',
        locationName: '.page-header__location-name',
        titleAnchor: '.page-header__location-header',
    };

    const TO_KT = { ms: 1.943844, kmh: 0.539957, mph: 0.868976, kt: 1 };

    const log = (...args) => DEBUG && console.log('[Flyr]', ...args);
    const warn = (...args) => console.warn('[Flyr]', ...args);

    // ---------------------------------------------------------------- data

    const loadAirports = () => {
        try {
            const text = typeof GM_getResourceText === 'function' ? GM_getResourceText('airports') : null;
            const list = JSON.parse(text);
            if (!Array.isArray(list)) throw new Error('airports.json is not an array');
            return list;
        } catch (ex) {
            warn('Could not load airports.json', ex);
            return [];
        }
    };

    const normalize = (s) => (s || '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();

    const safeDecode = (s) => {
        try {
            return decodeURIComponent(s);
        } catch (ex) {
            return s;
        }
    };

    // The location name is read from several places, so the script keeps
    // working even if yr.no renames one of the header elements.
    const getLocationNames = () => {
        const names = [];

        // URL: /<lang>/<page>/<view>/<id>/<country>/<county>/<municipality>/<name>
        const segments = location.pathname.split('/').filter(Boolean);
        const idIndex = segments.findIndex((s) => /^\d+-\d+$/.test(s));
        if (idIndex !== -1 && idIndex < segments.length - 1) {
            names.push(safeDecode(segments[segments.length - 1]));
        }

        const heading = document.querySelector(SEL.locationName) || document.querySelector('#location-heading');
        if (heading) names.push(heading.textContent);

        const h1 = document.querySelector('h1');
        if (h1) names.push(h1.textContent);

        const titleMatch = document.title.match(/^Yr\s+-\s+(.+?)\s+-\s+/);
        if (titleMatch) names.push(titleMatch[1]);

        return names.map(normalize).filter(Boolean);
    };

    const findAirport = (airports) => {
        const names = getLocationNames();
        return (
            airports.find((a) => [a.location, ...(a.aliases || [])].some((n) => names.includes(normalize(n)))) || null
        );
    };

    // ---------------------------------------------------------------- formatting

    const pad = (n, len) => String(n).padStart(len, '0');

    const hhmm = (date) =>
        date instanceof Date && !isNaN(date) ? pad(date.getHours(), 2) + ':' + pad(date.getMinutes(), 2) : '--:--';

    const formatRunway = (rwy) => pad(rwy, 2);

    const formatVariation = (variation) =>
        !variation ? '0°' : Math.abs(variation) + '° ' + (variation < 0 ? 'E' : 'W');

    const withGust = (value, gust) => (gust !== null && gust !== undefined && gust > value ? value + 'G' + gust : String(value));

    // ---------------------------------------------------------------- sun

    const getCoordinates = (airport) => {
        if (Number.isFinite(airport.lat) && Number.isFinite(airport.lon)) return { lat: airport.lat, lon: airport.lon };

        // Fallback for airports.json entries without coordinates
        try {
            const locations = unsafeWindow.__REDUX_STATE__?.locations?.locations;
            const position = locations && Object.values(locations)[0]?.position;
            if (position && Number.isFinite(position.lat) && Number.isFinite(position.lon)) return position;
        } catch (ex) {
            log('No coordinates in page state', ex);
        }
        return null;
    };

    const getSunInfo = (airport) => {
        if (typeof SunCalc === 'undefined') return '';
        const position = getCoordinates(airport);
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

    // Returns one line per runway end that has headwind (or pure crosswind).
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

    // Wind direction is read from the rotation of yr's wind arrow.
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

    // We never rewrite yr's own (React-managed) elements. Instead the original
    // is hidden and our own copy is placed next to it. If yr re-renders, the
    // key no longer matches and our copy is rebuilt.
    const getOverlay = (target) => {
        if (isCell(target)) return target.querySelector(':scope > [data-flyr]');
        const next = target.nextElementSibling;
        return next && next.hasAttribute('data-flyr') ? next : null;
    };

    const hideTarget = (target) => {
        if (isCell(target)) {
            target.setAttribute('data-flyr-cell', '');
        } else {
            target.setAttribute('data-flyr-hidden', '');
        }
    };

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
            #flyr-title { flex-basis: 100%; width: 100%; margin-top: 0.25em; font-size: 0.9rem; font-weight: normal; }
            .flyr-runways { display: block; flex-basis: 100%; width: 100%; font-size: 0.8em; line-height: 1.35;
                            white-space: pre-line; margin-top: 0.25em; text-align: left; }
            .flyr-direction { margin-right: 0.35em; }
        `;
        (document.head || document.documentElement).appendChild(style);
    };

    const renderTitle = (airport) => {
        const text =
            '🛩️ ' +
            airport.airport +
            ' - RWY ' +
            (airport.runways || []).map(formatRunway).join(', ') +
            ' - variation: ' +
            formatVariation(airport.variation) +
            getSunInfo(airport);

        let el = document.getElementById('flyr-title');
        if (!el) {
            el = document.createElement('div');
            el.id = 'flyr-title';
            el.setAttribute('data-flyr', '');
        }

        if (!el.isConnected) {
            const anchor = document.querySelector(SEL.titleAnchor);
            if (anchor) {
                anchor.appendChild(el);
            } else {
                const heading = document.querySelector('#location-heading') || document.querySelector('h1');
                if (!heading) return;
                heading.insertAdjacentElement('afterend', el);
            }
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

    const convertWind = (root, airport, pageUnit) => {
        const valueEl = root.querySelector(SEL.windValue);
        if (!valueEl) return;

        const gustEl = root.querySelector(SEL.windGust);
        const unitEl = root.querySelector(SEL.windUnit);
        const unit = unitOf(unitEl) || getTableUnit(root) || pageUnit;
        const factor = TO_KT[unit];

        const speed = parseNumber(valueEl.textContent);
        if (speed === null) return;
        const gust = gustEl ? parseNumber(gustEl.textContent) : null;

        const speedKt = speed * factor;
        const gustKt = gust !== null ? gust * factor : null;
        const kt = Math.round(speedKt);
        const gkt = gustKt !== null ? Math.round(gustKt) : null;

        const rotation = findRotation(root) ?? findRotation(root.closest('td'));
        const direction = rotation === null ? null : toMagnetic(rotation, airport.variation);
        const runways = direction === null ? [] : getRunwayComponents(airport, direction, speedKt, gustKt);

        const row = root.closest('tr');
        const descriptionEl = row ? row.querySelector(SEL.windDescription) : null;
        const key = [airport.airport, unit, ownText(root), rotation].join('|');

        overlay(root, key, (node, isSpan) => {
            if (isSpan || (row && direction !== null)) {
                // Table rows: compact aviation format, e.g. "228° 17G35kt"
                node.classList.remove('wind--display-arrow');
                node.textContent =
                    (direction !== null ? pad(direction, 3) + '° ' : '') + withGust(kt, gkt) + 'kt';
            } else {
                // Current conditions / daily list: keep yr's layout, swap the numbers
                const v = node.querySelector(SEL.windValue);
                if (v) v.textContent = String(kt);

                const g = node.querySelector(SEL.windGust);
                if (g && gkt !== null) g.textContent = g.textContent.replace(/\d+(?:[.,]\d+)?/, String(gkt));

                const u = node.querySelector(SEL.windUnit);
                if (u) {
                    u.textContent = 'kt';
                    u.setAttribute('title', 'knots');
                }

                if (direction !== null) {
                    const d = document.createElement('span');
                    d.className = 'flyr-direction';
                    d.textContent = pad(direction, 3) + '°';
                    (node.querySelector(SEL.windContainer) || node).prepend(d);
                }
            }

            if (runways.length && !descriptionEl) {
                const r = document.createElement('div');
                r.className = 'flyr-runways';
                r.textContent = runways.join(row ? ', ' : '\n');
                node.style.flexWrap = 'wrap';
                node.appendChild(r);
            }
        });

        if (descriptionEl) {
            if (runways.length) {
                overlay(descriptionEl, key, (node) => {
                    node.textContent = runways.join(', ');
                });
            } else {
                removeOverlay(descriptionEl);
            }
        }
    };

    const convertAllWind = (airport) => {
        const pageUnit = getPageUnit();
        const roots = new Set();

        document.querySelectorAll(SEL.windValue).forEach((valueEl) => {
            if (isOurs(valueEl)) return;
            const root =
                valueEl.closest(SEL.windRoot) || valueEl.closest(SEL.windContainer) || valueEl.parentElement;
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
    let warnedForUrl = null;

    const applyFlyr = () => {
        const airport = findAirport(airports);

        if (airport !== activeAirport) {
            cleanup();
            activeAirport = airport;
            if (airport) log('Active airport', airport.airport);
        }
        if (!airport) return;

        ensureStyle();
        renderTitle(airport);
        convertHeaders();
        const count = convertAllWind(airport);

        if (count === 0 && /forecast|varsel|værvarsel/i.test(location.pathname) && warnedForUrl !== location.href) {
            warnedForUrl = location.href;
            log('No wind elements (' + SEL.windValue + ') found on this page. yr.no may have changed its markup.');
        }
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
    const schedule = () => {
        if (timer) return;
        timer = setTimeout(() => {
            timer = null;
            run();
        }, 150);
    };

    if (!airports.length) return;
    observe();
    schedule();
})();
