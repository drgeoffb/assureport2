const API_BASE = "http://localhost:8000";
const ROOT_ID = 4;
let activeLevels = new Set();
let activeStatus = "all";
let isPruneActive = false;
let activeRel = "AQF-CLO"; // Default view
let mappingPayload = null; // Global to hold the pending save

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

    // Render as Outcome if it has an outcome reference code OR explicit type
    if (node.type === "outcome" || node.ref_code) {
        const isRoot = node.is_root_level || false;
        const statusClass = node.is_mapped ? "mapped" : "orphan";
        const category = getOutcomeCategory(node.ref_code || "");
        const typeClass = `text-${category.toLowerCase()}`;

        // Escape quotes to prevent HTML breaking
        const safeName = (node.display_name || "").replace(/'/g, "\\'");

        return `
            <div class="outcome ${statusClass} ${isRoot ? "root-standard" : ""}" 
                 ${isRoot ? "" : 'draggable="true" ondragstart="startDrag(event)"'}
                 data-code="${node.ref_code}"
                 data-is-root="${isRoot}"
                 onclick="stageOutcome(${node.id}, '${safeName}', '${node.ref_code}', ${isRoot})"
                 ondragenter="event.preventDefault(); !${isRoot} && this.classList.add('drag-over')" 
                 ondragleave="this.classList.remove('drag-over')"
                 ondragover="event.preventDefault()" 
                 ondrop="this.classList.remove('drag-over'); handleDrop(event, ${node.id}, '${node.ref_code}')">
                
                <div class="outcome-content-wrapper">
                    <div class="outcome-header">
                        <span class="type-indicator ${typeClass}">${category}</span>
                        <span class="item-display-name ${typeClass}">${node.display_name}</span>
                    </div>
                    ${node.description ? `<div class="item-description">${node.description}</div>` : ""}
                </div>
                ${node.parent_ids && node.parent_ids.length > 0 ? `<div class="mapping-tag">🔗 Mapped to: ${node.parent_ids.join(", ")}</div>` : ""}
            </div>`;
    }

    // Otherwise, render as Folder
    const hasChildren = node.children && node.children.length > 0;
    return `
        <div class="folder-container">
            <div class="folder" onclick="toggleFolder(this)">
                <span class="folder-toggle-icon">▼</span>
                ${node.name || "Folder"}
            </div>
            <div class="children" style="display: block;">
                ${hasChildren ? node.children.map((child) => renderNode(child)).join("") : '<div style="padding: 5px 20px; color: #999; font-size: 0.8em;">(Empty)</div>'}
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

function toggleRel(p, c) {
    activeRel = `${p}-${c}`;
    // Update UI state
    document
        .querySelectorAll(".chip-rel")
        .forEach((btn) => btn.classList.remove("active"));
    document.getElementById(`rel-${activeRel}`).classList.add("active");
    runAllFilters();
}

function startDrag(event) {
    const outcomeEl = event.target.closest(".outcome");
    if (outcomeEl.getAttribute("data-is-root") === "true") {
        event.preventDefault();
        return;
    }

    const id = outcomeEl.getAttribute("onclick").match(/\d+/)[0];
    const name = outcomeEl.querySelector(".item-display-name").innerText;
    const refCode = outcomeEl.getAttribute("data-code");

    stagedOutcomeData = {
        id: parseInt(id),
        name,
        refCode,
        category: getOutcomeCategory(refCode),
    };
    event.dataTransfer.setData("text/plain", id);
}

function stageOutcome(id, name, refCode, isRoot) {
    if (isRoot) {
        document.getElementById("log").innerHTML +=
            `<br><span style="color:orange">⚠️ Root standards (AQF) cannot be mapped.</span>`;
        return;
    }

    const sourceEl = document.querySelector(`.outcome[data-code="${refCode}"]`);
    const description = sourceEl
        ? sourceEl.querySelector(".item-description")?.innerHTML
        : "";
    const category = getOutcomeCategory(refCode);
    const targetNeeded = HIERARCHY_ORDER[HIERARCHY_ORDER.indexOf(category) + 1];

    stagedOutcomeData = { id, name, refCode, category };

    document.getElementById("staged-content").innerHTML = `
        <div class="staged-card" draggable="true" ondragstart="startDrag(event)">
            <span class="type-badge ${category.toLowerCase()}">${category}</span>
            <div style="margin: 10px 0; font-size: 1.2em;"><strong>${name}</strong></div>
            <div style="font-family: monospace; font-size: 0.9em; color: #666; margin-bottom: 10px;">Code: ${refCode}</div>
            ${description ? `<div class="item-description" style="font-size: 1.1rem; margin-bottom: 15px;">${description}</div>` : ""}
            
            <div id="drop-zone-prompt" style="padding: 12px; background: #e7f3ff; border: 1px dashed #007bff; border-radius: 4px; text-align: center;">
                <p style="margin: 0; color: #007bff; font-weight: bold;">👉 DRAG THIS onto a ${targetNeeded || "Parent"}</p>
            </div>
            
            <div id="confirm-zone" style="display:none; margin-top:15px; padding: 15px; background: #f0fff4; border: 1px solid #28a745; border-radius: 4px;">
                <p style="color: #28a745; margin: 0 0 10px 0;"><strong>Target:</strong> <span id="target-name-display"></span></p>
                <button onclick="confirmMapping()" style="width: 100%; padding: 12px; background: #28a745; color: white; border: none; border-radius: 4px; font-weight: bold; font-size: 1.1rem; cursor: pointer;">
                    Confirm & Save
                </button>
            </div>
        </div>`;
}

function handleDrop(event, targetId, targetCode) {
    event.preventDefault();
    if (!stagedOutcomeData) return;

    const targetCategory = getOutcomeCategory(targetCode);
    if (!canMap(stagedOutcomeData.category, targetCategory)) {
        alert(
            `Invalid: ${stagedOutcomeData.category} cannot be mapped to ${targetCategory}`,
        );
        return;
    }

    mappingPayload = {
        childId: stagedOutcomeData.id,
        parentId: targetId,
        parentCode: targetCode,
    };

    document.getElementById("drop-zone-prompt").style.opacity = "0.3";
    document.getElementById("confirm-zone").style.display = "block";
    document.getElementById("target-name-display").innerText = targetCode;
}

async function executeMapping(childId, parentId, parentCode) {
    try {
        const response = await fetch(`${API_BASE}/outcomes/map`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                subject_outcome_id: childId,
                parent_outcome_id: parentId,
                parent_title: parentCode,
            }),
        });

        if (response.ok) {
            document.getElementById("log").innerHTML +=
                `<br><span style="color:green">✅ Saved: ${parentCode}</span>`;

            // IMMEDIATE UI UPDATE
            const targetEl = document.querySelector(
                `.outcome[onclick*="${childId}"]`,
            );
            if (targetEl) {
                targetEl.classList.remove("orphan");
                targetEl.classList.add("mapped");
                let tag =
                    targetEl.querySelector(".mapping-tag") ||
                    document.createElement("div");
                tag.className = "mapping-tag";
                tag.innerHTML = `🔗 Mapped to: ${parentCode}`;
                if (!targetEl.querySelector(".mapping-tag"))
                    targetEl.appendChild(tag);
            }

            const btn = document.querySelector("#confirm-zone button");
            if (btn) {
                btn.innerText = "SAVED ✅";
                btn.disabled = true;
                btn.style.background = "#6c757d";
            }
        }
    } catch (err) {
        console.error(err);
    }
}

async function confirmMapping() {
    if (!mappingPayload) return;

    // Run the save
    await executeMapping(
        mappingPayload.childId,
        mappingPayload.parentId,
        mappingPayload.parentCode,
    );

    // Wait 1.5 seconds so they can see the "SAVED ✅" button, then clear
    setTimeout(() => {
        document.getElementById("staged-content").innerHTML = `
            <p style="color: #888; text-align: center; margin-top: 20px;">
                Select another outcome to begin mapping...
            </p>`;
        mappingPayload = null;
        stagedOutcomeData = null;
    }, 1500);
}

init();
