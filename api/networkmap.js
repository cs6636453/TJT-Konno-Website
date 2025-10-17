// Detect phone and orientation
function checkOrientation() {
    const overlay = document.getElementById('rotateOverlay');
    const isMobile = /Mobi|Android/i.test(navigator.userAgent);
    const isPortrait = window.innerHeight > window.innerWidth;
    overlay.style.display = (isMobile && isPortrait) ? 'flex' : 'none';
}
window.addEventListener('resize', checkOrientation);
window.addEventListener('orientationchange', checkOrientation);
window.addEventListener('load', checkOrientation);

(async function() {
    const infoEl = document.getElementById('info');
    const container = document.getElementById('network');

    // Line meta config
    const lines_meta = {
        "ILL": { color: "#fcba03", freq: 4, name: "Island Loop Line" },
        "EW":  { color: "#03fca9", freq: 8, name: "Tozai Line" },
        "KM":  { color: "#037ffc", freq: 8, name: "Keishin Line" },
        "LP":  { color: "#ff2b1c", freq: 8, name: "Lipan Line" },
        "LPB": { color: "#ff2b1c", freq: 4, name: "Lipan Branch" },
        "NK":  { color: "#0bd919", freq: 8, name: "Namboku Line" },
        "TN":  { color: "#0d8c37", freq: 8, name: "Tennoji Line" },
        "TNE":  { color: "#0d8c37", freq: 999, name: "Tennoji Line" },
        "CY":  { color: "#e4f005", freq: 8, name: "Chiyoda Line" },
        "QY":  { color: "#9c0c86", freq: 999, name: "Katsuragi-Leighstrand Shuttle" },
        "TK":  { color: "#915f13", freq: 999, name: "Tokaido Line" },
        "KK":  { color: "#23b9eb", freq: 999, name: "Kotoha Line" },
        "NE":  { color: "#f542b0", freq: 999, name: "Northeast Mainline" },
        "SC":  { color: "#a8a8a8", freq: 999, name: "Southcoast Mainline" },
        "M1":  { color: "#2373eb", freq: 8, name: "Mizuno BRT (M1)", isBus: true },
        "M6":  { color: "#2373eb", freq: 0, name: "Bus M6", isBus: true },
        "M7":  { color: "#2373eb", freq: 8, name: "Bus M7", isBus: true },
        "M9":  { color: "#db250d", freq: 999, name: "Songtaew M9", isBus: true },
        "L41": { color: "#3b3b3b", freq: 0, name: "L41 Bridging Bus", isBus: true },
        "E17": { color: "#3b3b3b", freq: 999, name: "Bus E17", isBus: true },
        "0":   { color: "#9e9e9e", freq: 0, name: "Walk", isWalk: true },
        "1":   { color: "#9e9e9e", freq: 0, name: "Walk", isWalk: true }
    };

    async function tryFetch(paths) {
        for (const p of paths) {
            try {
                const r = await fetch(p + '?_=' + Date.now());
                if (!r.ok) continue;
                const json = await r.json();
                return { path: p, json };
            } catch {}
        }
        return null;
    }

    const mappingRes = await tryFetch(['/api/dataset.json','./api/dataset.json','./dataset.json']);
    if (!mappingRes) { infoEl.textContent = 'Missing mapping JSON.'; return; }
    const mapping = mappingRes.json;
    const keyToName = {};
    (mapping.stations || []).forEach(s => { if (s.key) keyToName[s.key] = s.name || s.key; });
    (mapping.bus_stops || []).forEach(b => { if (b.key) keyToName[b.key] = b.name || b.key; });

    const legend = document.getElementById('legend');
    Object.entries(lines_meta).forEach(([k,v])=>{
        const row=document.createElement('div'); row.className='legend-row';
        const sw=document.createElement('div'); sw.className='sw'; sw.style.background=v.color;
        const lbl=document.createElement('div');
        lbl.innerHTML=`<span class="line-name">${k}</span> <span class="small">${v.name}</span>`;
        row.appendChild(sw); row.appendChild(lbl); legend.appendChild(row);
    });

    let network, nodesDS, edgesDS;
    const options = {
        physics: { stabilization: true, barnesHut: { gravitationalConstant: -20000, springLength: 200 } },
        edges: { smooth: { type: 'dynamic' }, selfReferenceSize: 10 },
        nodes: { shape: 'dot', font: { multi: true, size: 12 } },
        interaction: { hover: true, navigationButtons: true, keyboard: true }
    };

    function buildGraph(graph) {
        const nodesMap = new Map();
        const edges = [];
        const edgeComboCount = {};

        function addNode(id) {
            if (nodesMap.has(id)) return;
            const label = keyToName[id] || id;
            nodesMap.set(id, {
                id,
                label: `${label}\n(${id})`,
                shape: 'dot',
                color: '#1f78b4',
                size: 10
            });
        }

        Object.entries(graph).forEach(([origin, adj]) => {
            addNode(origin);
            Object.entries(adj || {}).forEach(([dest, e]) => {
                if (!e || typeof e !== 'object') return;
                addNode(dest);
                const lines = Array.isArray(e.lines) ? e.lines : (e.lines ? [e.lines] : ['0']);
                const freqs = Array.isArray(e.freq) ? e.freq : Array(lines.length).fill(e.freq ?? '');
                const flags = e.flags || '';
                lines.forEach((L, idx) => {
                    const meta = lines_meta[L] || lines_meta['0'];
                    const freqVal = freqs[idx] ?? meta.freq ?? '';
                    const baseKey = `${origin}-${dest}`;
                    edgeComboCount[baseKey] = (edgeComboCount[baseKey] || 0) + 1;
                    const offset = (edgeComboCount[baseKey] - 1) * 5;
                    const freqLabel = freqVal !== '' ? ` (${freqVal})` : '';
                    const labelText = meta.isWalk ? 'walk' : `${L}`;
                    edges.push({
                        id: `${origin}-${dest}-${L}-${edgeComboCount[baseKey]}`,
                        from: origin,
                        to: dest,
                        arrows: 'to',
                        label: labelText,
                        dashes: meta.isWalk || flags.includes('walk'),
                        color: { color: meta.color, highlight: meta.color, hover: meta.color },
                        width: meta.isWalk ? 1.5 : (meta.isBus ? 2 : 3.5),
                        smooth: { type: 'curvedCW', roundness: offset / 10 },
                        title: `${keyToName[origin] || origin} → ${keyToName[dest] || dest}\n${meta.name}${freqLabel ? '\nFrequency: ' + freqLabel.replace(/[()]/g, '') + ' min' : ''}`
                    });
                });
            });
        });
        return { nodes: Array.from(nodesMap.values()), edges };
    }

    async function loadGraphAndRender() {
        infoEl.textContent='Fetching graph...';
        const graphRes=await tryFetch(['/api/datanodes.json','./api/datanodes.json','./nodes.json']);
        if (!graphRes) { infoEl.textContent='Graph JSON missing'; return; }
        const {nodes,edges}=buildGraph(graphRes.json);
        if (!network) {
            nodesDS=new vis.DataSet(nodes);
            edgesDS=new vis.DataSet(edges);
            network=new vis.Network(container,{nodes:nodesDS,edges:edgesDS},options);
            network.once('stabilizationIterationsDone',()=>network.fit());
        } else {
            nodesDS.clear(); edgesDS.clear();
            nodesDS.add(nodes); edgesDS.add(edges);
            network.fit();
        }
        infoEl.textContent=`Mapping: ${mappingRes.path}\nGraph: ${graphRes.path}\nLast updated: ${new Date().toLocaleTimeString()}`;
    }

    await loadGraphAndRender();
})();