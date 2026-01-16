import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";

// Your Actual Project Credentials
const supabase = createClient(
  "https://klbwigcvrdfeeeeotehu.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtsYndpZ2N2cmRmZWVlZW90ZWh1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg1NDA4MDgsImV4cCI6MjA4NDExNjgwOH0.gdqggXxOsl0CO0ctKfCWYzVuMrmP6TXSiYftTXDC4v8"
);

const toggle = document.getElementById("global-ai-toggle");

async function initToggle() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !toggle) return;

  // Pull existing state from your new profiles table
  const { data: profile, error } = await supabase
    .from("profiles")
    .select("global_ai_enabled")
    .eq("id", user.id)
    .single();

  if (!error) {
    toggle.checked = profile?.global_ai_enabled ?? true;
  }

  // Listen for changes and update Supabase in real-time
  toggle.addEventListener("change", async () => {
    const next = toggle.checked;
    const { error: updateError } = await supabase
      .from("profiles")
      .update({ global_ai_enabled: next })
      .eq("id", user.id);

    if (updateError) {
      toggle.checked = !next; // Revert if network fails
      console.error("Update failed:", updateError);
    }
  });
}

initToggle();
async function fetchAndDisplayLeads() {
    const container = document.getElementById('leads-container');
    
    // 1. Fetch data from the 'leads' table we created in Supabase
    const { data: leads, error } = await supabase
        .from('leads')
        .select('*, properties(nickname)') // Get lead info + the property nickname
        .order('created_at', { ascending: false });

    if (error) {
        console.error('Error fetching leads:', error);
        return;
    }

    // 2. Clear the "Loading..." text
    container.innerHTML = '';

    // 3. Handle the 'No Leads' state
    if (leads.length === 0) {
        container.innerHTML = `<p class="text-slate-400 text-sm italic">No active conversations yet. Your AI is standing by.</p>`;
        return;
    }

    // 4. THE MAP FUNCTION: Turn data into HTML cards
    leads.forEach(lead => {
        const card = document.createElement('div');
        card.className = "rounded-2xl border border-slate-200 bg-white p-5 shadow-sm";
        
        // Use logic to show a "Knowledge Gap" warning if the lead is not 'rescued'
        const statusBadge = lead.is_rescued 
            ? `<span class="text-xs text-emerald-600 bg-emerald-50 px-2 py-1 rounded-full">Rescued</span>`
            : `<span class="text-xs text-amber-600 bg-amber-50 px-2 py-1 rounded-full">Gap Detected</span>`;

        card.innerHTML = `
            <div class="flex items-center justify-between">
                <div>
                    <p class="text-sm font-semibold text-slate-900">Lead ID: ${lead.id.slice(0, 8)}...</p>
                    <p class="text-xs text-slate-400">Listing: ${lead.properties?.nickname || 'Unknown Property'}</p>
                </div>
                ${statusBadge}
            </div>
            <div class="mt-4 text-sm text-slate-600">
                <p class="font-medium text-slate-800 italic">Latest Interaction:</p>
                <p class="mt-1 line-clamp-2">${lead.conversation_history[lead.conversation_history.length - 1]?.content || 'Starting conversation...'}</p>
            </div>
        `;
        container.appendChild(card);
    });
}

// Run this when the page loads
fetchAndDisplayLeads();
