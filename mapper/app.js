const API_BASE = "http://localhost:8000";
const ROOT_ID = 4;
let activeLevels = new Set();
let activeStatus = "all";
let isPruneActive = false;
let activeRel = "AQF-CLO"; // Default view

async function init() {
    const loader = document.getElementById("loading-text");
    const log = document.getElementById("log");
    const root = document.getElementById("tree-root");

    // Timer setup
    let seconds = 0;
    const startTime = Date.now();
    const timerInterval = setInterval(() => {
        seconds = Math.floor((Date.now() - startTime) / 1000);
        // We'll update a dedicated timer span if it exists,
        // or just prepend it to the loader text
        const timerEl = document.getElementById("timer-display");
        if (timerEl) timerEl.innerText = `${seconds}s`;
    }, 1000);

    try {
        const response = await fetch(`${API_BASE}/outcomes/${ROOT_ID}/stream`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value);
            const lines = chunk.split("\n");

            lines.forEach((line) => {
                if (!line.startsWith("data: ")) return;
                const data = JSON.parse(line.replace("data: ", ""));

                if (data.status === "info") {
                    loader.innerText = `[${seconds}s] ${data.msg}`;
                    log.innerHTML += `<br>> [${seconds}s] ${data.msg}`;
                    log.scrollTop = log.scrollHeight;
                }

                if (data.status === "complete") {
                    clearInterval(timerInterval); // Stop the clock!
                    root.innerHTML = renderNode(data.tree);
                    log.innerHTML += `<br><strong>> Total Load Time: ${seconds} seconds.</strong>`;
                    runAllFilters();
                }

                if (data.status === "error") {
                    clearInterval(timerInterval);
                    throw new Error(data.msg);
                }
            });
        }
    } catch (err) {
        clearInterval(timerInterval);
        root.innerHTML = `<div style="color:red; padding:20px;">Crawl Failed: ${err.message}</div>`;
    }
}

function renderNode(node) {
    if (!node) return "";

    if (node.type === "outcome") {
        const refCode = node.ref_code || "";
        const displayName = node.display_name || "Unknown Outcome";
        const description = node.description || "";

        // Define status based on backend mapping flag
        const statusClass = node.is_mapped ? "mapped" : "orphan";

        const category = getOutcomeCategory(refCode);
        const typeClass = `text-${category.toLowerCase()}`;

        // Drag & Drop logic (AQF items cannot be dragged)
        const isAQF = category === "AQF";
        const draggableAttr = isAQF
            ? ""
            : 'draggable="true" ondragstart="startDrag(event)"';

        // Escape single quotes for the onclick handler
        const safeName = displayName.replace(/'/g, "\\'");

        return `
            <div class="outcome ${statusClass}" 
                 ${draggableAttr}
                 data-code="${refCode}"
                 onclick="stageOutcome(${node.id}, '${safeName}', '${refCode}')"
                 ondragover="event.preventDefault()"
                 ondrop="handleDrop(event, ${node.id}, '${refCode}')">
                
                <div style="display: flex; align-items: baseline; width: 100%;">
                    <span class="type-indicator ${typeClass}">${category}</span>
                    <span class="item-display-name ${typeClass}">${displayName}</span>
                </div>

                ${description ? `<div class="item-description">${description}</div>` : ""}
                
                ${
                    node.parent_ids && node.parent_ids.length > 0
                        ? `<div class="mapping-tag">🔗 Mapped to: ${node.parent_ids.join(", ")}</div>`
                        : ""
                }
            </div>`;
    }

    // Folder Rendering (Expanded by default)
    return `
        <div class="folder-container">
            <div class="folder" onclick="toggleFolder(this)">
                <span class="folder-toggle-icon">▼</span>
                ${node.name}
            </div>
            <div class="children" style="display: block;">
                ${node.children ? node.children.map((child) => renderNode(child)).join("") : ""}
            </div>
        </div>`;
}

function toggleFolder(element) {
    const children = element.nextElementSibling;
    const icon = element.querySelector(".folder-toggle-icon");

    if (children.style.display === "none") {
        children.style.display = "block";
        icon.innerText = "▼";
    } else {
        children.style.display = "none";
        icon.innerText = "▶";
    }
}

function toggleAllGlobal(shouldCollapse) {
    document
        .querySelectorAll(".outcome")
        .forEach((o) => o.classList.toggle("hidden", shouldCollapse));
    document
        .querySelectorAll(".folder")
        .forEach((f) => f.classList.toggle("collapsed", shouldCollapse));
}

function toggleLevel(lvl) {
    const btn = document.getElementById(`btn-L${lvl}`);
    if (activeLevels.has(lvl)) {
        activeLevels.delete(lvl);
        btn.classList.remove("active");
    } else {
        activeLevels.add(lvl);
        btn.classList.add("active");
    }
    // Log the action for debugging
    console.log("Active Levels:", Array.from(activeLevels));
    runAllFilters();
}

function applyStatusFilter(status) {
    activeStatus = activeStatus === status ? "all" : status;
    runAllFilters();
}

function togglePrune() {
    isPruneActive = !isPruneActive;
    const btn = document.getElementById("btn-prune");
    btn.classList.toggle("active", isPruneActive);
    // Simple toggle: button glows when "Hide" is active
    runAllFilters();
}

function runAllFilters() {
    const query = document.getElementById("tree-search").value.toLowerCase();
    const outcomes = document.querySelectorAll(".outcome");
    const [relParent, relChild] = activeRel.split("-");

    outcomes.forEach((o) => {
        // 1. Get the data from the hidden attribute and visible text
        const refCode = o.getAttribute("data-code") || "";
        const displayName =
            o.querySelector(".item-display-name")?.innerText || "";
        const combinedText = (displayName + " " + refCode).toLowerCase();

        const category = getOutcomeCategory(refCode);
        const isMapped = o.classList.contains("mapped");

        // 2. Relationship Filter
        const matchesRel = category === relParent || category === relChild;

        // 3. Level Filter (Now scans the hidden refCode)
        let matchesLevel = activeLevels.size === 0;
        if (activeLevels.size > 0) {
            activeLevels.forEach((lvl) => {
                // If the code contains '7', '8', or '9', it's a match
                if (refCode.includes(lvl)) matchesLevel = true;
            });
        }

        // 4. Status & Search
        const matchesStatus =
            activeStatus === "all" ||
            (activeStatus === "mapped" && isMapped) ||
            (activeStatus === "orphan" && !isMapped);
        const matchesSearch = combinedText.includes(query);

        // Final Visibility Toggle
        o.classList.toggle(
            "hidden",
            !(matchesRel && matchesLevel && matchesStatus && matchesSearch),
        );
    });

    if (isPruneActive) pruneFolders();
}

function resetAllFilters() {
    activeLevels.clear();
    activeStatus = "all";
    document
        .querySelectorAll(".chip-level")
        .forEach((b) => b.classList.remove("active"));
    document.getElementById("tree-search").value = "";
    runAllFilters();
}

function stageOutcome(id, name, refCode) {
    const category = getOutcomeCategory(refCode);
    const targetNeeded = HIERARCHY_ORDER[HIERARCHY_ORDER.indexOf(category) + 1];

    stagedOutcomeData = { id, name, refCode, category };

    document.getElementById("staged-content").innerHTML = `
        <div class="staged-card">
            <span class="type-badge ${category.toLowerCase()}">${category}</span>
            <div style="margin: 8px 0;"><strong>${name}</strong></div>
            <div style="font-family: monospace; font-size: 0.8em; color: #666;">ID: ${refCode}</div>
            <div style="margin-top:12px; font-size: 0.85em; color: #007bff; border-top: 1px solid #eee; pt: 8px;">
                👉 Map to ${targetNeeded || "Top Level"}
            </div>
        </div>`;
}
// function stageOutcome(id, displayName, refCode) {
//     const category = getOutcomeCategory(refCode);
//     const targetNeeded = HIERARCHY_ORDER[HIERARCHY_ORDER.indexOf(category) + 1];

//     // Store essential data for the mapping execution
//     stagedOutcomeData = { id, name: displayName, refCode, category };

//     document.getElementById("staged-content").innerHTML = `
//         <div class="staged-card" style="text-align:left; border:1px solid #007bff; padding:10px; border-radius:5px;">
//             <span class="type-badge ${category.toLowerCase()}">${category}</span>
//             <div style="margin: 5px 0;"><strong>${displayName}</strong></div>
//             <code style="font-size:0.8em;">Code: ${refCode}</code>
//             <div style="margin-top:10px; font-size:0.85em; color:#007bff; font-weight:bold;">
//                 👉 Drop onto a ${targetNeeded || "Root"}
//             </div>
//         </div>`;
//     document.getElementById("log").innerHTML += `<br>> Staged: ${refCode}`;
// }

function getOutcomeCategory(code) {
    if (!code) return "OTHER";
    const c = code.toUpperCase();
    if (c.includes("AQF")) return "AQF";
    if (c.includes("CLO")) return "CLO";
    if (c.includes("SLO")) return "SLO";
    if (c.includes("ALO") || c.includes("RUBRIC")) return "ALO";
    return "OTHER";
}

// Define the valid hierarchy order
const HIERARCHY_ORDER = ["ALO", "SLO", "CLO", "AQF"];

function canMap(sourceCat, targetCat) {
    const sourceIdx = HIERARCHY_ORDER.indexOf(sourceCat);
    const targetIdx = HIERARCHY_ORDER.indexOf(targetCat);

    // Rule: Target must be exactly one index higher than Source
    return targetIdx - sourceIdx === 1;
}

function handleDrop(event, targetId, targetCode) {
    event.preventDefault();
    if (!stagedOutcomeData) return;

    // --- BUG FIX: Block self-mapping at the UI level ---
    if (stagedOutcomeData.id === targetId) {
        const errorMsg =
            "Recursion Error: An outcome cannot be mapped to itself.";
        document.getElementById("log").innerHTML +=
            `<br><span style="color:#ff4444">❌ ${errorMsg}</span>`;
        alert(errorMsg);
        return;
    }

    const targetCategory = getOutcomeCategory(targetCode);

    if (canMap(stagedOutcomeData.category, targetCategory)) {
        executeMapping(stagedOutcomeData.id, targetId, targetCode);
    } else {
        // INVALID: Show specific error
        const errorMsg =
            `Structure Violation: Cannot map ${stagedOutcomeData.category} to ${targetCategory}. ` +
            `Mapping must follow: ALO → SLO → CLO → AQF.`;

        document.getElementById("log").innerHTML +=
            `<br><span style="color:#ff4444">❌ ${errorMsg}</span>`;
        alert(errorMsg);
    }
}

async function executeMapping(childId, parentId, parentCode) {
    try {
        const response = await fetch(`${API_BASE}/map`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                subject_outcome_id: childId,
                parent_outcome_id: parentId,
                parent_title: parentCode, // We store the code for human readability
            }),
        });

        if (response.ok) {
            // Update UI locally so we don't have to re-crawl
            document.getElementById("log").innerHTML +=
                `<br><span style="color:green">✅ Saved: ${parentCode}</span>`;
            // Refresh the specific outcome element if possible, or just log success
        }
    } catch (err) {
        console.error("Mapping failed", err);
    }
}

function stageOutcome(id, name) {
    const category = getOutcomeCategory(name);
    const targetNeeded = HIERARCHY_ORDER[HIERARCHY_ORDER.indexOf(category) + 1];

    stagedOutcomeData = { id, name, category };

    document.getElementById("staged-content").innerHTML = `
            <div class="staged-card">
                <span class="type-badge ${category.toLowerCase()}">${category}</span>
                <strong>${name}</strong>
                <div style="margin-top:8px; font-size:0.85em; color:#555;">
                    👉 Must map to a <strong>${targetNeeded || "TOP LEVEL"}</strong>
                </div>
            </div>`;
}

function toggleRel(p, c) {
    activeRel = `${p}-${c}`;
    // Update UI state
    document
        .querySelectorAll(".chip-rel")
        .forEach((btn) => btn.classList.remove("active"));
    document.getElementById(`rel-${activeRel}`).classList.add("active");
    runAllFilters();
}

init();
