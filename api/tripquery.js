const DATASET_URL = '../api/dataset.json';
const DATANODES_URL = '../api/datanodes.json';

const locationMap = new Map();
const lineMap = new Map();
const isBusRoute = new Set();
let connectionsData = {};
let linePriority = [];
const destinationCache = new Map();

// --- Hardcoded Line Termini ---
const lineTermini = {
    'ILL': ['POH', 'YJJ'], 'EW': ['YJJ', 'TWF'], 'KM': ['RSN', 'PPL'],
    'LP': ['KSC', 'MSV'], 'LPB': ['LJN', 'LCT'], 'NK': ['TWE', 'KCN'],
    'TN': ['PLJ', 'PPL'], 'TNE': ['KMT', 'PPL'], 'CY': ['PPL', 'EPR'],
    'QY': ['KSR', 'LGH'], 'TK': ['FHL', 'MFL'], 'KK': ['STN', 'SMY'],
    'M1': ['0033', '0021'], 'M6': ['0033', '0043'], 'M7': ['0038', '0043'],
    'M9': ['0020', '0026'], 'L41': ['0023', '0010'], 'E17': ['0029', '0014']
};

function getContrastingTextColor(hexcolor) {
    if (!hexcolor) return '#000000';
    const r = parseInt(hexcolor.substr(1, 2), 16);
    const g = parseInt(hexcolor.substr(3, 2), 16);
    const b = parseInt(hexcolor.substr(5, 2), 16);
    const yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
    return (yiq >= 128) ? '#000000' : '#FFFFFF';
}

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

        [...dataset.stations, ...dataset.bus_stops].forEach(s => locationMap.set(s.key, s.name));
        [...dataset.routes, ...dataset.bus_routes].forEach(r => lineMap.set(r.key, { name: r.name, color: r.color || '#cccccc' }));
        dataset.bus_routes.forEach(r => isBusRoute.add(r.key));
        linePriority = [...dataset.routes.map(r => r.key), ...dataset.bus_routes.map(r => r.key)];
    } catch (error) {
        console.error("Error loading data:", error);
        document.getElementById('no-results').textContent = `Error loading transit data: ${error.message}.`;
        throw error;
    }
}

function getQueryParams() {
    const params = new URLSearchParams(window.location.search);
    return {
        origin: params.get('origin'),
        dest: params.get('dest'),
        criteria: params.get('criteria') || 'fastest' // Default to 'fastest'
    };
}

// --- HELPER to check path existence for determining direction ---
function pathExistsOnLine(startNode, endNode, line, prevNode) {
    const queue = [startNode];
    const visited = new Set([prevNode, startNode]);

    while(queue.length > 0) {
        const currentNode = queue.shift();
        if (currentNode === endNode) return true;

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
    return false;
}

function findBestPath(start, end, criteria) {
    console.log(`Starting search from ${start} to ${end} with criteria: '${criteria}'`);

    const costs = {
        'less-stations': { station: 3, transfer: 10, bus: 10, bus_transfer: 15, manual: 5, manual_bus: 15, osi: 10 },
        'mintrans': { station: 3, transfer: 150, bus: 15, bus_transfer: 200, manual: 5, manual_bus: 15, osi: 150 },
        'fastest': { station: 3, transfer: 6, bus: 8, bus_transfer: 8, manual: 500, manual_bus: 500, osi: 6 }
    };

    const activeCosts = costs[criteria] || costs['fastest'];
    console.log("Using cost profile:", activeCosts);

    const pq = [{ cost: 0, path: [{ station: start, line: null }], line: null }];
    const visited = new Map();
    const solutions = [];

    const MAX_ITERATIONS = 20000;
    let iterations = 0;

    while (pq.length > 0 && iterations < MAX_ITERATIONS) {
        iterations++;
        pq.sort((a, b) => a.cost - b.cost);
        const { cost, path, line: currentLine } = pq.shift();
        const currentNode = path.at(-1).station;

        if (solutions.length > 0 && cost > solutions[0].cost * 1.5) {
            continue;
        }

        if (currentNode === end) {
            console.log(`%cSolution found! (Cost: ${cost})`, 'color: green;', path.map(p => p.station).join(' -> '));
            solutions.push({ cost, path });
            solutions.sort((a, b) => a.cost - b.cost);
            if (solutions.length > 10) {
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

        if (!neighbors) {
            console.warn(`No neighbors found for node: ${currentNode}`);
            continue;
        }

        for (const neighborKey in neighbors) {
            const connection = neighbors[neighborKey];
            const availableLines = Array.isArray(connection.lines) ? connection.lines : [connection.lines];

            for (const nextLine of availableLines) {
                let newCost = cost;
                const stepBreakdown = [`From ${currentNode} to ${neighborKey} on line ${nextLine}`];

                let currentFreq;
                if (Array.isArray(connection.freq)) {
                    const lineIndex = availableLines.indexOf(nextLine);
                    currentFreq = (lineIndex !== -1) ? connection.freq[lineIndex] : connection.freq[0];
                } else {
                    currentFreq = connection.freq;
                }

                newCost += activeCosts.station;
                stepBreakdown.push(`+${activeCosts.station} (station)`);

                if (String(nextLine) === "0") { // Normal OSI walk
                    newCost += activeCosts.osi;
                    stepBreakdown.push(`+${activeCosts.osi} (OSI)`);
                    if (path.length === 1) {
                        newCost -= (activeCosts.osi * 0.5); // 50% discount on initial walk
                        stepBreakdown.push(`-${activeCosts.osi * 0.5} (Initial walk bonus)`);
                    }
                } else if (String(nextLine) === "1") { // Special walk with unique cost
                    newCost += 1; // Add the special cost of 1 as requested
                    stepBreakdown.push(`+1 (special walk)`);
                } else if (currentLine !== null && String(nextLine) !== String(currentLine)) {
                    const isThru = connection.flags?.includes("thru") &&
                        ((currentLine === 'CY' && nextLine === 'TN') ||
                            (currentLine === 'TN' && nextLine === 'CY'));

                    if (!isThru) {
                        const isCurrentBus = isBusRoute.has(currentLine);
                        const isNextBus = isBusRoute.has(nextLine);
                        if (isCurrentBus || isNextBus) {
                            newCost += activeCosts.bus_transfer;
                            stepBreakdown.push(`+${activeCosts.bus_transfer} (bus transfer)`);
                        } else {
                            newCost += activeCosts.transfer;
                            stepBreakdown.push(`+${activeCosts.transfer} (train transfer)`);
                        }
                    } else {
                        stepBreakdown.push(`+0 (thru-service)`);
                    }
                }

                const isNextLineBus = isBusRoute.has(nextLine);
                if (isNextLineBus) {
                    newCost += activeCosts.bus;
                    stepBreakdown.push(`+${activeCosts.bus} (bus route)`);
                }

                if (currentFreq === 999) {
                    if (isNextLineBus) {
                        newCost += activeCosts.manual_bus;
                        stepBreakdown.push(`+${activeCosts.manual_bus} (manual bus)`);
                    } else {
                        newCost += activeCosts.manual;
                        stepBreakdown.push(`+${activeCosts.manual} (manual train)`);
                    }
                }

                if (currentLine !== null && nextLine === currentLine) {
                    if (currentLine === 'M9') {
                        newCost -= 5;
                        stepBreakdown.push('-5 (M9 continuity bonus)');
                    } else {
                        newCost -= 0.5;
                        stepBreakdown.push('-0.5 (continuity bonus)');
                    }
                }

                const newPath = [...path, { station: neighborKey, line: nextLine }];
                pq.push({ cost: newCost, path: newPath, line: nextLine });
            }
        }
    }

    if (iterations >= MAX_ITERATIONS) {
        console.warn("Search terminated after reaching maximum iterations.");
    }

    if (solutions.length > 0) {
        console.log(`Found ${solutions.length} possible routes. Selecting the best one.`, solutions);
        return solutions[0].path;
    }

    console.log("No path found after exhaustive search.");
    return null;
}

function calculatePathDetails(detailedPath) {
    if (!detailedPath) return null;

    const path = detailedPath.map(p => p.station);
    let transfers = 0;
    const legs = [];
    let lastRealLine = null;

    for (let i = 1; i < detailedPath.length; i++) {
        const fromStation = detailedPath[i-1].station;
        const toStation = detailedPath[i].station;
        const line = detailedPath[i].line;
        const connection = connectionsData[fromStation][toStation];

        let legFreq;
        if (Array.isArray(connection.freq)) {
            const availableLines = Array.isArray(connection.lines) ? connection.lines : [connection.lines];
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

        legs.push({
            from: fromStation,
            to: toStation,
            line: line,
            freq: legFreq,
            isThru: isThruService
        });

        if (String(line) !== "0" && String(line) !== "1") {
            lastRealLine = line;
        }
    }

    return { path, legs, transfers, stationCount: path.length };
}


function getFrequencyText(freq) {
    if (freq === 0) return "Semi-Auto service, find a button nearby to request for or use warp-sign inside the service.";
    if (freq === 999) return "Manual service, request for an online driver if any.";
    return `Every ${freq} mins`;
}

function getDisplayName(key) {
    let name = locationMap.get(key) || key;
    name = name.replace(/\bStation\b/gi, 'Sta.');

    if (name.includes('/')) {
        name = name.split('/')[0].trim();
    }

    const MAX_LENGTH = 20;
    if (name.length > MAX_LENGTH) {
        let truncated = name.substring(0, MAX_LENGTH);
        let lastSpace = truncated.lastIndexOf(' ');

        if (lastSpace > 0) {
            name = truncated.substring(0, lastSpace).trim() + '...';
        } else {
            name = truncated.trim() + '...';
        }
    }

    return name;
}

function renderTrip(bestPathDetails, isSameStation = false) {
    const resultsContainer = document.getElementById('results-container');
    const noResults = document.getElementById('no-results');
    const statsContainer = document.getElementById('trip-stats');
    resultsContainer.innerHTML = '';
    statsContainer.innerHTML = '';

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
            <span class="material-symbols-outlined">transfer_within_a_station</span>
            <span>${bestPathDetails.transfers} transfers</span>
        </div>
    `;

    const processedSegments = [];
    if (bestPathDetails.legs.length > 0) {
        let currentRide = null;
        for (let i = 0; i < bestPathDetails.legs.length; i++) {
            const leg = bestPathDetails.legs[i];
            if (String(leg.line) === "0" || String(leg.line) === "1") {
                if (currentRide) processedSegments.push(currentRide);
                currentRide = null;
                processedSegments.push({ type: 'osi', from: leg.from, to: leg.to });
            } else {
                if (leg.isThru && currentRide) {
                    processedSegments.push(currentRide);
                    processedSegments.push({ type: 'thru', at: leg.from, fromLine: currentRide.line, toLine: leg.line });
                    currentRide = { type: 'ride', line: leg.line, stops: [leg.from, leg.to], freq: leg.freq, isThruEntry: true };
                } else if (!currentRide || currentRide.line !== leg.line) {
                    if (currentRide) {
                        processedSegments.push(currentRide);
                        if (processedSegments.at(-1)?.type !== 'osi') {
                            processedSegments.push({ type: 'transfer', at: currentRide.stops.at(-1) });
                        }
                    }
                    currentRide = { type: 'ride', line: leg.line, stops: [leg.from, leg.to], freq: leg.freq, isThruEntry: leg.isThru };
                } else {
                    currentRide.stops.push(leg.to);
                }
            }
        }
        if (currentRide) processedSegments.push(currentRide);
    }

    let html = '';
    const finalDestinationKey = getQueryParams().dest;

    processedSegments.forEach((segment, index) => {
        if (segment.type === 'ride') {
            const lineInfo = lineMap.get(segment.line) || { name: segment.line, color: '#cccccc' };
            const textColor = getContrastingTextColor(lineInfo.color);
            const startStation = getDisplayName(segment.stops[0]);
            const endStationKey = segment.stops.at(-1);

            let displayDestinationName;
            const nextSegment = processedSegments[index + 1];
            const lineKey = String(segment.line).trim();
            const termini = lineTermini[lineKey];

            if (nextSegment && nextSegment.type === 'thru' && segment.line === nextSegment.fromLine) {
                displayDestinationName = getDisplayName(nextSegment.at);
            } else if (termini) {
                const startNode = segment.stops[0];
                const nextNode = segment.stops[1];
                let terminusKey;
                if (pathExistsOnLine(nextNode, termini[0], lineKey, startNode)) {
                    terminusKey = termini[0];
                } else {
                    terminusKey = termini[1];
                }
                displayDestinationName = getDisplayName(terminusKey);
            } else {
                displayDestinationName = getDisplayName(endStationKey);
            }

            const intermediateStops = segment.stops.slice(1, -1);
            let icon;
            if (segment.freq === 999) {
                icon = 'support_agent'; // Icon for requesting a driver
            } else if (segment.freq === 0) {
                icon = 'touch_app';     // Icon for semi-auto service (press a button)
            } else {
                icon = isBusRoute.has(segment.line) ? 'directions_bus' : 'train'; // Default logic
            }
            const freqText = getFrequencyText(segment.freq);

            if (!segment.isThruEntry) {
                html += `<div class="timeline-item">
                            <div class="timeline-connector">
                                <div class="timeline-line" style="background-color: ${lineInfo.color}; top: 50%; bottom: 0;"></div>
                                <div class="timeline-dot" style="border-color: ${lineInfo.color};"></div>
                            </div>
                            <div class="timeline-content station-content"><div class="font-bold text-xl station-name">${startStation}</div></div>
                         </div>`;
            }

            html += `<div class="timeline-item">
                        <div class="timeline-connector">
                            <div class="timeline-line" style="background-color: ${lineInfo.color}; top: 0; bottom: 0;"></div>
                        </div>
                        <div class="timeline-content">
                            <div class="mb-2">
                                <div class="route-badge" style="background-color: ${lineInfo.color}; color: ${textColor};">
                                    <span class="material-symbols-outlined text-sm">${icon}</span>
                                    <span>${lineInfo.name}</span>
                                </div>
                                <span class="block md:inline md:ml-2 text-gray-600 mt-1 md:mt-0">to <span class="station-name">${displayDestinationName}</span></span>
                                <div class="text-sm text-gray-500 mt-1 flex items-center gap-1">
                                    <span class="material-symbols-outlined text-base">schedule</span>
                                    <span>${freqText}</span>
                                </div>
                            </div>
                            ${intermediateStops.length > 0 ? `
                            <div class="relative">
                                <button class="toggle-stops text-sm text-blue-600 hover:underline my-2" data-target="stops-${index}">
                                    Show ${intermediateStops.length} intermediate stop(s) <span class="arrow font-sans">&#9662;</span>
                                </button>
                                <div id="stops-${index}" class="hidden my-2 -ml-10">
                                    ${intermediateStops.map(stop => `
                                        <div class="timeline-item">
                                            <div class="timeline-connector">
                                                <div class="timeline-line" style="background-color: ${lineInfo.color}; top: 0; bottom: 0;"></div>
                                                <div class="intermediate-dot" style="border-color: ${lineInfo.color};"></div>
                                            </div>
                                            <div class="timeline-content"><div class="text-gray-700 text-sm station-name">${getDisplayName(stop)}</div></div>
                                        </div>
                                    `).join('')}
                                </div>
                            </div>
                            ` : ''}
                        </div>
                    </div>`;

        } else if (segment.type === 'osi' || segment.type === 'transfer' || segment.type === 'thru') {
            const isThru = segment.type === 'thru';
            const text = isThru ? 'Continue on the same vehicle' : 'Walk';
            const icon = isThru ? '' : 'directions_walk';
            const stationName = getDisplayName(segment.at || segment.from);

            const prevRide = processedSegments[index - 1];
            const prevLineInfo = prevRide ? (lineMap.get(prevRide.line) || { name: prevRide.line, color: '#cccccc' }) : { color: '#cbd5e0', name: '' };
            const nextLineInfo = isThru ? (lineMap.get(segment.toLine) || { color: '#cbd5e0', name: '' }) : { color: '#cbd5e0', name: '' };

            if (!isThru) {
                let lineTop = (index === 0 && segment.type === 'osi') ? '50%' : '0';
                html += `<div class="timeline-item">
                            <div class="timeline-connector">
                                <div class="timeline-line" style="background-color: ${prevLineInfo.color}; top: ${lineTop}; bottom: 50%;"></div>
                                <div class="timeline-dot" style="border-color: ${prevLineInfo.color};"></div>
                            </div>
                            <div class="timeline-content station-content"><div class="font-bold text-xl station-name">${stationName}</div></div>
                         </div>`;
            }

            const connectorStyle = isThru ?
                `background: linear-gradient(${prevLineInfo.color}, ${nextLineInfo.color}); top: -1.5rem; bottom: -1.5rem;` :
                'border-left: 4px dashed #cbd5e0; top: -1.5rem; bottom: -1.5rem;';

            html += `<div class="timeline-item" style="min-height: 4rem;">
                        <div class="timeline-connector">
                            <div class="timeline-line" style="${connectorStyle}"></div>
                        </div>
                        <div class="timeline-content">
                            <div class="flex items-center gap-2 h-full">
                                ${isThru ? '' : `<span class="material-symbols-outlined text-gray-600">${icon}</span>`}
                                <span class="font-semibold ${isThru ? 'text-sm italic text-gray-600' : 'text-gray-700'}">${text}</span>
                            </div>
                        </div>
                    </div>`;
        }
    });

    const lastLeg = processedSegments.at(-1);
    if (lastLeg) {
        const finalStation = getDisplayName(lastLeg.stops ? lastLeg.stops.at(-1) : lastLeg.to);
        let finalLineInfo = { color: '#cbd5e0' };

        if (lastLeg.type === 'ride') {
            finalLineInfo = lineMap.get(lastLeg.line) || { name: lastLeg.line, color: '#cccccc' };
        } else if (lastLeg.type === 'thru') {
            finalLineInfo = lineMap.get(lastLeg.toLine) || { name: lastLeg.toLine, color: '#cccccc' };
        } else {
            const prevRide = processedSegments.slice(0, -1).reverse().find(s => s.type === 'ride');
            finalLineInfo = prevRide ? (lineMap.get(prevRide.line) || { name: prevRide.line, color: '#cccccc' }) : { color: '#cbd5e0' };
        }

        html += `<div class="timeline-item">
                    <div class="timeline-connector">
                        <div class="timeline-line" style="background-color: ${finalLineInfo.color}; top: 0; bottom: 50%;"></div>
                        <div class="timeline-dot" style="border-color: ${finalLineInfo.color};"></div>
                    </div>
                    <div class="timeline-content station-content"><div class="font-bold text-xl station-name">${finalStation}</div></div>
                 </div>`;
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

async function planTrip() {
    const loading = document.getElementById('loading');
    loading.style.display = 'flex';
    loading.style.opacity = '1';

    try {
        await setupData();
        const { origin, dest, criteria } = getQueryParams();

        const backButton = document.getElementById('back-button');
        backButton.href = `../?criteria=${criteria || ''}&origin=${origin || ''}&dest=${dest || ''}`;

        if (!origin || !dest || !locationMap.has(origin) || !locationMap.has(dest)) {
            document.getElementById('no-results').textContent = 'Please provide valid origin and destination station/stop keys in the URL query parameters (e.g., ?origin=ECL&dest=KSC).';
            document.getElementById('no-results').classList.remove('hidden');
            return;
        }
        if (origin === dest) {
            renderTrip(null, true);
            return;
        }

        let bestPath = findBestPath(origin, dest, criteria);

        if (!bestPath) {
            renderTrip(null);
            return;
        }

        const bestPathDetails = calculatePathDetails(bestPath);
        renderTrip(bestPathDetails);

    } catch (error) {
        console.error("Trip planning failed:", error);
        document.getElementById('no-results').textContent = `An unexpected error occurred during trip planning: ${error.message}`;
        document.getElementById('no-results').classList.remove('hidden');
    } finally {
        loading.style.opacity = '0';
        setTimeout(() => { loading.style.display = 'none'; }, 300);
    }
}

window.addEventListener('DOMContentLoaded', planTrip);
