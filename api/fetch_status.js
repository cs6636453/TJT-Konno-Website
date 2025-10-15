async function fetchStatus() {
    const url = "https://script.google.com/macros/s/AKfycbwwRXuVfw8rIlqiWcUV9LLnCXJdhypmyVCs-J4njJuRv5jZd3NOXegTbiZcjo3uYlLaug/exec";

    try {
        const response = await fetch(url);
        const data = await response.json();

        // Data example: [["Prefix","Route","Type","Status"], ["ET","Central Line","Limaru Metro","Closed"], ...]
        const statusMap = {};

        // skip the first header row
        for (let i = 1; i < data.length; i++) {
            const [prefix, , , status] = data[i]; // prefix = first column, status = fourth column
            statusMap[prefix] = status;
        }
        return statusMap;

    } catch (err) {
        console.error("Failed to fetch status:", err);
        return {};
    }
}

document.addEventListener("DOMContentLoaded", () => {
    const status_loading = document.getElementById("status_loading");
    fetchStatus().then(statusMap => {
        const statusIds = [
            "KK", "M1", "M2", "M3", "M6", "M7", "M4", "M5", "M8", "M9",
            "L41", "E17", "E23", "E134", "EW", "KM", "LP", "NK", "TJ",
            "CD", "QY", "TK", "NE", "SC", "CTT1", "CTT2"
        ];

        const statusClasses = ['bg-green', 'bg-orange', 'bg-red', 'bg-gray'];

        statusIds.forEach(id => {
            const el = document.getElementById(`status_${id.toLowerCase()}`);
            if (!el) return; // skip if element not found
            const status = statusMap[id];

            el.innerHTML = status;

            // remove previous status classes
            el.classList.remove(...statusClasses);

            // add new class based on status
            switch (status) {
                case 'Normal':
                    el.classList.add('bg-green');
                    break;
                case 'Busy':
                    el.classList.add('bg-orange');
                    break;
                case 'Closed':
                    el.classList.add('bg-red');
                    break;
                default:
                    el.classList.add('bg-gray');
                    break;
            }
        });
        status_loading.style.display = "none";
    });
});