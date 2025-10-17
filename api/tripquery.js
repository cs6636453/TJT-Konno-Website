// Constants for API endpoints
const DATASET_URL = '../api/dataset.json';
const DATANODES_URL = '../api/datanodes.json';

// Global data stores and caches
const locationMap = new Map();
const lineMap = new Map();
const isBusRoute = new Set();
let connectionsData = {};
let linePriority = [];
const destinationCache = new Map();
const pathExistsCache = new Map();

let lineTermini = {};
let lastPathDetailsList = []; // Stores results for the "back" button functionality

/**
 * Calculates a contrasting text color (black or white) for a given hex background color.
 * @param {string} hexcolor - The hex color string (e.g., '#RRGGBB').
 * @returns {string} '#000000' for black or '#FFFFFF' for white.
 */
function getContrastingTextColor(hexcolor) {
    if (!hexcolor) return '#000000';
    const r = parseInt(hexcolor.substr(1, 2), 16);
    const g = parseInt(hexcolor.substr(3, 2), 16);
    const b = parseInt(hexcolor.substr(5, 2), 16);
    const yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
    return (yiq >= 128) ? '#000000' : '#FFFFFF';
}

/**
 * Fetches and sets up all necessary transit data from the APIs.
 */
async function setupData() {
    try {
        const [datasetRes, connectionsRes] = await Promise.all([
            fetch(DATASET_URL), fetch(DATANODES_URL)
        ]);
        if (!datasetRes.ok || !connectionsRes.ok) {
            throw new Error(`Failed to fetch data. Status: ${datasetRes.status}, ${connectionsRes.status}`);
        }
        const dataset = await datasetRes.json();
        connectionsData = await connectionsRes.json();
        lineTermini = dataset.terminus || {};
        [...dataset.stations, ...dataset.bus_stops].forEach(s => locationMap.set(s.key, s.name));
        const allRoutes = [...dataset.routes, ...dataset.bus_routes];
        allRoutes.forEach(route => {
            lineMap.set(route.key, { name: route.name, color: route.color || '#cbd5e0' });
            if (/\d/.test(route.key)) {
                isBusRoute.add(route.key);
            }
        });
        linePriority = [...dataset.routes.map(r => r.key), ...dataset.bus_routes.map(r => r.key)];
    } catch (error) {
        console.error("Error loading data:", error);
        document.getElementById('no-results').textContent = `Error loading transit data: ${error.message}.`;
        throw error;
    }
}

/**
 * Retrieves origin, destination, and criteria from the URL query parameters.
 * @returns {object} An object containing origin, dest, and criteria.
 */
function getQueryParams() {
    const params = new URLSearchParams(window.location.search);
    return {
        origin: params.get('origin'),
        dest: params.get('dest'),
        criteria: params.get('criteria') || 'fastest'
    };
}

/**
 * Checks if a path exists between two nodes on a specific line using BFS.
 * Caches results to improve performance.
 */
function pathExistsOnLine(startNode, endNode, line, prevNode) {
    const cacheKey = `${startNode}-${endNode}-${line}`;
    if (pathExistsCache.has(cacheKey)) {
        return pathExistsCache.get(cacheKey);
    }
    const queue = [startNode];
    const visited = new Set([prevNode, startNode]);
    while (queue.length > 0) {
        const currentNode = queue.shift();
        if (currentNode === endNode) {
            pathExistsCache.set(cacheKey, true);
            return true;
        }
        const neighbors = connectionsData[currentNode];
        if (neighbors) {
            for (const neighborKey in neighbors) {
                if (!visited.has(neighborKey)) {
                    const connection = neighbors[neighborKey];
                    const availableLines = Array.isArray(connection.lines) ? connection.lines : [connection.lines];
                    if (availableLines.includes(line)) {
                        visited.add(neighborKey);
                        queue.push(neighborKey);
                    }
                }
            }
        }
    }
    pathExistsCache.set(cacheKey, false);
    return false;
}

/**
 * Checks if any non-manual (automated) path exists between two nodes.
 */
function nonManualPathExists(startNode, endNode, connections) {
    const queue = [startNode];
    const visited = new Set([startNode]);
    while (queue.length > 0) {
        const currentNode = queue.shift();
        if (currentNode === endNode) {
            return true;
        }
        const neighbors = connections[currentNode];
        if (neighbors) {
            for (const neighborKey in neighbors) {
                if (!visited.has(neighborKey)) {
                    const connection = neighbors[neighborKey];
                    let hasNonManualOption = false;
                    if (Array.isArray(connection.freq)) {
                        if (connection.freq.some(f => f !== 999)) {
                            hasNonManualOption = true;
                        }
                    } else {
                        if (connection.freq !== 999) {
                            hasNonManualOption = true;
                        }
                    }
                    if (hasNonManualOption) {
                        visited.add(neighborKey);
                        queue.push(neighborKey);
                    }
                }
            }
        }
    }
    return false;
}

/**
 * Finds the best path(s) between a start and end node using a Dijkstra-like algorithm.
 * @param {string} start - The starting station key.
 * @param {string} end - The destination station key.
 * @param {string} criteria - The optimization criteria ('fastest', 'mintrans', 'less-stations').
 * @returns {Array|null} An array of the best paths found, or null if no path is found.
 */
function findBestPath(start, end, criteria) {
    console.log(`Starting search from ${start} to ${end} with criteria: '${criteria}'`);
    const nonManualRouteAvailable = nonManualPathExists(start, end, connectionsData);
    console.log(`Is a non-manual alternative route available? ${nonManualRouteAvailable}`);
    const costs = {
        'less-stations': { station: 3, transfer: 10, bus: 10, bus_transfer: 15, manual: 5, manual_bus: 15, osi: 10 },
        'mintrans': { station: 3, transfer: 150, bus: 15, bus_transfer: 200, manual: 5, manual_bus: 15, osi: 150 },
        'fastest': { station: 3, transfer: 6, bus: 8, bus_transfer: 8, manual: 500, manual_bus: 500, osi: 6 }
    };
    const activeCosts = costs[criteria] || costs['fastest'];
    const pq = [{ cost: 0, path: [{ station: start, line: null }], line: null }];
    const visited = new Map();
    const solutions = [];

    const MAX_ITERATIONS = 30000;
    let iterations = 0;
    const MAX_SOLUTIONS = 5;

    while (pq.length > 0 && iterations < MAX_ITERATIONS) {
        iterations++;
        pq.sort((a, b) => a.cost - b.cost);
        const { cost, path, line: currentLine } = pq.shift();
        const currentNode = path.at(-1).station;

        if (currentNode === end) {
            solutions.push({ cost, path });
            solutions.sort((a, b) => a.cost - b.cost);
            if (solutions.length > MAX_SOLUTIONS) {
                solutions.pop();
            }
            continue;
        }

        const visitedKey = `${currentNode}-${currentLine}`;
        if (visited.has(visitedKey) && visited.get(visitedKey) <= cost) {
            continue;
        }
        visited.set(visitedKey, cost);

        const neighbors = connectionsData[currentNode];
        if (!neighbors) continue;

        const previousNode = path.length > 1 ? path.at(-2).station : null;

        for (const neighborKey in neighbors) {

            if (path.some(step => step.station === neighborKey) || neighborKey === previousNode) {
                continue;
            }

            const connection = neighbors[neighborKey];
            const availableLines = Array.isArray(connection.lines) ? connection.lines : [connection.lines];

            let linesToExplore;
            if (currentLine && availableLines.includes(currentLine)) {
                linesToExplore = [currentLine];
            } else {
                linesToExplore = availableLines;
            }

            for (const nextLine of linesToExplore) {
                let newCost = cost;
                let currentFreq;
                if (Array.isArray(connection.freq)) {
                    const lineIndex = availableLines.indexOf(nextLine);
                    currentFreq = (lineIndex !== -1) ? connection.freq[lineIndex] : connection.freq[0];
                } else {
                    currentFreq = connection.freq;
                }
                newCost += activeCosts.station;
                if (String(nextLine) === "0") {
                    newCost += activeCosts.osi;
                    if (path.length === 1) newCost -= (activeCosts.osi * 0.5);
                } else if (String(nextLine) === "1") {
                    newCost += 1;
                } else if (currentLine !== null && String(nextLine) !== String(currentLine)) {
                    const isThru = connection.flags?.includes("thru") && ((currentLine === 'CY' && nextLine === 'TN') || (currentLine === 'TN' && nextLine === 'CY'));
                    if (!isThru) {
                        const isCurrentBus = isBusRoute.has(currentLine);
                        const isNextBus = isBusRoute.has(nextLine);
                        if (isCurrentBus || isNextBus) newCost += activeCosts.bus_transfer;
                        else newCost += activeCosts.transfer;
                    }
                }
                const isNextLineBus = isBusRoute.has(nextLine);
                if (isNextLineBus) newCost += activeCosts.bus;
                if (currentFreq === 999 && nonManualRouteAvailable) {
                    if (isNextLineBus) newCost += activeCosts.manual_bus;
                    else newCost += activeCosts.manual;
                }
                if (currentLine !== null && nextLine === currentLine) {
                    if (currentLine === 'M9') newCost -= 5;
                    else newCost -= 0.5;
                }
                const newPath = [...path, { station: neighborKey, line: nextLine }];
                pq.push({ cost: newCost, path: newPath, line: nextLine });
            }
        }
    }

    if (solutions.length > 0) {
        console.log(`Found ${solutions.length} possible routes. Returning the best options.`);
        return solutions.map(s => s.path);
    }
    return null;
}

/**
 * Processes a raw path from the algorithm into a detailed object with legs, transfers, etc.
 * @param {Array} detailedPath - The raw path object from findBestPath.
 * @returns {object|null} A detailed path object or null.
 */
function calculatePathDetails(detailedPath) {
    if (!detailedPath) return null;
    const path = detailedPath.map(p => p.station);
    let transfers = 0;
    const legs = [];
    let lastRealLine = null;
    const linesUsed = new Set();
    let walks = 0;
    for (let i = 1; i < detailedPath.length; i++) {
        const fromStation = detailedPath[i - 1].station;
        const toStation = detailedPath[i].station;
        const line = detailedPath[i].line;
        const connection = connectionsData[fromStation][toStation];
        const availableLines = Array.isArray(connection.lines) ? connection.lines : [connection.lines];

        if (String(line) !== "0" && String(line) !== "1") {
            linesUsed.add(line);
        }
        let legFreq;
        if (Array.isArray(connection.freq)) {
            const lineIndex = availableLines.indexOf(line);
            legFreq = (lineIndex !== -1) ? connection.freq[lineIndex] : connection.freq[0];
        } else {
            legFreq = connection.freq;
        }
        if (String(line) === "0" || String(line) === "1") {
            lastRealLine = null;
        }
        const isThruService = !!(connection.flags?.includes("thru") && lastRealLine && ((lastRealLine === 'CY' && line === 'TN') || (lastRealLine === 'TN' && line === 'CY')));
        if (lastRealLine && line !== lastRealLine && String(line) !== "0" && String(line) !== "1" && !isThruService) {
            transfers++;
        }

        if (String(line) === "0" || String(line) === "1") {
            walks++;
        }

        legs.push({ from: fromStation, to: toStation, line: line, freq: legFreq, isThru: isThruService, availableLines: availableLines });
        if (String(line) !== "0" && String(line) !== "1") {
            lastRealLine = line;
        }
    }
    walks += transfers;
    return { rawPath: detailedPath, path, legs, transfers, stationCount: path.length, linesUsed: Array.from(linesUsed), walks };
}


/**
 * Returns a human-readable string for a given service frequency code.
 */
function getFrequencyText(freq) {
    if (freq === 0) return "Semi-Auto service, find a button nearby to request for or use warp-sign inside the service.";
    if (freq === 999) return "Manual service, request for an online driver if any.";
    return `Every ${freq} mins`;
}

/**
 * Gets the display name for a location key, with truncation for mobile.
 */
function getDisplayName(key) {
    let name = locationMap.get(key) || key;
    if (name.includes('/')) {
        name = name.split('/')[0].trim();
    }
    if (window.innerWidth <= 768) {
        name = name.replace(/\bStation\b/gi, 'Sta.');
        const MAX_LENGTH = 20;
        if (name.length > MAX_LENGTH) {
            let truncated = name.substring(0, MAX_LENGTH);
            let lastSpace = truncated.lastIndexOf(' ');
            name = (lastSpace > 0) ? truncated.substring(0, lastSpace).trim() : truncated.trim();
        }
    }
    return name;
}

/**
 * Renders the header showing origin and destination.
 */
function renderTripHeader() {
    const headerContainer = document.getElementById('trip-header');
    if (!headerContainer) return;
    const { origin, dest } = getQueryParams();
    const originName = getDisplayName(origin);
    const destName = getDisplayName(dest);
    headerContainer.innerHTML = `
        <div class="flex items-center text-lg md:text-xl font-bold text-gray-700">
            <span class="station-name">${originName}</span>
            <span class="material-symbols-outlined mx-2">arrow_forward</span>
            <span class="station-name">${destName}</span>
        </div>
    `;
}

/**
 * Renders a summary view when multiple routes are found.
 */
function renderMultipleResults(pathDetailsList) {
    const resultsContainer = document.getElementById('results-container');
    const statsContainer = document.getElementById('trip-stats');
    const noResults = document.getElementById('no-results');

    renderTripHeader();
    noResults.classList.add('hidden');
    resultsContainer.innerHTML = '';
    statsContainer.innerHTML = '';

    let html = '<h2 class="text-xl font-bold mb-4 mt-4">Recommended Routes</h2>';

    pathDetailsList.forEach((details, index) => {
        const linePills = details.linesUsed.map(lineKey => {
            const lineInfo = lineMap.get(lineKey) || { name: lineKey, color: '#cbd5e0' };
            const textColor = getContrastingTextColor(lineInfo.color);
            const icon = isBusRoute.has(lineKey) ? 'directions_bus' : 'train';
            return `<div class="route-badge-small" style="background-color: ${lineInfo.color}; color: ${textColor};">
                        <span class="material-symbols-outlined text-sm">${icon}</span>
                        <span>${lineInfo.name}</span>
                    </div>`;
        }).join('<span class="material-symbols-outlined text-gray-400">chevron_right</span>');

        html += `
            <div class="summary-card" data-path-index="${index}">
                <div class="flex-grow">
                    <div class="line-pill-sequence">${linePills}</div>
                    <div class="summary-stats">
                        <span><span class="material-symbols-outlined">tram</span> ${details.stationCount - 1} stops</span>
                        <span><span class="material-symbols-outlined">directions_walk</span> ${details.walks} walks</span>
                    </div>
                </div>
                <div class="text-gray-400">
                    <span class="material-symbols-outlined">arrow_forward_ios</span>
                </div>
            </div>
        `;
    });

    resultsContainer.innerHTML = html;

    document.querySelectorAll('.summary-card').forEach(card => {
        card.addEventListener('click', () => {
            const pathIndex = parseInt(card.getAttribute('data-path-index'));
            const selectedPathDetails = pathDetailsList[pathIndex];
            renderTrip(selectedPathDetails, false, true);
        });
    });
}

/**
 * Renders the detailed, step-by-step trip timeline.
 * @param {object} bestPathDetails - The detailed path object to render.
 * @param {boolean} isSameStation - Flag for when origin and destination are identical.
 * @param {boolean} fromSummary - Flag for when navigating from the multi-result summary view.
 */
function renderTrip(bestPathDetails, isSameStation = false, fromSummary = false) {
    const resultsContainer = document.getElementById('results-container');
    const noResults = document.getElementById('no-results');
    const statsContainer = document.getElementById('trip-stats');
    const headerContainer = document.getElementById('trip-header');
    const backButton = document.getElementById('back-button');
    resultsContainer.innerHTML = '';
    statsContainer.innerHTML = '';

    if (!isSameStation && bestPathDetails) {
        renderTripHeader();
    } else if (headerContainer) {
        headerContainer.innerHTML = '';
    }

    if (fromSummary) {
        backButton.href = '#';
        backButton.onclick = (e) => {
            e.preventDefault();
            renderMultipleResults(lastPathDetailsList);
            backButton.onclick = null;
            setInitialBackButtonHref();
        };
    } else {
        backButton.onclick = null;
        setInitialBackButtonHref();
    }

    if (isSameStation) {
        noResults.textContent = "Origin and destination are the same.";
        noResults.classList.remove('hidden');
        return;
    }
    if (!bestPathDetails) {
        noResults.textContent = `No path found from '${getQueryParams().origin}' to '${getQueryParams().dest}'.`;
        noResults.classList.remove('hidden');
        return;
    }
    noResults.classList.add('hidden');

    statsContainer.innerHTML = `
        <div class="flex items-center gap-2">
            <span class="material-symbols-outlined">tram</span>
            <span>${bestPathDetails.stationCount - 1} stops</span>
        </div>
        <div class="flex items-center gap-2">
            <span class="material-symbols-outlined">directions_walk</span>
            <span>${bestPathDetails.walks} walks</span>
        </div>
    `;

    const getLegDirection = (leg, lineKey) => {
        const termini = lineTermini[lineKey];
        if (!termini || termini[0] === termini[1]) return null;
        if (pathExistsOnLine(leg.to, termini[0], lineKey, leg.from)) {
            return termini[0];
        }
        return termini[1];
    };

    const processedSegments = [];
    if (bestPathDetails.legs.length > 0) {
        let currentRide = null;

        const getBestLine = (lines) => {
            for (const p of linePriority) {
                if (lines.includes(p)) return p;
            }
            return lines[0];
        };

        for (const leg of bestPathDetails.legs) {
            if (String(leg.line) === "0" || String(leg.line) === "1") {
                if (currentRide) processedSegments.push(currentRide);
                currentRide = null;
                processedSegments.push({ type: 'osi', from: leg.from, to: leg.to });
                continue;
            }

            const legDirection = getLegDirection(leg, leg.line);

            if (currentRide) {
                const commonLines = currentRide.commonLines.filter(line => leg.availableLines.includes(line));
                const directionChanges = currentRide.direction !== null && legDirection !== currentRide.direction;

                if (commonLines.length === 0 || directionChanges) {
                    processedSegments.push(currentRide);
                    if (processedSegments.at(-1)?.type !== 'osi') {
                        processedSegments.push({ type: 'transfer', at: currentRide.stops.at(-1) });
                    }
                    currentRide = null;
                } else {
                    currentRide.stops.push(leg.to);
                    currentRide.commonLines = commonLines;
                    currentRide.line = getBestLine(commonLines);
                    continue;
                }
            }

            if (!currentRide) {
                currentRide = {
                    type: 'ride',
                    line: getBestLine(leg.availableLines),
                    stops: [leg.from, leg.to],
                    freq: leg.freq,
                    direction: legDirection,
                    commonLines: leg.availableLines
                };
            }
        }
        if (currentRide) processedSegments.push(currentRide);
    }

    let html = '';
    processedSegments.forEach((segment, index) => {
        if (segment.type === 'ride') {
            const lineInfo = lineMap.get(segment.line) || { name: segment.line, color: '#cbd5e0' };
            const textColor = getContrastingTextColor(lineInfo.color);
            const startStation = getDisplayName(segment.stops[0]);
            const endStationKey = segment.stops.at(-1);
            let displayDestinationName;

            if (segment.direction) {
                displayDestinationName = getDisplayName(segment.direction);
            } else {
                displayDestinationName = getDisplayName(endStationKey);
            }

            const intermediateStops = segment.stops.slice(1, -1);
            const icon = isBusRoute.has(segment.line) ? 'directions_bus' : 'train';
            const freqText = getFrequencyText(segment.freq);
            let freqIcon;
            if (segment.freq === 999) freqIcon = 'support_agent';
            else if (segment.freq === 0) freqIcon = 'touch_app';
            else freqIcon = 'schedule';

            html += `<div class="timeline-item"><div class="timeline-connector"><div class="timeline-line" style="background-color: ${lineInfo.color}; top: 50%; bottom: 0;"></div><div class="timeline-dot" style="border-color: ${lineInfo.color};"></div></div><div class="timeline-content station-content"><div class="font-bold text-xl station-name">${startStation}</div></div></div>`;

            html += `<div class="timeline-item"><div class="timeline-connector"><div class="timeline-line" style="background-color: ${lineInfo.color}; top: 0; bottom: 0;"></div></div><div class="timeline-content"><div class="mb-2"><div class="route-badge" style="background-color: ${lineInfo.color}; color: ${textColor};"><span class="material-symbols-outlined text-sm">${icon}</span><span>${lineInfo.name}</span></div><span class="block md:inline md:ml-2 text-gray-600 mt-1 md:mt-0">to <span class="station-name">${displayDestinationName}</span></span><div class="text-sm text-gray-500 mt-1 flex items-center gap-1"><span class="material-symbols-outlined text-base">${freqIcon}</span><span>${freqText}</span></div></div>${intermediateStops.length > 0 ? `<div class="relative"><button class="toggle-stops text-sm text-blue-600 hover:underline my-2" data-target="stops-${index}">Show ${intermediateStops.length} intermediate stop(s) <span class="arrow font-sans">&#9662;</span></button><div id="stops-${index}" class="hidden my-2 -ml-10">${intermediateStops.map(stop => `<div class="timeline-item"><div class="timeline-connector"><div class="timeline-line" style="background-color: ${lineInfo.color}; top: 0; bottom: 0;"></div><div class="intermediate-dot" style="border-color: ${lineInfo.color};"></div></div><div class="timeline-content"><div class="text-gray-700 text-sm station-name">${getDisplayName(stop)}</div></div></div>`).join('')}</div></div>` : ''}</div></div>`;

        } else if (segment.type === 'osi' || segment.type === 'transfer') {
            const text = 'Walk';
            const icon = 'directions_walk';
            const stationName = getDisplayName(segment.at || segment.from);
            const prevRide = processedSegments[index - 1];
            const prevLineInfo = prevRide ? (lineMap.get(prevRide.line) || { name: prevRide.line, color: '#cbd5e0' }) : { color: '#cbd5e0', name: '' };

            let lineTop = (index === 0 && segment.type === 'osi') ? '50%' : '0';
            html += `<div class="timeline-item"><div class="timeline-connector"><div class="timeline-line" style="background-color: ${prevLineInfo.color}; top: ${lineTop}; bottom: 50%;"></div><div class="timeline-dot" style="border-color: ${prevLineInfo.color};"></div></div><div class="timeline-content station-content"><div class="font-bold text-xl station-name">${stationName}</div></div></div>`;

            const connectorStyle = 'border-left: 4px dashed #cbd5e0; top: -1.5rem; bottom: -1.5rem;';
            html += `<div class="timeline-item" style="min-height: 4rem;"><div class="timeline-connector"><div class="timeline-line" style="${connectorStyle}"></div></div><div class="timeline-content"><div class="flex items-center gap-2 h-full"><span class="material-symbols-outlined text-gray-600">${icon}</span><span class="font-semibold text-gray-700">${text}</span></div></div></div>`;
        }
    });

    const lastLeg = processedSegments.at(-1);
    if (lastLeg) {
        const finalStation = getDisplayName(lastLeg.stops ? lastLeg.stops.at(-1) : lastLeg.to);
        let finalLineInfo;
        if (lastLeg.type === 'ride') finalLineInfo = lineMap.get(lastLeg.line) || { color: '#cbd5e0' };
        else finalLineInfo = { color: '#cbd5e0' };
        html += `<div class="timeline-item"><div class="timeline-connector"><div class="timeline-line" style="background-color: ${finalLineInfo.color}; top: 0; bottom: 50%;"></div><div class="timeline-dot" style="border-color: ${finalLineInfo.color};"></div></div><div class="timeline-content station-content"><div class="font-bold text-xl station-name">${finalStation}</div></div></div>`;
    }

    resultsContainer.innerHTML = html;
    document.querySelectorAll('.toggle-stops').forEach(button => {
        button.addEventListener('click', () => {
            const targetId = button.getAttribute('data-target');
            const targetEl = document.getElementById(targetId);
            const arrow = button.querySelector('.arrow');
            const isHidden = targetEl.classList.contains('hidden');
            const count = targetEl.children.length;
            if (isHidden) {
                targetEl.classList.remove('hidden');
                button.childNodes[0].nodeValue = `Hide ${count} intermediate stop(s) `;
                arrow.innerHTML = '&#9652;';
            } else {
                targetEl.classList.add('hidden');
                button.childNodes[0].nodeValue = `Show ${count} intermediate stop(s) `;
                arrow.innerHTML = '&#9662;';
            }
        });
    });
}

/**
 * Sets the initial URL for the "back" button.
 */
function setInitialBackButtonHref() {
    const backButton = document.getElementById('back-button');
    const { origin, dest, criteria } = getQueryParams();
    const urlParams = new URLSearchParams(window.location.search);
    const source = urlParams.get('source');
    const queryString = `criteria=${criteria || ''}&origin=${origin || ''}&dest=${dest || ''}`;
    if (source && source.includes('limaru')) {
        backButton.href = `https://www.limaru.net/transportation?${queryString}`;
    } else if (source) {
        const separator = source.includes('?') ? '&' : '?';
        backButton.href = `${source}${separator}${queryString}`;
    } else {
        backButton.href = `../?${queryString}`;
    }
}

/**
 * Filter for removing paths with unnecessary back-and-forth walks.
 */
function filterUnnecessaryWalks(pathDetailsList) {
    if (pathDetailsList.length <= 1) return pathDetailsList;

    return pathDetailsList.filter(details => {
        for (let i = 1; i < details.legs.length; i++) {
            const prevLeg = details.legs[i - 1];
            const currentLeg = details.legs[i];

            if ((String(currentLeg.line) === "0" || String(currentLeg.line) === "1") && currentLeg.to === prevLeg.from) {
                console.log("Filtering out a route with a walk reversal:", details.path.join(' -> '));
                return false;
            }
        }
        return true;
    });
}

/**
 * Filter for removing paths that take an inefficient detour between two stations.
 */
function filterInefficientDetours(pathDetailsList, connections) {
    if (pathDetailsList.length <= 1) return pathDetailsList;

    return pathDetailsList.filter(details => {
        const pathStations = details.path;
        if (pathStations.length < 3) return true;

        for (let i = 0; i < pathStations.length - 2; i++) {
            const stationA = pathStations[i];
            const stationC = pathStations[i+2];

            if (connections[stationA] && connections[stationA][stationC]) {
                console.log(`Filtering out detour via ${pathStations[i+1]} because a direct ${stationA}->${stationC} connection exists.`);
                return false;
            }
        }
        return true;
    });
}

/**
 * Main function to orchestrate the trip planning process.
 */
async function planTrip() {
    const loading = document.getElementById('loading');
    loading.style.display = 'flex';
    loading.style.opacity = '1';

    try {
        await setupData();
        const { origin, dest, criteria } = getQueryParams();

        setInitialBackButtonHref();

        if (!origin || !dest || !locationMap.has(origin) || !locationMap.has(dest)) {
            document.getElementById('no-results').textContent = 'Please provide valid origin and destination station/stop keys in the URL query parameters (e.g., ?origin=ECL&dest=KSC).';
            document.getElementById('no-results').classList.remove('hidden');
            return;
        }
        if (origin === dest) {
            renderTrip(null, true);
            return;
        }

        const bestPaths = findBestPath(origin, dest, criteria);

        if (!bestPaths || bestPaths.length === 0) {
            renderTrip(null);
            return;
        }

        let pathDetailsList = bestPaths.map(path => calculatePathDetails(path));

        // The following filters are commented out as per the request to handle all cases "as normal".
        // This ensures that all paths found by the algorithm are considered.
        // pathDetailsList = filterUnnecessaryWalks(pathDetailsList);
        // pathDetailsList = filterInefficientDetours(pathDetailsList, connectionsData);

        if (pathDetailsList.length > 1) {
            const bestSolution = pathDetailsList[0];
            const filteredList = pathDetailsList.filter((currentSolution, index) => {
                if (index === 0) return true;

                const isMuchLonger = currentSolution.stationCount > bestSolution.stationCount * 1.5 + 3;
                const hasMoreWalks = currentSolution.walks > bestSolution.walks + 1;

                if (isMuchLonger && hasMoreWalks) {
                    console.log("Filtering out nonsensical route:", currentSolution.path.join(' -> '));
                    return false;
                }
                return true;
            });
            pathDetailsList = filteredList;
        }

        lastPathDetailsList = pathDetailsList;

        if (pathDetailsList.length > 1) {
            renderMultipleResults(pathDetailsList);
        } else if (pathDetailsList.length === 1) {
            renderTrip(pathDetailsList[0]);
        } else {
            renderTrip(null);
        }

    } catch (error) {
        console.error("Trip planning failed:", error);
        document.getElementById('no-results').textContent = `An unexpected error occurred during trip planning: ${error.message}`;
        document.getElementById('no-results').classList.remove('hidden');
    } finally {
        loading.style.opacity = '0';
        setTimeout(() => { loading.style.display = 'none'; }, 300);
    }
}

// Start the trip planning process once the DOM is loaded.
window.addEventListener('DOMContentLoaded', planTrip);