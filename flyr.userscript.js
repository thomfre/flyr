// ==UserScript==
// @name         Flyr
// @namespace    https://github.com/thomfre/flyr
// @version      0.1
// @description  Make yr.no beautiful for pilots
// @author       You
// @match        https://www.yr.no/*
// @grant        GM_getResourceText
// @resource     airports https://raw.githubusercontent.com/thomfre/flyr/main/airports.json
// @downloadURL  https://raw.githubusercontent.com/thomfre/flyr/main/flyr.userscript.js
// ==/UserScript==

let airports;
let activeAirport;

const getAirport = (location) => {
    const airport = airports.filter((a) => a.location === location);
    if (airport.length > 0) return airport[0];

    return null;
};

const getCrosswindFactor = (runwayHeading, windDirection, windVelocity) => {
    const angle = runwayHeading - windDirection;
    const pi = Math.PI / 180;
    const sinFactor = Math.sin(angle * pi);
    const cosFactor = Math.cos(angle * pi);

    let crossWindVelocity = Math.round(windVelocity * sinFactor * 1) / 1;
    let runwayWindVelocity = Math.abs(Math.round(windVelocity * cosFactor * 1) / 1);

    let crossWindDirection;

    if (angle === 0) {
        crossWindDirection = 'perfect headwind';
    } else if (angle < 0) {
        crossWindDirection = 'from the right';
        crossWindVelocity = crossWindVelocity * -1;
    } else if (angle > 0) {
        crossWindDirection = 'from the left';
    }

    if (Math.abs(angle) === 180) {
        crossWindDirection = 'perfect tailwind';
    }

    const runwayDirection = Math.abs(angle) > 90 ? 'tailwind' : 'headwind';

    return {
        velocity: crossWindVelocity,
        direction: crossWindDirection,
        runwayVelocity: runwayWindVelocity,
        runwayDirection: runwayDirection,
        display: Math.abs(angle) < 90,
    };
};

const convertWind = () => {
    const rows = document.querySelectorAll('#page-modal .modal-dialog__scroll-container .fluid-table__table tbody tr');

    rows.forEach((row) => {
        const windArrow = row.querySelector('.wind__container .wind-arrow__arrow');
        if (!windArrow) return;

        let windDirection = parseInt(windArrow.outerHTML.match(/rotate\(([-0-9]+)deg\)/)[1]);
        windDirection += Math.round(activeAirport.variation);
        if (windDirection <= 0) {
            windDirection = 360 - windDirection;
        } else if (windDirection > 360) {
            windDirection = windDirection - 360;
        }

        const windVelocity = parseInt(row.querySelector('.wind__container .wind__value').innerText) * 1.944;
        const windGust = parseInt(row.querySelector('.wind__container .wind__gust')?.innerText.match(/[0-9]+/) ?? 0) * 1.944;

        const runways = activeAirport.runways.map((rwy) => {
            const runwayHeading = rwy * 10;
            const crosswind = getCrosswindFactor(runwayHeading, windDirection, windVelocity);
            const crosswindGust = windGust > 0 ? getCrosswindFactor(runwayHeading, windDirection, windGust) : 0;

            const crosswindVelocity = crosswind.velocity + (crosswindGust.velocity > 0 ? 'G' + crosswindGust.velocity : '');
            const runwayVelocity = crosswind.runwayVelocity + (crosswindGust.runwayVelocity > 0 ? 'G' + crosswindGust.runwayVelocity : '');

            if (!crosswind.display) return null;

            return (
                'RWY' +
                rwy +
                ': ' +
                crosswindVelocity +
                'kt ' +
                crosswind.direction +
                ', ' +
                runwayVelocity +
                'kt ' +
                crosswind.runwayDirection
            );
        });

        const windContainer = row.querySelector('.wind');
        windContainer.innerHTML =
            windDirection + '&deg; ' + Math.ceil(windVelocity) + (windGust > 0 ? 'G' + Math.ceil(windGust) : '') + 'kt';
        windContainer.classList.remove('wind--display-arrow');

        const windDescription = row.querySelector('.wind-description');
        windDescription.innerHTML = runways.filter((rwy) => rwy).join(', ');
    });

    const windColumnHeader = document
        .querySelectorAll('#page-modal .modal-dialog__scroll-container .fluid-table__table thead tr th')[4]
        .querySelectorAll('span span')[1];
    windColumnHeader.innerHTML = windColumnHeader.innerHTML.replace('m/s', 'kts');
};

const loadAirport = () => {
    const location = document.querySelector('#location-heading .page-header__location-name')?.innerText;

    if (!location) return;

    const airport = getAirport(location);

    if (!airport) {
        console.log('Unsupported location: ' + location);
        return;
    }

    activeAirport = airport;

    if (!document.querySelector('#flyr-title')) {
        const flyrTitle = document.createElement('div');
        flyrTitle.setAttribute('id', 'flyr-title');
        document.querySelector('.page-header__location-header').appendChild(flyrTitle);
    }

    const variation = (airport.variation < 0 ? 'E ' : 'W ') + Math.abs(airport.variation) + '&deg;';

    document.querySelector('#flyr-title').innerHTML = '🛩️ ' + airport.airport + ' - RWY ' + airport.runways + ' - variation: ' + variation;

    return airport;
};

const handleModal = () => {
    if (!document.querySelector('#page-modal .modal-dialog__scroll-container')) return;
    convertWind();
};

const observeAndAct = (selector, callback) => {
    const element = document.querySelector(selector);

    const observer = new MutationObserver(callback);

    const observerConfig = {
        attributes: true,
        childList: true,
        characterData: true,
    };

    observer.observe(element, observerConfig);

    return observer;
};

(function () {
    'use strict';

    airports = JSON.parse(GM_getResourceText('airports', 'json'));

    observeAndAct('.page-header', () => {
        loadAirport();
    });

    observeAndAct('#page-modal', () => {
        handleModal();
    });
})();
