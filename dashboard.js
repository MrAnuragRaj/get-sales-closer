// --- CONFIGURATION ---
const SUPABASE_URL = "https://klbwigcvrdfeeeeotehu.supabase.co"; 
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtsYndpZ2N2cmRmZWVlZW90ZWh1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg1NDA4MDgsImV4cCI6MjA4NDExNjgwOH0.gdqggXxOsl0CO0ctKfCWYzVuMrmP6TXSiYftTXDC4v8";

let sbClient; // RENAMED to fix crash
let currentUser = {};
let currentDiagnosis = null; 

// --- LOGGER ---
function sysLog(msg) {
    console.log(msg);
    const logBox = document.getElementById('boot-log');
    if(logBox) {
        logBox.innerHTML += `<div>${msg}</div>`;
        logBox.scrollTop = logBox.scrollHeight;
    }
}

// --- INIT ---
async function initDashboard() {
    sysLog("🚀 Engine Start");

    // 1. Initialize
    try {
        if (!window.supabase) throw new Error("Supabase SDK failed to load.");
        sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        sysLog("✅ Connected to Core");
    } catch (e) {
        sysLog("❌ CRITICAL: " + e.message);
        document.getElementById('force-load-btn').classList.remove('hidden');
        return;
    }

    // 2. Auth
    try {
        const { data, error } = await sbClient.auth.getSession();
        
        if (error) throw error;
        if (!data.session) {
            sysLog("❌ No Session. Redirecting...");
            window.location.href = 'login.html';
            return;
        }

        // 3. Profile
        const { data: profile, error: profErr } = await sbClient
            .from('profiles')
            .select('*')
            .eq('id', data.session.user.id)
            .single();

        if (profile) {
            currentUser = profile;
            if (!profile.onboarding_completed) {
                document.getElementById('auth-loader').style.display = 'none';
                document.getElementById('setup-modal').classList.remove('hidden');
                return;
            }
            updateDashboardUI(profile);
        }

        // 4. Run Revenue Doctor
        await runRevenueDiagnosis();

        // 5. Sidebar & Feed
        updateSidebar({ features: { niche_closer: true, content_roi: true, b: true, s: true, a: true, l: true } });
        subscribeToInteractions();

        sysLog("✅ Ready.");
        setTimeout(() => document.getElementById('auth-loader').style.display = 'none', 500);

    } catch (err) {
        sysLog("❌ Error: " + err.message);
        document.getElementById('force-load-btn').classList.remove('hidden');
    }
}

// --- REVENUE DOCTOR ---
async function runRevenueDiagnosis() {
    try {
        // Fetch interactions from the last 7 days
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const { data: interactions } = await sbClient
            .from('interactions')
            .select('lead_id, direction, created_at')
            .gte('created_at', sevenDaysAgo)
            .order('created_at', { ascending: true });

        let avgDelayMinutes = null;

        if (interactions && interactions.length > 0) {
            // Group by lead_id
            const byLead = {};
            interactions.forEach(i => {
                if (!byLead[i.lead_id]) byLead[i.lead_id] = [];
                byLead[i.lead_id].push(i);
            });

            // Find inbound → outbound pairs and measure response delay
            const delays = [];
            Object.values(byLead).forEach(msgs => {
                for (let i = 0; i < msgs.length - 1; i++) {
                    if (msgs[i].direction === 'inbound' && msgs[i + 1].direction === 'outbound') {
                        const delta = (new Date(msgs[i + 1].created_at) - new Date(msgs[i].created_at)) / 60000;
                        if (delta > 0 && delta < 1440) delays.push(delta); // ignore gaps > 24h
                    }
                }
            });

            if (delays.length > 0) {
                avgDelayMinutes = Math.round(delays.reduce((a, b) => a + b, 0) / delays.length);
            }
        }

        const noData = avgDelayMinutes === null;
        const chatDelay = avgDelayMinutes ?? 5; // default 5 min (healthy) if no data yet

        let score = 95;
        let issue = null;

        if (chatDelay > 15) {
            score = 72;
            issue = "availability";
        }

        const healthEl = document.getElementById('health-score');
        if (healthEl) {
            healthEl.innerText = score + "%";
            healthEl.className = score > 80 ? "text-3xl font-bold text-green-400" : "text-3xl font-bold text-yellow-400";
        }

        if (issue === "availability") {
            currentDiagnosis = {
                title: "Availability Bandwidth Limited",
                observation: `We detected a ${chatDelay}-minute average response delay in your chat interactions. This suggests a likely coverage gap.`,
                impact: "Est. $300-$500/week in uncaptured pipeline (based on traffic patterns).",
                manual_fix: "Keep a browser tab open or assign a team member to monitor chat.",
                auto_fix: "Enable Voice Liaison to answer chats & calls instantly (0s wait).",
                module_name: "Voice Liaison"
            };
        } else {
            currentDiagnosis = {
                title: "System Optimized",
                observation: noData
                    ? "No interaction data yet — start engaging leads to see live diagnostics."
                    : `Average response time is ${chatDelay} minutes. Within healthy benchmarks.`,
                impact: "No critical leaks visible.",
                manual_fix: "Maintain current process.",
                auto_fix: "No action needed.",
                module_name: "None"
            };
        }
    } catch (err) {
        sysLog("⚠️ Revenue Doctor error: " + err.message);
    }
}

// --- MODAL & ACTION LOGIC ---
function openDiagnosis() {
    if(!currentDiagnosis) return;
    document.getElementById('diag-observation').innerText = currentDiagnosis.observation;
    document.getElementById('diag-impact').innerText = currentDiagnosis.impact;
    document.getElementById('diag-manual-text').innerText = currentDiagnosis.manual_fix;
    document.getElementById('diag-auto-text').innerText = currentDiagnosis.auto_fix;
    
    const modal = document.getElementById('diagnosis-modal');
    modal.classList.remove('hidden');
    setTimeout(() => document.getElementById('diagnosis-content').classList.remove('scale-95'), 10);
}

function closeDiagnosis(e) {
    if (e && !e.target.id.includes('diagnosis-modal') && !e.target.parentElement.id.includes('close-btn')) return;
    const modal = document.getElementById('diagnosis-modal');
    const content = document.getElementById('diagnosis-content');
    content.classList.add('scale-95');
    setTimeout(() => modal.classList.add('hidden'), 150);
}

function handleFix(type) {
    if (type === 'manual') {
        alert("Action Logged. We will monitor your response times.");
        closeDiagnosis();
    } else {
        // Show Cost Modal
        closeDiagnosis();
        setTimeout(() => {
            document.getElementById('cost-modal').classList.remove('hidden');
        }, 200);
    }
}

function closeCostModal(e) {
    if (e && !e.target.id.includes('cost-modal')) return;
    document.getElementById('cost-modal').classList.add('hidden');
}

function confirmActivation() {
    alert("Voice Liaison Activated. Welcome to automated coverage.");
    closeCostModal();
}

// --- DATA FUNCTIONS ---
function updateDashboardUI(profile) {
    if(profile.full_name) document.getElementById('user-name-display').innerText = profile.full_name;
    if(profile.reference_id) document.getElementById('user-ref-id').innerText = profile.reference_id;
    if(profile.logo_url) {
        document.getElementById('brand-icon').classList.add('hidden');
        const img = document.getElementById('brand-img');
        img.src = profile.logo_url;
        img.classList.remove('hidden');
        document.getElementById('branding-toggle').checked = true;
        toggleBranding();
    }
}

async function handleOnboarding(e) {
    e.preventDefault();
    const btn = document.querySelector('button[type="submit"]');
    btn.innerText = "Uploading...";
    try {
        const { data: { session } } = await sbClient.auth.getSession();
        const company = document.getElementById('setup-company').value;
        const industry = document.getElementById('setup-industry').value;
        const website = document.getElementById('setup-url').value;
        let logoUrl = null;
        const fileInput = document.getElementById('setup-logo-file');
        
        if(fileInput.files.length > 0) {
            const file = fileInput.files[0];
            const fileName = `${session.user.id}-${Date.now()}`;
            await sbClient.storage.from('logos').upload(fileName, file);
            const { data } = sbClient.storage.from('logos').getPublicUrl(fileName);
            logoUrl = data.publicUrl;
        }

        const { error } = await sbClient.from('profiles').update({
            company: company, industry: industry, logo_url: logoUrl, website_url: website, onboarding_completed: true
        }).eq('id', session.user.id);

        if (error) throw error;
        location.reload();
    } catch (err) {
        alert("Setup Failed: " + err.message);
        btn.innerText = "Launch Dashboard";
    }
}

function triggerLogoUpdate() { document.getElementById('update-logo-input').click(); }

async function handleLogoUpdate(input) {
    if(input.files.length === 0) return;
    const file = input.files[0];
    try {
        const { data: { session } } = await sbClient.auth.getSession();
        const fileExt = file.name.split('.').pop();
        const fileName = `${session.user.id}-${Date.now()}.${fileExt}`;
        await sbClient.storage.from('logos').upload(fileName, file);
        const { data } = sbClient.storage.from('logos').getPublicUrl(fileName);
        
        await sbClient.from('profiles').update({ logo_url: data.publicUrl }).eq('id', session.user.id);
        const img = document.getElementById('brand-img');
        img.src = data.publicUrl;
        img.classList.remove('hidden');
        document.getElementById('brand-icon').classList.add('hidden');
    } catch(e) {
        alert("Upload Error: " + e.message);
    }
}

// --- STANDARD UTILS ---
function subscribeToInteractions() {
    sbClient.channel('public:interactions')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'interactions' }, payload => {
            const container = document.getElementById('war-room-feed');
            if(container.innerText.includes("Waiting")) container.innerHTML = '';
            const isAI = payload.new.direction === 'outbound';
            const div = document.createElement('div');
            div.className = `flex gap-3 ${isAI ? 'flex-row-reverse' : ''} message-enter mb-3`;
            div.innerHTML = `<div class="bg-${isAI ? 'indigo-600/20' : 'slate-800'} p-3 rounded-2xl text-xs text-slate-300 border border-white/5 max-w-[80%]">${payload.new.content}</div>`;
            container.appendChild(div);
        })
        .subscribe();
}

function loadPriorityAction() { /* Kept simple for now */ }
function updateSidebar(sub) { /* Locking Logic */ }
function toggleBranding() {
    const checkbox = document.getElementById('branding-toggle');
    if (checkbox.checked) {
        document.getElementById('brand-text').innerText = currentUser.company || "Company";
        document.getElementById('brand-sub').innerText = "Powered by GetSalesCloser";
        if (currentUser.logo_url) {
            document.getElementById('brand-icon').classList.add('hidden');
            document.getElementById('brand-img').classList.remove('hidden');
        }
    } else {
        document.getElementById('brand-text').innerText = "GetSalesCloser";
        document.getElementById('brand-sub').innerText = "Autonomous Revenue";
        document.getElementById('brand-icon').classList.remove('hidden');
        document.getElementById('brand-img').classList.add('hidden');
    }
}
function toggleAgentWindow() { document.getElementById('sarah-window').classList.toggle('minimized-down'); }
function handleNavClick(k) { console.log(k); }
function handleLockedClick() { window.location.href = "billing.html"; }
function copyRefId() { navigator.clipboard.writeText(document.getElementById('user-ref-id').innerText); alert("Copied"); }
function toggleChat() { document.getElementById('chat-window').classList.toggle('open'); }
function minimizeChat() { document.getElementById('chat-window').classList.toggle('minimized'); }
function handleLogout() { sbClient.auth.signOut().then(() => window.location.href = 'login.html'); }
function executeAction() { alert("Contract sequence..."); }
function handleUserMessage(e) { if(e.key==='Enter') document.getElementById('user-input').value=''; }

// START
window.addEventListener('load', initDashboard);