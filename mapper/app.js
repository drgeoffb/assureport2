const API_BASE = "http://localhost:8000";
    const ROOT_ID = 4;
    let activeLevels = new Set();
    let activeStatus = 'all';
    let isPruneActive = false;
    let activeRel = 'AQF-CLO'; // Default view

    async function init() {
        const loader = document.getElementById('loading-text');
        const log = document.getElementById('log');
        const root = document.getElementById('tree-root');
        
        // Timer setup
        let seconds = 0;
        const startTime = Date.now();
        const timerInterval = setInterval(() => {
            seconds = Math.floor((Date.now() - startTime) / 1000);
            // We'll update a dedicated timer span if it exists, 
            // or just prepend it to the loader text
            const timerEl = document.getElementById('timer-display');
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
                const lines = chunk.split('\n');
                
                lines.forEach(line => {
                    if (!line.startsWith('data: ')) return;
                    const data = JSON.parse(line.replace('data: ', ''));

                    if (data.status === 'info') {
                        loader.innerText = `[${seconds}s] ${data.msg}`;
                        log.innerHTML += `<br>> [${seconds}s] ${data.msg}`;
                        log.scrollTop = log.scrollHeight;
                    } 
                    
                    if (data.status === 'complete') {
                        clearInterval(timerInterval); // Stop the clock!
                        root.innerHTML = renderNode(data.tree);
                        log.innerHTML += `<br><strong>> Total Load Time: ${seconds} seconds.</strong>`;
                        runAllFilters();
                    }
                    
                    if (data.status === 'error') {
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
        if (!node) return '';
        if (node.type === 'outcome') {
                const category = getOutcomeCategory(node.name);
                const typeClass = `text-${category.toLowerCase()}`;
                const statusClass = node.mapped_to && node.mapped_to.length > 0 ? 'mapped' : 'orphan';
                
                // AQF is a target only, others are draggable
                const isAQF = category === 'AQF';
                const draggableAttr = isAQF ? '' : 'draggable="true" ondragstart="startDrag(event)"';

                return `
                    <div class="outcome ${statusClass}" 
                        ${draggableAttr}
                        onclick="stageOutcome(${node.id}, '${node.name.replace(/'/g, "\\'")}')"
                        oncontextmenu="showMenu(event, ${node.id}, '${node.name.replace(/'/g, "\\'")}')"
                        ondragover="event.preventDefault()"
                        ondrop="handleDrop(event, ${node.id}, '${node.name.replace(/'/g, "\\'")}')">
                        <span class="type-indicator ${typeClass}">${category}</span>
                        <span class="item-name ${typeClass}">${node.name}</span>
                        ${node.mapped_to && node.mapped_to.length > 0 ? `<div class="mapping-list">${node.mapped_to.map(m => `<span>→ ${m}</span>`).join('')}</div>` : ''}
                    </div>`;
        }
        if (node.type === 'folder') {
            return `
                <div class="node">
                    <div class="folder" onclick="toggleFolder(this)">
                        <span class="status-icon">${node.is_account ? '🏛️' : '📁'}</span>
                        <span class="item-name">${node.name}</span>
                        <small style="color:#888; margin-left:10px;">[${node.children.length}]</small>
                    </div>
                    <div class="children">
                        ${node.children.map(c => renderNode(c)).join('')}
                    </div>
                </div>`;
        } else {
            const statusClass = node.is_mapped ? 'mapped' : 'orphan';
            return `
                <div class="outcome ${statusClass}" onclick="stageOutcome(${node.id}, '${node.name.replace(/'/g, "\\'")}')">
                    <span class="status-icon">${node.is_mapped ? '✅' : '🔴'}</span>
                    <span class="item-name">${node.name}</span>
                    <span class="tag">#${node.id}</span>
                </div>`;
        }
    }

    function toggleFolder(folderEl) {
        const outcomes = folderEl.nextElementSibling.querySelectorAll(':scope > .outcome');
        const isCurrentlyCollapsed = folderEl.classList.toggle('collapsed');
        outcomes.forEach(o => o.classList.toggle('hidden', isCurrentlyCollapsed));
    }

    function toggleAllGlobal(shouldCollapse) {
        document.querySelectorAll('.outcome').forEach(o => o.classList.toggle('hidden', shouldCollapse));
        document.querySelectorAll('.folder').forEach(f => f.classList.toggle('collapsed', shouldCollapse));
    }

    function toggleLevel(lvl) {
        const btn = document.getElementById(`btn-L${lvl}`);
        if (activeLevels.has(lvl)) {
            activeLevels.delete(lvl);
            btn.classList.remove('active');
        } else {
            activeLevels.add(lvl);
            btn.classList.add('active');
        }
        // Log the action for debugging
        console.log("Active Levels:", Array.from(activeLevels));
        runAllFilters();
    }

    function applyStatusFilter(status) {
        activeStatus = (activeStatus === status) ? 'all' : status;
        runAllFilters();
    }

    function togglePrune() {
        isPruneActive = !isPruneActive;
        const btn = document.getElementById('btn-prune');
        btn.classList.toggle('active', isPruneActive);
        // Simple toggle: button glows when "Hide" is active
        runAllFilters();
    }

    function runAllFilters() {
        const query = document.getElementById('tree-search').value.toLowerCase();
        const outcomes = document.querySelectorAll('.outcome');
        const [relParent, relChild] = activeRel.split('-');

        outcomes.forEach(o => {
            const nameText = o.querySelector('.item-name').innerText;
            const category = getOutcomeCategory(nameText);
            const isMapped = o.classList.contains('mapped');
            
            // 1. Relationship Filter (Only show types in the active pair)
            const matchesRel = (category === relParent || category === relChild);

            // 2. Level Filter (Only if it matches the digit, or if it's an SLO/ALO which might inherit)
            let matchesLevel = activeLevels.size === 0;
            if (activeLevels.size > 0) {
                activeLevels.forEach(lvl => {
                    const levelRegex = new RegExp(`(aqf|clo|level|l| )\s*${lvl}`, 'i');
                    if (levelRegex.test(nameText)) matchesLevel = true;
                });
            }

            // 3. Status & Search
            const matchesStatus = (activeStatus === 'all') || 
                                (activeStatus === 'mapped' && isMapped) || 
                                (activeStatus === 'orphan' && !isMapped);
            const matchesSearch = nameText.toLowerCase().includes(query);

            // Final Visibility
            o.classList.toggle('hidden', !(matchesRel && matchesLevel && matchesStatus && matchesSearch));
        });

        // Run the 'Hide' logic after filtering outcomes
        if (isPruneActive) {
            pruneFolders(); 
        }
    }

    function resetAllFilters() {
        activeLevels.clear();
        activeStatus = 'all';
        document.querySelectorAll('.chip-level').forEach(b => b.classList.remove('active'));
        document.getElementById('tree-search').value = '';
        runAllFilters();
    }

    function stageOutcome(id, name) {
        document.getElementById('staged-content').innerHTML = `
            <div style="padding:15px; border:2px dashed #007bff; background:#eefbff; border-radius:8px;">
                <strong>${name}</strong><br><small>Ready to map</small>
            </div>`;
        document.getElementById('log').innerHTML += `<br>> Staged: ${id}`;
    }

    function getOutcomeCategory(name) {
        const n = name.toUpperCase();
        if (n.includes('AQF')) return 'AQF';
        if (n.includes('CLO')) return 'CLO';
        if (n.includes('SLO')) return 'SLO';
        if (n.includes('ALO') || n.includes('RUBRIC')) return 'ALO';
        return 'OTHER';
    }

    // Define the valid hierarchy order
    const HIERARCHY_ORDER = ['ALO', 'SLO', 'CLO', 'AQF'];

    function canMap(sourceCat, targetCat) {
        const sourceIdx = HIERARCHY_ORDER.indexOf(sourceCat);
        const targetIdx = HIERARCHY_ORDER.indexOf(targetCat);

        // Rule: Target must be exactly one index higher than Source
        return (targetIdx - sourceIdx === 1);
    }

    function handleDrop(event, targetId, targetName) {
        event.preventDefault();
        if (!stagedOutcomeData) return;

        const targetCategory = getOutcomeCategory(targetName);
        
        if (canMap(stagedOutcomeData.category, targetCategory)) {
            // VALID: Execute the mapping
            executeMapping(stagedOutcomeData.id, targetId, targetName);
            document.getElementById('log').innerHTML += 
                `<br><span style="color:green">✅ Mapped ${stagedOutcomeData.category} to ${targetCategory}</span>`;
        } else {
            // INVALID: Show specific error
            const errorMsg = `Structure Violation: Cannot map ${stagedOutcomeData.category} to ${targetCategory}. ` +
                            `Mapping must follow: ALO → SLO → CLO → AQF.`;
            
            document.getElementById('log').innerHTML += `<br><span style="color:#ff4444">❌ ${errorMsg}</span>`;
            alert(errorMsg);
        }
    }

    function stageOutcome(id, name) {
        const category = getOutcomeCategory(name);
        const targetNeeded = HIERARCHY_ORDER[HIERARCHY_ORDER.indexOf(category) + 1];

        stagedOutcomeData = { id, name, category };

        document.getElementById('staged-content').innerHTML = `
            <div class="staged-card">
                <span class="type-badge ${category.toLowerCase()}">${category}</span>
                <strong>${name}</strong>
                <div style="margin-top:8px; font-size:0.85em; color:#555;">
                    👉 Must map to a <strong>${targetNeeded || 'TOP LEVEL'}</strong>
                </div>
            </div>`;
    }
 
    function toggleRel(p, c) {
        activeRel = `${p}-${c}`;
        // Update UI state
        document.querySelectorAll('.chip-rel').forEach(btn => btn.classList.remove('active'));
        document.getElementById(`rel-${activeRel}`).classList.add('active');
        runAllFilters();
    }

    init();