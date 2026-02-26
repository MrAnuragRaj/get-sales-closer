// auth.js — Centralized Auth Guard for GetSalesCloser

// --- CONFIGURATION ---
const SUPABASE_URL = "https://klbwigcvrdfeeeeotehu.supabase.co"; 
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtsYndpZ2N2cmRmZWVlZW90ZWh1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg1NDA4MDgsImV4cCI6MjA4NDExNjgwOH0.gdqggXxOsl0CO0ctKfCWYzVuMrmP6TXSiYftTXDC4v8";

const AUTH_CONFIG = {
    loginPage: 'login.html',
    onboardingModalId: 'setup-modal',
    authLoaderId: 'auth-loader'
};

// Singleton Client
let _authClient = null;

/**
 * Get or Initialize Supabase Client
 */
function getSupabase() {
    if (!_authClient) {
        if (!window.supabase) {
            console.error("Supabase SDK not loaded. Make sure to include the CDN script.");
            return null;
        }
        _authClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    }
    return _authClient;
}

/**
 * Hard redirect to login (clears history stack)
 */
function redirectToLogin() {
    window.location.replace(AUTH_CONFIG.loginPage);
}

/**
 * MAIN GUARD FUNCTION
 * Call this at the start of any protected page.
 */
async function requireAuth(options = {}) {
    const {
        requireProfile = true,
        requireOnboarding = true,
        onAuthenticated = () => {}
    } = options;

    try {
        const sb = getSupabase();
        if (!sb) return; // SDK missing error handled in getSupabase

        // 1. Session Check
        const { data, error } = await sb.auth.getSession();

        if (error || !data.session) {
            console.warn("No active session via auth.js");
            redirectToLogin();
            return;
        }

        const user = data.session.user;
        let profile = null;

        // 2. Profile Fetch (Optional but recommended)
        if (requireProfile) {
            const { data: profileData, error: profileError } = await sb
                .from('profiles')
                .select('*')
                .eq('id', user.id)
                .single();

            if (profileError || !profileData) {
                console.warn("Profile missing");
                redirectToLogin(); // Or handle missing profile creation
                return;
            }

            profile = profileData;

            // 3. Onboarding Enforcement
            if (requireOnboarding && !profile.onboarding_completed) {
                document.getElementById(AUTH_CONFIG.authLoaderId).style.display = 'none';
                const modal = document.getElementById(AUTH_CONFIG.onboardingModalId);
                if (modal) modal.classList.remove('hidden');
                // We stop here. User must complete onboarding form to proceed.
                return; 
            }
        }

        // 4. Session Watchdog (Handle multi-tab logout)
        sb.auth.onAuthStateChange((event) => {
            if (event === 'SIGNED_OUT') {
                redirectToLogin();
            }
        });

        // 5. Success - Remove Loader & Execute Page Logic
        const loader = document.getElementById(AUTH_CONFIG.authLoaderId);
        if (loader) loader.style.display = 'none';

        // Pass control back to the specific page
        onAuthenticated(profile, user, sb);

    } catch (err) {
        console.error('Auth Guard Failure:', err);
        redirectToLogin();
    }
}