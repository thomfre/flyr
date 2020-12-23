// ==UserScript==
// @name         Flyr
// @namespace    https://github.com/thomfre/flyr
// @version      0.5
// @description  Make yr.no beautiful for pilots
// @icon         https://raw.githubusercontent.com/thomfre/flyr/main/logo.png
// @author       thomfre
// @match        https://www.yr.no/*
// @grant        GM_getResourceText
// @grant        unsafeWindow
// @require      https://raw.githubusercontent.com/mourner/suncalc/master/suncalc.js
// @resource     airports https://raw.githubusercontent.com/thomfre/flyr/main/airports.json
// @downloadURL  https://raw.githubusercontent.com/thomfre/flyr/main/flyr.userscript.js
// @updateURL    https://raw.githubusercontent.com/thomfre/flyr/main/flyr.userscript.meta.js
// ==/UserScript==

let airports;
let activeAirport;

const convertToKts = (wind) => {
    return wind * 1.944;
}

const getAirport = (location) => {
    const airport = airports.filter((a) => a.location === location);
    if (airport.length > 0) return airport[0];

    return null;
};

const getSunInfo = () => {
    try {
        if (!unsafeWindow.__REDUX_STATE__.locations.locations) return;

        const location =
            unsafeWindow.__REDUX_STATE__.locations.locations[Object.keys(unsafeWindow.__REDUX_STATE__.locations.locations)[0]].position;

        const times = SunCalc.getTimes(new Date(), location.lat, location.lon);

        return (
            ' - 🌅 ' +
            times.dawn.getHours() +
            ':' +
            times.dawn.getMinutes() +
            '-' +
            times.sunrise.getHours() +
            ':' +
            times.sunrise.getMinutes() +
            ' 🌇 ' +
            times.sunset.getHours() +
            ':' +
            times.sunset.getMinutes() +
            '-' +
            times.dusk.getHours() +
            ':' +
            times.dusk.getMinutes()
        );
    } catch (ex) {
        console.log(ex);
        return '';
    }
};

const getCrosswindFactor = (runwayHeading, windDirection, windVelocity) => {
    let angle = Math.abs(runwayHeading - windDirection);
    if (angle > 180) angle = 360 - angle;
    const pi = Math.PI / 180;
    const sinFactor = Math.sin(angle * pi);
    const cosFactor = Math.cos(angle * pi);

    let crossWindVelocity = Math.round(windVelocity * sinFactor * 1) / 1;
    let runwayWindVelocity = Math.abs(Math.round(windVelocity * cosFactor * 1) / 1);

    let crossWindDirection;

    if (windDirection - runwayHeading > -180 ? windDirection < runwayHeading : (windDirection + 360 < runwayHeading)) {
        crossWindDirection = 'from the left';
    } else {
        crossWindDirection = 'from the right';
    }

    if (angle === 0) {
        crossWindDirection = 'perfect headwind';
    } else if (Math.abs(angle) === 180) {
        crossWindDirection = 'perfect tailwind';
    }

    const runwayDirection = angle < 90 ? 'headwind' : 'tailwind';

    return {
        velocity: crossWindVelocity,
        direction: crossWindDirection,
        runwayVelocity: runwayWindVelocity,
        runwayDirection: runwayDirection,
        display: angle < 90,
    };
};

const convertWindModal = () => {
    const rows = document.querySelectorAll('#page-modal .modal-dialog__scroll-container .fluid-table__table tbody tr');

    rows.forEach((row) => {
        const windArrow = row.querySelector('.wind__container .wind-arrow__arrow');
        if (!windArrow) return;

        let windDirection = parseInt(windArrow.outerHTML.match(/rotate\(([-0-9]+)deg\)/)[1]);
        windDirection += Math.round(activeAirport.variation);
        if (windDirection <= 0) {
            windDirection = windDirection + 360;
        } else if (windDirection > 360) {
            windDirection = windDirection - 360;
        }

        const windVelocity = convertToKts(parseInt(row.querySelector('.wind__container .wind__value').innerText));
        const windGust = convertToKts(parseInt(row.querySelector('.wind__container .wind__gust')?.innerText.match(/[0-9]+/) ?? 0));

        const runways = activeAirport.runways.map((rwy) => {
            const runwayHeading = rwy * 10;
            const crosswind = getCrosswindFactor(runwayHeading, windDirection, windVelocity);
            const crosswindGust = windGust > 0 ? getCrosswindFactor(runwayHeading, windDirection, windGust) : 0;

            const crosswindVelocity = crosswind.velocity + (crosswindGust.velocity > 0 ? 'G' + crosswindGust.velocity : '');
            const runwayVelocity = crosswind.runwayVelocity + (crosswindGust.runwayVelocity > 0 ? 'G' + crosswindGust.runwayVelocity : '');

            if (!crosswind.display) return null;

            return (
                'RWY' +
                (rwy.length === 1 ? '0' + rwy : rwy) +
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

const convertWindDaily = () => {
    const rows = document.querySelectorAll('.daily-weather-list-item .daily-weather-list-item__wind')

    rows.forEach((row) => {
        const windValueElement = row.querySelector('.wind__container .wind__value');
        const windVelocity = convertToKts(parseInt(windValueElement.innerText));
        windValueElement.innerHTML = Math.round(windVelocity);

        const windUnitElement = row.querySelector('.wind__container .wind__unit');
        windUnitElement.innerHTML = 'kt';
        windUnitElement.setAttribute('title', 'knots');
    });
};

const convertWindCurrent = () => {
    const windContainer = document.querySelector('.now-hero__next-hour-wind');
    
    const windValueElement = windContainer.querySelector('.wind__container .wind__value');
    const windVelocity = convertToKts(parseInt(windValueElement.innerText));
    windValueElement.innerHTML = Math.round(windVelocity);

    const windGustValueElement = windContainer.querySelector('.wind__container .wind__gust');
    if (windGustValueElement) {
        const windGustVelocity = convertToKts(parseInt(windGustValueElement.innerText.match(/[0-9]+/)));
        windGustValueElement.innerHTML = '(' + Math.round(windGustVelocity) + ')';
    }

    const windUnitElement = windContainer.querySelector('.wind__container .wind__unit');
    windUnitElement.innerHTML = 'kt';
    windUnitElement.setAttribute('title', 'knots');
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

    const variation = airport.variation === 0 ? '0&deg;' : Math.abs(airport.variation) + '&deg; ' + (airport.variation < 0 ? 'E' : 'W');

    document.querySelector('#flyr-title').innerHTML =
        '🛩️ ' +
        airport.airport +
        ' - RWY ' +
        airport.runways.map((rwy) => (rwy.length === 1 ? '0' + rwy : rwy)) +
        ' - variation: ' +
        variation +
        getSunInfo();

    handleModal();
    observeAndAct('#page-modal', () => {
        handleModal();
    });

    handleDailyWeatherList();
    observeAndAct('ol.daily-weather-list__intervals', () => {
        handleDailyWeatherList();
    });

    handleCurrentConditions();
    observeAndAct('.now-hero__next-hour-text', () => {
        handleCurrentConditions();
    });

    return airport;
};

const handleModal = () => {
    if (!document.querySelector('#page-modal .modal-dialog__scroll-container')) return;
    convertWindModal();
};

const handleDailyWeatherList = () => {
    if (!document.querySelector('.daily-weather-list-item')) return;
    convertWindDaily();
}

const handleCurrentConditions = () => {
    if (!document.querySelector('.now-hero__next-hour-wind')) return;
    convertWindCurrent();
};

const observeAndAct = (selector, callback, includeSubTree = false) => {
    const element = document.querySelector(selector);

    if (!element) return;

    const observer = new MutationObserver(callback);

    const observerConfig = {
        subtree: includeSubTree,
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
        observeAndAct(
            '.page-header__location-name',
            () => {
                loadAirport();
            },
            true
        );
    });
})();
