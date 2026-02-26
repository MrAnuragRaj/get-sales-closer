import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";

// Your Actual Project Credentials
const supabase = createClient(
  "https://klbwigcvrdfeeeeotehu.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtsYndpZ2N2cmRmZWVlZW90ZWh1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg1NDA4MDgsImV4cCI6MjA4NDExNjgwOH0.gdqggXxOsl0CO0ctKfCWYzVuMrmP6TXSiYftTXDC4v8"
);

/**
 * 1. INITIALIZE USER PROFILE & UI
 * Greets the user, updates stats, and hides upgrade card for pro users
 */
async function initUserProfile() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    window.location.href = "login.html";
    return;
  }

  const { data: profile, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  if (!error && profile) {
    // Update Header UI
    document.getElementById("user-full-name").innerText = profile.full_name;
    document.getElementById("user-company").innerText = profile.company;
    document.getElementById("user-welcome").innerText = "Welcome back,";
    document.getElementById("user-initials").innerText = profile.full_name.charAt(0).toUpperCase();

    // Set Toggle State
    const toggle = document.getElementById("global-ai-toggle");
    if (toggle) toggle.checked = profile.global_ai_enabled;

    // HIDE UPGRADE CARD IF PRO
    // subscription_tier is updated by our Stripe Webhook
    const upgradeCard = document.querySelector('.rounded-2xl.border-indigo-200');
    if (profile.subscription_tier !== 'free' && upgradeCard) {
      upgradeCard.style.display = 'none';
    }
  }
}

/**
 * 2. GLOBAL AI TOGGLE LOGIC
 */
async function setupToggleListener() {
  const toggle = document.getElementById("global-ai-toggle");
  if (!toggle) return;

  toggle.addEventListener("change", async () => {
    const { data: { user } } = await supabase.auth.getUser();
    const next = toggle.checked;
    
    const { error: updateError } = await supabase
      .from("profiles")
      .update({ global_ai_enabled: next })
      .eq("id", user.id);

    if (updateError) {
      toggle.checked = !next; // Revert on UI if DB update fails
      console.error("Update failed:", updateError);
    }
  });
}

/**
 * 3. DYNAMIC LEAD FEED & STATS
 */
async function fetchAndDisplayLeads() {
  const container = document.getElementById('leads-container');
  const rescuedCounter = document.getElementById('stat-leads-rescued');
  
  const { data: leads, error } = await supabase
    .from('leads')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching leads:', error);
    return;
  }

  // Update "Leads Rescued" Stat Card
  const rescuedCount = leads.filter(l => l.is_rescued).length;
  if (rescuedCounter) rescuedCounter.innerText = rescuedCount;

  container.innerHTML = '';

  if (leads.length === 0) {
    container.innerHTML = `<p class="text-slate-400 text-sm italic">No active conversations yet. Your AI is standing by.</p>`;
    return;
  }

  leads.forEach(lead => {
    const card = document.createElement('div');
    card.className = "rounded-2xl border border-slate-200 bg-white p-5 shadow-sm";
    
    const statusBadge = lead.is_rescued 
      ? `<span class="text-xs text-emerald-600 bg-emerald-50 px-2 py-1 rounded-full">Rescued</span>`
      : `<span class="text-xs text-amber-600 bg-amber-50 px-2 py-1 rounded-full">Gap Detected</span>`;

    card.innerHTML = `
      <div class="flex items-center justify-between">
        <div>
          <p class="text-sm font-semibold text-slate-900">Lead ID: ${lead.id.slice(0, 8)}...</p>
          <p class="text-xs text-slate-400">Source: ${lead.source || 'Unknown'}</p>
        </div>
        ${statusBadge}
      </div>
      <div class="mt-4 text-sm text-slate-600">
        <p class="font-medium text-slate-800 italic">Latest Interaction:</p>
        <p class="mt-1 line-clamp-2">Last active: ${lead.last_interaction_at ? new Date(lead.last_interaction_at).toLocaleString() : 'No interactions yet'}</p>
      </div>
    `;
    container.appendChild(card);
  });
}

// EXECUTE ALL FUNCTIONS ON LOAD
initUserProfile();
setupToggleListener();
fetchAndDisplayLeads();