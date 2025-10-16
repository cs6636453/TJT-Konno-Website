let allLocations = [];

document.addEventListener("DOMContentLoaded", () => {
    const originInput = document.getElementById("trip_origin");
    const destInput = document.getElementById("trip_dest");
    const originKey = document.getElementById("trip_origin_key");
    const destKey = document.getElementById("trip_dest_key");
    const form = document.getElementById("trip_form");
    const backBtn = document.getElementById("backToTop");
    let lastScrollTop = 0; // For detecting scroll direction

    // Fetch JSON dataset
    fetch("/api/dataset.json")
        .then(res => res.json())
        .then(data => {
            allLocations = [
                ...data.stations.map(s => ({ ...s, type: "station" })),
                ...data.bus_stops.map(b => ({ ...b, type: "bus_stop" }))
            ];

            // Initialize autocomplete
            setupAutocomplete(originInput, originKey);
            setupAutocomplete(destInput, destKey);

            // Prefill from URL params
            pre_filled();
        })
        .catch(err => console.error("Failed to fetch dataset:", err));

    // Swap button
    document.querySelector(".swap").addEventListener("click", () => {
        const tempVal = originInput.value;
        const tempKey = originKey.value;
        originInput.value = destInput.value;
        originKey.value = destKey.value;
        destInput.value = tempVal;
        destKey.value = tempKey;
    });

    // On form submit, make sure hidden keys are sent
    form.addEventListener("submit", e => {
        const originObj = allLocations.find(
            loc => loc.name.toLowerCase() === originInput.value.toLowerCase()
        );
        const destObj = allLocations.find(
            loc => loc.name.toLowerCase() === destInput.value.toLowerCase()
        );

        if (originObj) originKey.value = originObj.key;
        if (destObj) destKey.value = destObj.key;

        if (!originObj || !destObj) {
            e.preventDefault();
            alert("Origin or destination invalid!");
        }
    });

    // Show back button only when scrolling up past 200px
    window.addEventListener("scroll", () => {
        const currentScroll = window.pageYOffset || document.documentElement.scrollTop;

        if (currentScroll < lastScrollTop && currentScroll > 200) {
            // Scrolling up
            backBtn.style.display = "block";
        } else {
            // Scrolling down or near top
            backBtn.style.display = "none";
        }

        lastScrollTop = currentScroll <= 0 ? 0 : currentScroll; // Avoid negative scroll
    });

    // Scroll to top on click
    backBtn?.addEventListener("click", () => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    });
});

// Autocomplete setup
function setupAutocomplete(input, hiddenInput) {
    const wrapper = input.parentNode;

    function showSuggestions(val = "") {
        closeDropdown(input);

        const suggestions = allLocations.filter(loc =>
            loc.name.toLowerCase().includes(val.toLowerCase())
        );

        if (!suggestions.length) return;

        const list = document.createElement("div");
        list.classList.add("autocomplete-items");
        list.style.position = "absolute";
        list.style.zIndex = 1550;
        list.style.backgroundColor = "#fff";
        list.style.border = "1px solid #ccc";
        list.style.boxShadow = "0 2px 6px rgba(0,0,0,0.15)";
        list.style.maxHeight = "200px";
        list.style.overflowY = "auto";

        // --- THIS IS THE EDITED LOGIC ---
        // On mobile screens, match the input's width. On desktop, use a fixed width.
        if (window.innerWidth <= 992) {
            list.style.width = input.offsetWidth + "px";
            list.style.boxSizing = "border-box"; // Ensure padding/border are included in the width
        } else {
            list.style.width = "500px";
        }
        // --- END OF EDIT ---

        wrapper.appendChild(list);

        suggestions.forEach(loc => {
            const prefix = loc.type === "station" ? "🚇" : "🚏";
            const item = document.createElement("div");
            item.textContent = `${prefix} ${loc.name}`;
            item.style.padding = "4px 8px";
            item.style.cursor = "pointer";

            item.addEventListener("click", () => {
                input.value = loc.name;       // visible text
                hiddenInput.value = loc.key;  // hidden key
                closeDropdown(input);
            });

            list.appendChild(item);
        });
    }

    input.addEventListener("input", () => showSuggestions(input.value));
    input.addEventListener("focus", () => showSuggestions(input.value));

    document.addEventListener("click", e => {
        if (!wrapper.contains(e.target)) closeDropdown(input);
    });
}

function close_banner(id) {
    document.getElementById(id).remove();
}

// Close dropdown
function closeDropdown(input) {
    const items = input.parentNode.querySelectorAll(".autocomplete-items");
    items.forEach(i => i.remove());
}

// Prefill from URL
function pre_filled() {
    const urlParams = new URLSearchParams(window.location.search);
    const originName = urlParams.get("origin");
    const destName = urlParams.get("dest");

    if (!allLocations.length) return;

    const originInput = document.getElementById("trip_origin");
    const destInput = document.getElementById("trip_dest");
    const originKey = document.getElementById("trip_origin_key");
    const destKey = document.getElementById("trip_dest_key");

    if (originName) {
        const originObj = allLocations.find(loc => loc.key === originName || loc.name === originName);
        if (originObj) {
            originInput.value = originObj.name;
            originKey.value = originObj.key;
        }
    }

    if (destName) {
        const destObj = allLocations.find(loc => loc.key === destName || loc.name === destName);
        if (destObj) {
            destInput.value = destObj.name;
            destKey.value = destObj.key;
        }
    }
}