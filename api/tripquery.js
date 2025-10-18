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

        // Normalize connection lines to string keys so lookups are consistent everywhere
        for (const nodeKey in connectionsData) {
            const neighbors = connectionsData[nodeKey];
            for (const nbKey in neighbors) {
                const conn = neighbors[nbKey];
                if (conn.lines !== undefined) {
                    conn.lines = Array.isArray(conn.lines) ? conn.lines.map(String) : String(conn.lines);
                }
                // keep freq as-is (numbers or arrays of numbers)
            }
        }

        lineTermini = dataset.terminus || {};
        [...dataset.stations, ...dataset.bus_stops].forEach(s => locationMap.set(s.key, s.name));
        const allRoutes = [...dataset.routes, ...dataset.bus_routes];
        allRoutes.forEach(route => {
            const keyStr = String(route.key);
            lineMap.set(keyStr, { name: route.name, color: route.color || '#cbd5e0' });
            if (/\d/.test(keyStr)) {
                isBusRoute.add(keyStr);
            }
        });
        // ensure priority is a string array
        linePriority = [...dataset.routes.map(r => String(r.key)), ...dataset.bus_routes.map(r => String(r.key))];
    } catch (error) {
        console.error("Error loading data:", error);
        const noResultsEl = document.getElementById('no-results');
        if (noResultsEl) noResultsEl.textContent = `Error loading transit data: ${error.message}.`;
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
                    const availableLines = Array.isArray(connection.lines) ? connection.lines.map(String) : [String(connection.lines)];
                    if (availableLines.includes(String(line))) {
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
    const MAX_SOLUTIONS = 100; // Unlimited as per user request

    while (pq.length > 0 && iterations < MAX_ITERATIONS) {
        iterations++;
        pq.sort((a, b) => a.cost - b.cost);
        const { cost, path, line: currentLine } = pq.shift();
        const currentNode = path.at(-1).station;

        if (currentNode === end) {
            solutions.push({ cost, path });
            solutions.sort((a, b) => a.cost - b.cost);
            if (solutions.length >= MAX_SOLUTIONS) {
                solutions.splice(MAX_SOLUTIONS);
            }
            if (solutions.length >= MAX_SOLUTIONS && cost > solutions.at(-1).cost) {
                continue;
            }
        }

        const visitedKey = `${currentNode}-${currentLine}`;
        if (visited.has(visitedKey) && visited.get(visitedKey) <= cost) {
            continue;
        }
        if (currentNode !== end) {
            visited.set(visitedKey, cost);
        }

        const neighbors = connectionsData[currentNode];
        if (!neighbors) continue;

        const previousNode = path.length > 1 ? path.at(-2).station : null;

        for (const neighborKey in neighbors) {

            if (path.some(step => step.station === neighborKey) || neighborKey === previousNode) {
                continue;
            }

            const connection = neighbors[neighborKey];
            const availableLines = Array.isArray(connection.lines) ? connection.lines.map(String) : [String(connection.lines)];

            let linesToExplore;
            if (currentLine && availableLines.includes(String(currentLine))) {
                linesToExplore = [String(currentLine)];
            } else {
                linesToExplore = availableLines;
            }

            for (const nextLineRaw of linesToExplore) {
                const nextLine = String(nextLineRaw);
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
                        const isCurrentBus = isBusRoute.has(String(currentLine));
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
        solutions.sort((a, b) => a.cost - b.cost);
        const finalSolutions = solutions;
        console.log(`Found ${finalSolutions.length} possible routes. Returning the best options.`);
        return finalSolutions.map(s => s.path);
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
    const allLinesUsed = new Set();
    let walkSegments = 0;

    for (let i = 1; i < detailedPath.length; i++) {
        const fromStation = detailedPath[i - 1].station;
        const toStation = detailedPath[i].station;
        const lineRaw = detailedPath[i].line;
        const line = String(lineRaw);
        const connection = connectionsData[fromStation][toStation];
        const availableLines = Array.isArray(connection.lines) ? connection.lines.map(String) : [String(connection.lines)];

        // Collect all available lines for the ride segment
        if (line !== "0" && line !== "1") {
            availableLines.forEach(l => {
                if (l !== "0" && l !== "1") allLinesUsed.add(l);
            });
        }

        let legFreq;
        if (Array.isArray(connection.freq)) {
            const lineIndex = availableLines.indexOf(line);
            legFreq = (lineIndex !== -1) ? connection.freq[lineIndex] : connection.freq[0];
        } else {
            legFreq = connection.freq;
        }

        if (line === "0" || line === "1") {
            lastRealLine = null;
        }

        // --- FIX for Thru-Service in calculatePathDetails ---
        const isThruService = !!(connection.flags?.includes("thru") && lastRealLine && ((lastRealLine === 'CY' && line === 'TN') || (lastRealLine === 'TN' && line === 'CY')));

        if (lastRealLine && line !== lastRealLine && line !== "0" && line !== "1" && !isThruService) {
            transfers++;
        }

        if (line === "0" || line === "1") {
            walkSegments++;
        }

        legs.push({ from: fromStation, to: toStation, line: line, freq: legFreq, isThru: isThruService, availableLines: availableLines });

        if (line !== "0" && line !== "1") {
            lastRealLine = line;
        }
    }

    // Calculate total walks. Include 1 for final disembarkation/walk if there are any legs.
    const totalWalks = walkSegments + transfers + (legs.length > 0 ? 1 : 0);

    return { rawPath: detailedPath, path, legs, transfers, stationCount: path.length, linesUsed: Array.from(allLinesUsed), walks: totalWalks };
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
 *
 * MODIFIED: Now trims names after a '/' on mobile screens for better bus stop display.
 *
 * @param {string} key - The location key.
 * @returns {string} The display name.
 */
function getDisplayName(key) {
    let name = locationMap.get(key) || key;

    // Apply specific mobile rules
    if (window.innerWidth <= 768 && typeof name === 'string') {
        // Rule 1: If name contains '/', take only the part before it (for bus stops)
        if (name.includes('/')) {
            name = name.split('/')[0].trim();
        }

        name = name.replace(/\bStation\b/gi, 'Sta.');
        const MAX_LENGTH = 20;

        // Rule 2: Truncate longer names
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
    if (noResults) noResults.classList.add('hidden');
    if (resultsContainer) resultsContainer.innerHTML = '';
    if (statsContainer) statsContainer.innerHTML = '';

    let html = '<h2 class="text-xl font-bold mb-4 mt-4">Recommended Routes</h2>';

    pathDetailsList.forEach((details, index) => {

        let linePills;
        let lineSequence = [];
        let isWalkOnly = true;

        // Process legs to build the sequential line display (A > B > C)
        details.legs.forEach(leg => {
            const line = String(leg.line);

            if (line !== "0" && line !== "1") {
                isWalkOnly = false;

                // Use the single, actual line chosen (leg.line) for the summary sequence
                const actualLine = String(leg.line);
                const currentLineKey = actualLine;

                if (lineSequence.length === 0 || lineSequence.at(-1) !== currentLineKey) {
                    lineSequence.push(currentLineKey);
                }
            }
        });

        if (isWalkOnly) {
            linePills = `<div class="route-badge-small" style="background-color: #f7fafc; color: #000000;">
                        <span class="material-symbols-outlined text-sm">directions_walk</span>
                        <span>Walking</span>
                    </div>`;
        } else {
            // Build the sequence display (Line A > Line B > ...)
            linePills = lineSequence.map(lineKeyString => {
                const primaryLineKey = lineKeyString; // Only one line key here
                const lineInfo = lineMap.get(primaryLineKey) || { name: primaryLineKey, color: '#cbd5e0' };
                const textColor = getContrastingTextColor(lineInfo.color);

                const icon = isBusRoute.has(primaryLineKey) ? 'directions_bus' : 'train';

                return `<div class="route-badge-small" style="background-color: ${lineInfo.color}; color: ${textColor};">
                            <span class="material-symbols-outlined text-sm">${icon}</span>
                            <span>${lineInfo.name}</span>
                        </div>`;
            }).join('<span class="material-symbols-outlined text-gray-400">chevron_right</span>');
        }

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

    if (resultsContainer) resultsContainer.innerHTML = html;

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
    if (resultsContainer) resultsContainer.innerHTML = '';
    if (statsContainer) statsContainer.innerHTML = '';

    if (!isSameStation && bestPathDetails) {
        renderTripHeader();
    } else if (headerContainer) {
        headerContainer.innerHTML = '';
    }

    // If coming from summary, force a hard refresh (reload current URL).
    if (backButton) {
        backButton.onclick = null; // Ensure the link works as a normal href
        if (fromSummary) {
            // Set the href to the current URL path + search params to force a full reload and re-render the summary
            backButton.href = window.location.pathname + window.location.search;
        } else {
            // Default behavior for going back to the search root (if not from a summary)
            setInitialBackButtonHref();
        }
    }

    if (isSameStation) {
        if (noResults) {
            noResults.textContent = "Origin and destination are the same.";
        }
        return;
    }
    if (!bestPathDetails) {
        if (noResults) {
            noResults.textContent = `No path found from '${getQueryParams().origin}' to '${getQueryParams().dest}'.`;
        }
        return;
    }
    if (noResults) noResults.classList.add('hidden');

    if (statsContainer) statsContainer.innerHTML = `
        <div class="flex items-center gap-2">
            <span class="material-symbols-outlined">tram</span>
            <span>${bestPathDetails.stationCount - 1} stops</span>
        </div>
        <div class="flex items-center gap-2">
            <span class="material-symbols-outlined">directions_walk</span>
            <span>${bestPathDetails.walks} walks</span>
        </div>
    `;

    /**
     * Determines the terminus (destination) of a ride segment based on the line and direction.
     * @param {string} lineKey - The line key (e.g., 'TK').
     * @param {string} startNode - The starting station of the segment.
     * @param {string} endNode - The ending station of the segment.
     * @returns {string|null} The terminus key or null.
     */
    const getSegmentTerminus = (lineKey, startNode, endNode) => {
        const termini = lineTermini[lineKey];
        if (!termini || termini.length < 2 || termini[0] === termini[1]) return null;

        // Check which terminus is reachable from the end of the segment on this specific line
        // Using the start node as prevNode for pathExistsOnLine is critical for direction
        if (pathExistsOnLine(endNode, termini[0], lineKey, startNode)) {
            return termini[0];
        } else if (pathExistsOnLine(endNode, termini[1], lineKey, startNode)) {
            return termini[1];
        }
        return null;
    };

    const processedSegments = [];
    if (bestPathDetails.legs.length > 0) {
        let currentRide = null;
        let currentRideTerminus = null;

        for (const leg of bestPathDetails.legs) {
            const nextLine = String(leg.line);

            // Handle non-ride segments (walks/OSI)
            if (nextLine === "0" || nextLine === "1") {
                if (currentRide) processedSegments.push(currentRide);
                currentRide = null;
                currentRideTerminus = null;
                processedSegments.push({ type: 'osi', from: leg.from, to: leg.to, at: leg.to });
                continue;
            }

            const nextTerminus = getSegmentTerminus(nextLine, leg.from, leg.to);

            if (currentRide) {
                const isThru = leg.isThru; // Property from calculatePathDetails
                const continuesSameRide = currentRide.line === nextLine && currentRideTerminus === nextTerminus;

                if (continuesSameRide) {
                    // The ride continues on the same line and in the same direction.
                    currentRide.stops.push(leg.to);
                    continue;
                } else {
                    // The ride breaks. End the current ride segment.
                    processedSegments.push(currentRide);

                    // Check if the break is a thru-service or a regular transfer.
                    if (isThru) {
                        // It's a thru-service, where the passenger stays on the vehicle.
                        processedSegments.push({ type: 'thru_continue', at: currentRide.stops.at(-1) });
                    } else {
                        // It's a regular transfer requiring a walk.
                        processedSegments.push({ type: 'transfer', at: currentRide.stops.at(-1) });
                    }

                    // Reset to start a new ride segment in the next part of the loop.
                    currentRide = null;
                    currentRideTerminus = null;
                }
            }

            // Start a new ride segment if there isn't an active one.
            if (!currentRide) {
                currentRide = {
                    type: 'ride',
                    line: nextLine,
                    stops: [leg.from, leg.to],
                    freq: leg.freq,
                    availableLines: leg.availableLines
                };
                currentRideTerminus = nextTerminus; // Set the terminus for the new segment
            }
        }
        if (currentRide) processedSegments.push(currentRide);
    }

    const finalSegments = [];
    for (let i = 0; i < processedSegments.length; i++) {
        const segment = processedSegments[i];

        if (segment.type === 'transfer' || segment.type === 'osi') {
            const prev = finalSegments.at(-1);
            const next = processedSegments[i + 1];

            if (prev && prev.type === 'ride' && next && next.type === 'ride' && prev.stops.at(-1) === next.stops[0]) {
                finalSegments.push({ type: 'walk', at: segment.at });
                continue;
            }
        }

        finalSegments.push(segment);
    }

    let html = '';
    let skipNextStationRender = false;

    finalSegments.forEach((segment, index) => {

        let primaryColor = '#cbd5e0';
        let prevLineColor = '#cbd5e0';

        let prevSegment = finalSegments[index - 1];
        let nextSegment = finalSegments[index + 1];

        if (segment.type === 'ride') {
            const actualLineInfo = lineMap.get(segment.line) || { color: '#cbd5e0' };
            primaryColor = actualLineInfo.color;
        }

        if (prevSegment && prevSegment.type === 'ride') {
            prevLineColor = (lineMap.get(prevSegment.line) || { color: '#cbd5e0' }).color;
        }

        if (segment.type === 'thru_continue') {
            let nextLineColor = '#cbd5e0';
            if (nextSegment && nextSegment.type === 'ride') {
                nextLineColor = (lineMap.get(nextSegment.line) || { color: '#cbd5e0' }).color;
            }
            const stationName = getDisplayName(segment.at);

            html += `<div class="timeline-item">
                        <div class="timeline-connector">
                            <div class="timeline-line" style="background-color: ${prevLineColor}; top: 0; height: 50%;"></div>
                            <div class="timeline-line" style="background-color: ${nextLineColor}; top: 50%; height: 50%;"></div>
                        </div>
                        <div class="timeline-content">
                             <div class="font-bold text-xl station-name pl-4 mt-4">${stationName}</div>
                            <div class="italic text-gray-600 my-2 pl-4">Continue on the same vehicle</div>
                        </div>
                    </div>`;
            skipNextStationRender = true;
        }

        else if (segment.type === 'ride') {

            const rideStartStationKey = segment.stops[0];
            const rideStartStationName = getDisplayName(rideStartStationKey);
            const rideEndStation = segment.stops.at(-1);
            const intermediateStops = segment.stops.slice(1, -1);
            const freqText = getFrequencyText(segment.freq);
            let freqIcon;
            if (segment.freq === 999) freqIcon = 'support_agent';
            else if (segment.freq === 0) freqIcon = 'touch_app';
            else freqIcon = 'schedule';

            if (index === 0 || !skipNextStationRender) {
                html += `<div class="timeline-item"><div class="timeline-connector"><div class="timeline-line" style="background-color: ${primaryColor}; top: 50%; bottom: 0;"></div><div class="timeline-dot" style="border-color: ${primaryColor};"></div></div><div class="timeline-content station-content"><div class="font-bold text-xl station-name">${rideStartStationName}</div></div></div>`;
            }

            skipNextStationRender = false;

            const linesToDisplay = segment.availableLines.filter(lineKey => String(lineKey) === segment.line);

            const individualLineHtml = linesToDisplay.map(lineKeyRaw => {
                const lineKey = String(lineKeyRaw);
                const lineInfo = lineMap.get(lineKey) || { name: lineKey, color: '#cbd5e0' };
                const textColor = getContrastingTextColor(lineInfo.color);
                const icon = isBusRoute.has(lineKey) ? 'directions_bus' : 'train';

                let displayDestinationName = getDisplayName(rideEndStation);
                let calculatedTerminus = null;

                const termini = lineTermini[lineKey];
                if (termini && termini.length === 2 && termini[0] !== termini[1]) {
                    if (pathExistsOnLine(rideEndStation, termini[0], lineKey, rideStartStationKey)) {
                        calculatedTerminus = termini[0];
                    } else if (pathExistsOnLine(rideEndStation, termini[1], lineKey, rideStartStationKey)) {
                        calculatedTerminus = termini[1];
                    }
                } else if (termini && termini.length === 1) {
                    calculatedTerminus = termini[0];
                }

                if (calculatedTerminus) {
                    displayDestinationName = getDisplayName(calculatedTerminus);
                }

                const isMobile = window.innerWidth <= 768;
                const breakTag = isMobile ? '<br>' : '';

                return `
                    <div class="mb-1">
                        <div class="route-badge-small mb-1" style="background-color: ${lineInfo.color}; color: ${textColor};">
                            <span class="material-symbols-outlined text-sm">${icon}</span>
                            <span>${lineInfo.name}</span>
                        </div>
                        ${breakTag}
                        <span class="text-sm text-gray-700 ml-2">to <span class="font-semibold station-name">${displayDestinationName}</span></span>
                    </div>
                `;
            }).join('');

            html += `<div class="timeline-item"><div class="timeline-connector"><div class="timeline-line" style="background-color: ${primaryColor}; top: 0; bottom: 0;"></div></div><div class="timeline-content"><div class="mb-2">${individualLineHtml}</div><div class="text-sm text-gray-500 mt-1 flex items-center gap-1"><span class="material-symbols-outlined text-base">${freqIcon}</span><span>${freqText}</span></div>${intermediateStops.length > 0 ? `<div class="relative"><button class="toggle-stops text-sm text-blue-600 hover:underline my-2" data-target="stops-${index}">Show ${intermediateStops.length} intermediate stop(s) <span class="arrow font-sans">&#9662;</span></button><div id="stops-${index}" class="hidden my-2 -ml-10">${intermediateStops.map(stop => `<div class="timeline-item"><div class="timeline-connector"><div class="timeline-line" style="background-color: ${primaryColor}; top: 0; bottom: 0;"></div><div class="intermediate-dot" style="border-color: ${primaryColor};"></div></div><div class="timeline-content"><div class="text-gray-700 text-sm station-name">${getDisplayName(stop)}</div></div></div>`).join('')}</div></div>` : ''}</div></div>`;


        } else if (segment.type === 'osi' || segment.type === 'transfer' || segment.type === 'walk') {

            const isTrueOSI = (segment.type === 'osi' || segment.type === 'walk') && segment.from !== segment.to;
            const text = 'Walk';
            const icon = 'directions_walk';

            let nextLineColor = nextSegment && nextSegment.type === 'ride' ? (lineMap.get(nextSegment.line) || { color: '#cbd5e0' }).color : '#cbd5e0';
            let incomingLineColor = prevLineColor;
            let dotBorderColor = prevLineColor;
            let renderArrivalStation = true;
            const isPrevSegmentWalkType = prevSegment && (prevSegment.type === 'osi' || prevSegment.type === 'transfer' || prevSegment.type === 'walk');

            if (isPrevSegmentWalkType) {
                incomingLineColor = '#cbd5e0';
                dotBorderColor = '#cbd5e0';
                if (prevSegment.to === segment.from) {
                    renderArrivalStation = false;
                }
            }

            const isFinalSegment = index === finalSegments.length - 1;
            const lineBottom = isFinalSegment ? '50%' : '0%';
            const lineTop = (index === 0) ? '50%' : '0';


            if (isTrueOSI) {
                if(renderArrivalStation) {
                    html += `<div class="timeline-item"><div class="timeline-connector"><div class="timeline-line" style="background-color: ${incomingLineColor}; top: ${lineTop}; bottom: 50%;"></div><div class="timeline-dot" style="border-color: ${dotBorderColor};"></div></div><div class="timeline-content station-content"><div class="font-bold text-xl station-name">${getDisplayName(segment.from)}</div></div></div>`;
                }
                const connectorStyle = 'border-left: 4px dashed #cbd5e0; top: -1.5rem; bottom: -1.5rem;';
                html += `<div class="timeline-item" style="min-height: 4rem;"><div class="timeline-connector"><div class="timeline-line" style="${connectorStyle}"></div></div><div class="timeline-content"><div class="flex items-center gap-2 h-full"><span class="material-symbols-outlined text-gray-600">${icon}</span><span class="font-semibold text-gray-700">${text}</span></div></div></div>`;
                html += `<div class="timeline-item"><div class="timeline-connector"><div class="timeline-line" style="background-color: ${nextLineColor}; top: 50%; bottom: ${lineBottom};"></div><div class="timeline-dot" style="border-color: ${nextLineColor};"></div></div><div class="timeline-content station-content"><div class="font-bold text-xl station-name">${getDisplayName(segment.to)}</div></div></div>`;
                skipNextStationRender = true;

            } else {
                const stationKey = segment.at || segment.from;
                const stationName = getDisplayName(stationKey);

                if(renderArrivalStation) {
                    html += `<div class="timeline-item"><div class="timeline-connector"><div class="timeline-line" style="background-color: ${incomingLineColor}; top: ${lineTop}; bottom: 50%;"></div><div class="timeline-dot" style="border-color: ${dotBorderColor};"></div></div><div class="timeline-content station-content"><div class="font-bold text-xl station-name">${stationName}</div></div></div>`;
                }

                const connectorStyle = 'border-left: 4px dashed #cbd5e0; top: -1.5rem; bottom: -1.5rem;';
                html += `<div class="timeline-item" style="min-height: 4rem;"><div class="timeline-connector"><div class="timeline-line" style="${connectorStyle}"></div></div><div class="timeline-content"><div class="flex items-center gap-2 h-full"><span class="material-symbols-outlined text-gray-600">${icon}</span><span class="font-semibold text-gray-700">${text}</span></div></div></div>`;
                html += `<div class="timeline-item"><div class="timeline-connector"><div class="timeline-line" style="background-color: ${nextLineColor}; top: 50%; bottom: ${lineBottom};"></div><div class="timeline-dot" style="border-color: ${nextLineColor};"></div></div><div class="timeline-content station-content"><div class="font-bold text-xl station-name">${stationName}</div></div></div>`;
                skipNextStationRender = true;
            }
        }
    });

    const lastLeg = finalSegments.at(-1);
    const finalDestinationKey = getQueryParams().dest;

    const lastSegmentKey = lastLeg ? (lastLeg.type === 'ride' ? lastLeg.stops.at(-1) : lastLeg.to || lastLeg.at) : null;
    const isLastSegmentWalkType = lastLeg && (lastLeg.type === 'osi' || lastLeg.type === 'transfer' || lastLeg.type === 'walk' || lastLeg.type === 'thru_continue');
    const isFinalStationAlreadyRendered = isLastSegmentWalkType && lastSegmentKey === finalDestinationKey;

    if (!isFinalStationAlreadyRendered && lastLeg) {
        const finalStation = getDisplayName(lastSegmentKey);
        let finalLineColor = '#cbd5e0';

        if (lastLeg.type === 'ride') {
            const actualLineInfo = lineMap.get(lastLeg.line) || { color: '#cbd5e0' };
            finalLineColor = actualLineInfo.color;
        }

        html += `<div class="timeline-item"><div class="timeline-connector"><div class="timeline-line" style="background-color: ${finalLineColor}; top: 0; bottom: 50%;"></div><div class="timeline-dot" style="border-color: ${finalLineColor};"></div></div><div class="timeline-content station-content"><div class="font-bold text-xl station-name">${finalStation}</div></div></div>`;
    }


    if (resultsContainer) resultsContainer.innerHTML = html;
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
    if (!backButton) return;

    // Set the base URL for the 'back' action, ensuring it includes the path back to the parent directory or domain root.
    if (source && source.includes('limaru')) {
        backButton.href = `https://www.limaru.net/transportation?${queryString}`;
    } else if (source) {
        const separator = source.includes('?') ? '&' : '?';
        backButton.href = `${source}${separator}${queryString}`;
    } else {
        // This is the default case for reloading the search on the main index page
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
    if (loading) {
        loading.style.display = 'flex';
        loading.style.opacity = '1';
    }

    try {
        await setupData();
        const { origin, dest, criteria } = getQueryParams();

        setInitialBackButtonHref();

        if (!origin || !dest || !locationMap.has(origin) || !locationMap.has(dest)) {
            const noRes = document.getElementById('no-results');
            if (noRes) {
                noRes.textContent = 'Please provide valid origin and destination station/stop keys in the URL query parameters (e.g., ?origin=ECL&dest=KSC).';
                noRes.classList.remove('hidden');
            }
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

        // The following filters are commented out as per the original snippet and will remain so.
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

        // Display all viable routes (up to MAX_SOLUTIONS = 100)
        lastPathDetailsList = pathDetailsList;

        // **Filter identical paths for summary view**
        if (lastPathDetailsList.length > 1) {
            const firstPath = lastPathDetailsList[0];

            // Create a simplified "signature" for comparison
            // Signature uses the single actual line (leg.line) for redundancy check
            const getPathSignature = (details) => {
                const lineSequence = [];
                details.legs.forEach(leg => {
                    const line = String(leg.line);
                    if (line !== "0" && line !== "1" && lineSequence.at(-1) !== line) {
                        lineSequence.push(line);
                    } else if (line === "0" || line === "1") {
                        // Use a placeholder for walk/osi segments to ensure sequence matches
                        if (lineSequence.at(-1) !== 'WALK') {
                            lineSequence.push('WALK');
                        }
                    }
                });
                return `${details.stationCount}:${details.walks}:${lineSequence.join('>')}`;
            };

            const firstSignature = getPathSignature(firstPath);
            const allIdentical = lastPathDetailsList.every(path => getPathSignature(path) === firstSignature);

            if (allIdentical) {
                lastPathDetailsList = [firstPath]; // Filter down to one
                console.log("All remaining routes are identical in summary metrics. Displaying only one route.");
            }
        }

        if (lastPathDetailsList.length > 1) {
            renderMultipleResults(lastPathDetailsList);
        } else if (lastPathDetailsList.length === 1) {
            renderTrip(lastPathDetailsList[0]);
        } else {
            renderTrip(null);
        }

    } catch (error) {
        console.error("Trip planning failed:", error);
        const noRes = document.getElementById('no-results');
        if (noRes) {
            noRes.textContent = `An unexpected error occurred during trip planning: ${error.message}`;
            noRes.classList.remove('hidden');
        }
    } finally {
        const loadingEl = document.getElementById('loading');
        if (loadingEl) {
            loading.style.opacity = '0';
            setTimeout(() => { loadingEl.style.display = 'none'; }, 300);
        }
    }
}

// Start the trip planning process once the DOM is loaded.
window.addEventListener('DOMContentLoaded', planTrip);

// Version information - placed at the bottommost
const version = "Canary 2.1.3";
document.getElementById('version').innerHTML = version;

